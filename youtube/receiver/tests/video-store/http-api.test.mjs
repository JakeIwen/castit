import test from 'node:test';
import assert from 'node:assert/strict';
import { createStatusServer } from '../../src/http/status-server.mjs';
import { createPlayerControls } from '../../src/controls/player-controls.mjs';
import { fixture, ID, options, finishedDownload } from './store-fixture.mjs';
import { STORE_LIMITS } from '../../src/video-store/contracts.mjs';

async function api(t, store) {
  const player = { video: { id: ID }, quality: { selected: 'auto' }, videoStore: store };
  const controls = createPlayerControls(player);
  const server = await createStatusServer({
    snapshot: () => ({ ok: true, video: player.video, position: 17, ...store.snapshot(player.video?.id) }),
    refreshStorage: () => store.refresh(), library: () => store.list(),
    pairing: { snapshot: () => ({ code: null }) }, control: (action, fields) => controls[action](fields),
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  const url = `http://127.0.0.1:${server.address().port}`;
  return { url, player, post: body => fetch(`${url}/api/control`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  }) };
}

test('Download acknowledges acceptance and current-video errors have exactly the shared status fields', async t => {
  const { store } = await fixture(t, { run: async () => { throw new Error('private subprocess output'); } });
  const { url, post } = await api(t, store);
  const response = await post({ action: 'download' });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { action: 'download', done: true });
  await finishedDownload(store, ID);
  const status = await (await fetch(`${url}/api/status`)).json();
  assert.deepEqual(Object.keys(status.download).sort(), ['error', 'progress', 'state']);
  assert.equal(status.download.state, 'error');
  assert.doesNotMatch(status.download.error, /private/);
  const library = await (await fetch(`${url}/api/library`)).json();
  assert.deepEqual(Object.keys(library.downloads[0]).sort(), ['error', 'id', 'progress', 'state', 'title']);
});

test('Status and library expose the agreed contract and download controls validate ids before I/O', async t => {
  const { store, state } = await fixture(t);
  const { url, post, player } = await api(t, store);
  let status = await (await fetch(`${url}/api/status`)).json();
  assert.equal(status.position, 17);
  assert.deepEqual({ source: status.source, download: status.download, library: status.library },
    { source: null, download: null, library: { available: true } });
  assert.deepEqual(await (await fetch(`${url}/api/library`)).json(), {
    available: true, freeBytes: state.freeBytes, channels: [], downloads: [],
  });
  for (const body of [{ action: 'download', id: '../outside' }, { action: 'download', id: null },
    { action: 'delete_saved' }, { action: 'delete_saved', id: 'invalid' }]) {
    assert.equal((await post(body)).status, 400);
  }
  assert.equal(state.resolutions.length, 0);
  const loading = new AbortController();
  await store.resolve(ID, options(loading.signal));
  status = await (await fetch(`${url}/api/status`)).json();
  assert.equal(status.source, 'web');
  assert.equal((await post({ action: 'delete_saved', id: ID })).status, 200);
  state.freeBytes = STORE_LIMITS.freeBytes - 1;
  let response = await post({ action: 'download' });
  assert.equal(response.status, 409);
  assert.match((await response.json()).error, /2 GiB/);
  state.mounted = false;
  response = await post({ action: 'download', id: ID });
  assert.equal(response.status, 503);
  assert.match((await response.json()).error, /not mounted/);
  status = await (await fetch(`${url}/api/status`)).json();
  assert.equal(status.library.available, false);
  loading.abort(); await store.release();
  player.video = null;
  status = await (await fetch(`${url}/api/status`)).json();
  assert.equal(status.source, null);
  assert.equal(status.download, null);
});
