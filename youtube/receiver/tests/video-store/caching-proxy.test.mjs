import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, access, readdir, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { fixture, range, ID, options } from './store-fixture.mjs';
import { STORE_LIMITS, SOURCES } from '../../src/video-store/contracts.mjs';
import { VideoStore } from '../../src/video-store/video-store.mjs';

test('Ranges are cached on disk, overlaps fetch only gaps, and complete replay never resolves', async t => {
  const { store, resources, state } = await fixture(t);
  const abort = new AbortController();
  const stream = await store.resolve(ID, options(abort.signal));
  assert.match(stream.videoUrl, /^http:\/\/127\.0\.0\.1:/);
  assert.equal(store.snapshot(ID).source, SOURCES.WEB);
  assert.deepEqual(await range(stream.videoUrl, 5, 15), resources.video.subarray(5, 15));
  assert.deepEqual(await range(stream.videoUrl, 10, 20), resources.video.subarray(10, 20));
  assert.deepEqual(state.requests.map(({ start, end }) => [start, end]), [[5, 15], [15, 20]]);
  assert.deepEqual(await range(stream.videoUrl, 5, 20), resources.video.subarray(5, 20));
  assert.equal(state.requests.length, 2);
  assert.deepEqual(Buffer.from(await (await fetch(stream.videoUrl)).arrayBuffer()), resources.video);
  assert.deepEqual(state.requests.map(({ start, end }) => [start, end]), [[5, 15], [15, 20], [0, 5], [20, 36]]);
  abort.abort();
  await store.release();
  const local = await store.resolve(ID, options());
  assert.equal(local.source, SOURCES.CACHE);
  assert.deepEqual(await readFile(local.videoUrl), resources.video);
  assert.equal(state.resolutions.length, 1);
  assert.equal(state.requests.length, 4);
});

test('Concurrent overlapping ranges share bytes and large requests never exceed the 10 MiB upstream cap', async t => {
  const buffer = Buffer.alloc(STORE_LIMITS.chunkBytes + 123, 123);
  const { store, state } = await fixture(t, { resources: { video: buffer } });
  const stream = await store.resolve(ID, options());
  const responses = await Promise.all([range(stream.videoUrl, 0, buffer.length), range(stream.videoUrl, 200, buffer.length)]);
  assert.deepEqual(responses, [buffer, buffer.subarray(200)]);
  assert.equal(state.requests.reduce((sum, item) => sum + item.end - item.start, 0), buffer.length);
  assert.ok(state.requests.every(item => item.end - item.start <= STORE_LIMITS.chunkBytes));
});

test('Unknown sizes are learned through one cached byte and HTTP supports HEAD, suffix and invalid ranges', async t => {
  const { store, state, resources } = await fixture(t, { unknownSize: true });
  const stream = await store.resolve(ID, options());
  const head = await fetch(stream.videoUrl, { method: 'HEAD' });
  assert.equal(head.headers.get('content-length'), String(resources.video.length));
  assert.equal(await head.text(), '');
  const suffix = await fetch(stream.videoUrl, { headers: { Range: 'bytes=-5' } });
  assert.deepEqual(Buffer.from(await suffix.arrayBuffer()), resources.video.subarray(-5));
  for (const header of ['bytes=100-200', 'bytes=5-3', 'bytes=0-2,6-8', 'nonsense']) {
    assert.equal((await fetch(stream.videoUrl, { headers: { Range: header } })).status, 416);
  }
  assert.deepEqual(state.requests.map(({ start, end }) => [start, end]), [[0, 1], [31, 36]]);
});

test('Expired URLs re-resolve fresh, preserving cached bytes and upstream headers', async t => {
  const { store, state, resources } = await fixture(t);
  const stream = await store.resolve(ID, options());
  await range(stream.videoUrl, 0, 10);
  state.expired = true;
  assert.deepEqual(await range(stream.videoUrl, 5, 20), resources.video.subarray(5, 20));
  assert.equal(state.resolutions.length, 2);
  assert.equal(state.resolutions[1].fresh, true);
  assert.deepEqual(state.requests.map(({ start, end }) => [start, end]), [[0, 10], [10, 20]]);
  assert.equal(state.requests[1].headers['user-agent'], 'Cache fixture');
});

test('Absent mount and low space create no directories, preserve direct streaming and refuse downloads clearly', async t => {
  const { store, root, state } = await fixture(t);
  state.mounted = false;
  await store.initialize();
  const direct = await store.resolve(ID, options());
  assert.match(direct.videoUrl, /\/video$/);
  await assert.rejects(access(root), { code: 'ENOENT' });
  assert.deepEqual(await store.list(), { available: false, freeBytes: null, channels: [], downloads: [] });
  await assert.rejects(store.download(ID), /not mounted/);
  state.mounted = true;
  state.freeBytes = STORE_LIMITS.freeBytes - 1;
  assert.match((await store.resolve(ID, options())).videoUrl, /\/video$/);
  await assert.rejects(access(root), { code: 'ENOENT' });
  await assert.rejects(store.download(ID), /2 GiB/);
});

test('Cache metadata survives reopening, quality formats stay separate and symlinks never redirect writes', async t => {
  const { store, disk, root, directory, resources, resolver, state, clock } = await fixture(t);
  const abort = new AbortController();
  const stream = await store.resolve(ID, options(abort.signal));
  await range(stream.videoUrl, 0, resources.video.length);
  abort.abort(); await store.release();
  const reopened = new VideoStore({ disk, resolver, now: clock.now, setTimer: clock.setTimer, clearTimer: clock.clearTimer });
  t.after(() => reopened.close());
  assert.equal((await reopened.resolve(ID, options())).source, SOURCES.CACHE);
  assert.equal(state.resolutions.length, 1);
  assert.equal((await reopened.resolve(ID, { quality: '720' })).source, undefined);
  assert.equal(state.resolutions.length, 2);
  const files = await readdir(join(root, '.cache', ID));
  assert.ok(files.includes('137.bin'));
  assert.ok(!files.includes('136.bin'), 'an untouched track has metadata, not an open file');
  await symlink(directory, join(root, 'escaped'));
  await assert.rejects(disk.directory(join(root, 'escaped', 'elsewhere')), /Symlink/);
});
