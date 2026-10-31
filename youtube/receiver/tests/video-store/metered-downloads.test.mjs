import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { runCommand } from '../../src/host/process-command.mjs';
import { METERED_CONSUMERS } from '../../src/host/metered-permissions.mjs';
import { STORE_LIMITS } from '../../src/video-store/contracts.mjs';
import { fixture, ID, finishedDownload } from './store-fixture.mjs';
import { settleUntil } from '../playback/player-fixture.mjs';

const ffmpeg = process.platform === 'darwin' ? '/opt/homebrew/bin/ffmpeg' : '/usr/bin/ffmpeg';

test('A held save retains one pending request, checks every thirty seconds and resumes without another click', async t => {
  let permitted = false;
  const checks = [];
  const retries = [];
  const resources = { video: Buffer.alloc(1) };
  const { store, state, directory } = await fixture(t, { resources,
    permissions: { allows: async consumer => { checks.push(consumer); return permitted; } },
    downloadWait: (ms, signal) => new Promise((resolve, reject) => {
      assert.equal(ms, STORE_LIMITS.saveRetryMs);
      const abort = () => reject(signal.reason);
      signal.addEventListener('abort', abort, { once: true });
      retries.push(() => { signal.removeEventListener('abort', abort); resolve(); });
    }),
  });
  const media = join(directory, 'media.mp4');
  await runCommand([ffmpeg, '-nostdin', '-loglevel', 'error', '-f', 'lavfi', '-i', 'color=size=64x64:rate=10',
    '-f', 'lavfi', '-i', 'sine=frequency=440', '-t', '1', '-c:v', 'libx264', '-c:a', 'aac', media]);
  resources.video = await readFile(media);
  assert.equal(await store.download(ID), true);
  await settleUntil(() => retries.length === 1);
  const held = (await store.list()).downloads[0];
  assert.deepEqual(held, { id: ID, title: ID, state: 'waiting', progress: null,
    error: 'Waiting for metered connection permission' });
  assert.equal(store.snapshot(ID).download.state, 'waiting');
  assert.equal(state.resolutions.length, 0, 'permission comes before extraction');
  assert.equal(state.requests.length, 0, 'a held save fetches no track bytes');
  assert.equal(await store.download(ID), true, 'repeated requests coalesce while held');
  retries[0]();
  await settleUntil(() => retries.length === 2);
  assert.equal((await store.list()).downloads.length, 1);
  assert.equal(store.snapshot(ID).download.state, 'waiting', 'repeated denial never becomes an error');
  permitted = true;
  retries[1]();
  const result = await finishedDownload(store, ID);
  assert.equal(result.state, 'saved', result.error);
  assert.equal(result.error, null);
  assert.equal(result.progress, 1);
  assert.equal(state.resolutions.length, 1);
  assert.ok(state.requests.length > 0);
  assert.deepEqual(checks, Array(3).fill(METERED_CONSUMERS.SAVES));
});

test('Closing the store interrupts a real permission-retry wait instead of hanging shutdown', async t => {
  const { store, state } = await fixture(t, { permissions: { allows: async () => false } });
  await store.download(ID);
  await settleUntil(() => store.snapshot(ID).download?.error === 'Waiting for metered connection permission');
  await store.close();
  assert.equal(state.resolutions.length, 0);
  assert.equal(state.requests.length, 0);
});
