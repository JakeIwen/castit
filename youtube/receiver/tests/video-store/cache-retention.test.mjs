import test from 'node:test';
import assert from 'node:assert/strict';
import { access, readFile, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fixture, range, ID, SECOND_ID, options, finishedDownload } from './store-fixture.mjs';
import { STORE_LIMITS } from '../../src/video-store/contracts.mjs';
import { VideoStore } from '../../src/video-store/video-store.mjs';

test('Stop starts ten minutes, reload cancels it, and moving to another video restarts the grace period', async t => {
  const { store, root, clock } = await fixture(t);
  const first = new AbortController();
  const stream = await store.resolve(ID, options(first.signal));
  await range(stream.videoUrl, 0, 5);
  await clock.advance(STORE_LIMITS.retentionMs * 2);
  await access(join(root, '.cache', ID, '137.bin'));
  first.abort(); await store.release();
  await clock.advance(STORE_LIMITS.retentionMs - 1);
  await access(join(root, '.cache', ID));
  await store.resolve(ID, options());
  await clock.advance(STORE_LIMITS.retentionMs * 2);
  await access(join(root, '.cache', ID));
  await store.release();
  await store.resolve(SECOND_ID, options());
  await clock.advance(STORE_LIMITS.retentionMs);
  await assert.rejects(access(join(root, '.cache', ID)), { code: 'ENOENT' });
  await access(join(root, '.cache', SECOND_ID));
});

test('Startup sweeps stale cache but preserves a marked failed download for an explicit retry', async t => {
  const { store, disk, root, clock, resolver } = await fixture(t, { run: async () => { throw new Error('mux failed'); } });
  await store.resolve(ID, options());
  await store.release();
  await store.download(SECOND_ID);
  await finishedDownload(store, SECOND_ID);
  assert.equal((await store.list()).downloads[0].state, 'error');
  // Advancing the injected clock without firing old-process timers models a crash.
  clock.value += STORE_LIMITS.retentionMs + 1;
  const restarted = new VideoStore({ disk, resolver, now: clock.now, setTimer: clock.setTimer, clearTimer: clock.clearTimer });
  t.after(() => restarted.close());
  await restarted.initialize();
  await assert.rejects(access(join(root, '.cache', ID)), { code: 'ENOENT' });
  await access(join(root, '.cache', SECOND_ID));
  const library = await restarted.list();
  assert.equal(library.downloads[0].id, SECOND_ID);
  assert.match(library.downloads[0].error, /interrupted/);
});

test('Corrupt maps and truncation never advertise a complete local video', async t => {
  const { store, root, disk, resolver } = await fixture(t);
  const stream = await store.resolve(ID, options());
  await range(stream.videoUrl, 0, 36);
  const path = join(root, '.cache', ID);
  const metadata = JSON.parse(await readFile(join(path, 'entry.json')));
  metadata.tracks['137'].ranges = [[-1, 36]];
  await writeFile(join(path, 'entry.json'), JSON.stringify(metadata));
  const restarted = new VideoStore({ disk, resolver });
  t.after(() => restarted.close());
  assert.equal(await restarted.local(ID), null);
  metadata.tracks['137'].ranges = [[0, 36]];
  await writeFile(join(path, 'entry.json'), JSON.stringify(metadata));
  await writeFile(join(path, '137.bin'), 'truncated');
  assert.equal(await restarted.local(ID), null);
  await mkdir(join(path, 'unused'), { recursive: true });
});
