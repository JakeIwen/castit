import assert from 'node:assert/strict';
import test from 'node:test';
import { createReceiverClient, decodeStatus } from '../../background/receiver-client.mjs';
import { decodeLibrary } from '../../playback/video-store.mjs';
import { createMessageHandler } from '../../background/actions.mjs';
import { defaultLibrary, defaultStatus, startReceiver, videoId } from './receiver-fixture.mjs';

const config = globalThis.VAN_TV_CONFIG;

test('library reads and download/delete controls round trip through the background HTTP boundary', async t => {
  const fixture = await startReceiver(t);
  const receiver = createReceiverClient({ baseUrls: ['http://127.0.0.1:1', fixture.url] });
  const handle = createMessageHandler({}, receiver);
  assert.deepEqual(await handle({ type: config.message.library }, {}), { ok: true, data: defaultLibrary });
  assert.equal(handle({ type: config.message.library }, { tab: {} }), undefined);
  await handle({ type: config.message.control, action: config.control.download }, {});
  await handle({ type: config.message.control, action: config.control.download, id: videoId }, {});
  await handle({ type: config.message.control, action: config.control.deleteSaved, id: videoId }, {});
  assert.deepEqual(fixture.requests.filter(r => r.method === 'POST').map(r => r.body), [
    { action: 'download' }, { action: 'download', id: videoId }, { action: 'delete_saved', id: videoId },
  ]);
  const count = fixture.requests.length;
  for (const action of [config.control.download, config.control.deleteSaved]) {
    await assert.rejects(receiver.control(action, { id: 'bad' }), /Invalid YouTube video/);
  }
  await assert.rejects(receiver.control(config.control.deleteSaved), /Invalid YouTube video/);
  assert.equal(fixture.requests.length, count);
});

test('status validates source, availability and download telemetry without exposing private fields', () => {
  for (const source of Object.values(config.source)) {
    for (const state of Object.values(config.downloadState)) {
      const download = { state, progress: 0.42, error: null };
      const status = decodeStatus({ ...defaultStatus, source, library: { available: true, path: '/private' },
        download: { ...download, path: '/private' } });
      assert.equal(status.source, source);
      assert.deepEqual(status.download, download);
      assert.deepEqual(status.library, { available: true });
    }
  }
  assert.equal(decodeStatus(defaultStatus).source, null);
  assert.equal(decodeStatus({ ...defaultStatus, source: 'file' }).source, null);
  assert.equal(decodeStatus({ ...defaultStatus, library: { available: 'yes' } }).library, null);
  for (const patch of [{ state: 'toString' }, { progress: -1 }, { progress: 1.1 }, { progress: NaN },
    { progress: '1' }, { error: false }, { state: undefined }]) {
    assert.equal(decodeStatus({ ...defaultStatus,
      download: { state: 'downloading', progress: null, error: null, ...patch } }).download, null);
  }
});

test('library validates all rows and strips extra receiver paths', () => {
  const library = structuredClone(defaultLibrary);
  library.path = '/private';
  library.channels[0].videos[0].path = '/private/video.mp4';
  assert.deepEqual(decodeLibrary(library), defaultLibrary);
  for (const patch of [{ available: 'yes' }, { freeBytes: -1 }, { channels: null }, { downloads: [{}] }]) {
    assert.throws(() => decodeLibrary({ ...defaultLibrary, ...patch }), /Invalid Van TV library/);
  }
  for (const patch of [{ id: 'bad' }, { title: null }, { duration: -1 }, { bytes: Infinity }, { savedAt: 'not a date' }]) {
    const invalid = structuredClone(defaultLibrary);
    Object.assign(invalid.channels[0].videos[0], patch);
    assert.throws(() => decodeLibrary(invalid), /Invalid Van TV library/);
  }
  assert.deepEqual(decodeLibrary({ available: false, freeBytes: null, channels: [], downloads: [] }),
    { available: false, freeBytes: null, channels: [], downloads: [] });
});

test('a malformed library response is not passed to the sidebar', async t => {
  const fixture = await startReceiver(t, { respond(request, response) {
    if (request.path !== '/api/library') return false;
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end('{}'); return true;
  } });
  await assert.rejects(createReceiverClient({ baseUrls: [fixture.url] }).library(), /Invalid Van TV library/);
});
