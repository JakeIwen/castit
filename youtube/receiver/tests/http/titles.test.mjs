import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createStatusServer } from '../../src/http/status-server.mjs';
import { createQueueControls } from '../../src/controls/player-controls.mjs';
import { CastQueue } from '../../src/queue/cast-queue.mjs';
import { playerFixture, VIDEO, SECOND, settleUntil, quiet } from '../playback/player-fixture.mjs';

test('Cast and queue accept normalized optional titles, reject non-strings, and preserve response shapes', async t => {
  const calls = [];
  const server = await createStatusServer({ snapshot: () => ({ ok: true }), pairing: { snapshot: () => ({}) },
    cast: async (...args) => { calls.push(args); },
    queue: async (...args) => { calls.push(args); return true; },
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  for (const [path, action, status] of [['/api/cast', undefined, 202], ['/api/queue', 'add', 200]]) {
    const post = fields => fetch(`http://127.0.0.1:${server.address().port}${path}`, { method: 'POST',
      headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action, ...fields }) });
    for (const title of [null, 1, true, [], {}]) {
      const response = await post({ videoId: VIDEO.id, title });
      assert.deepEqual([response.status, await response.json()], [400, { error: 'Title must be a string' }]);
    }
    for (const [title, expected] of [[undefined, null], [' \u0000‮ ', null],
      [' ‮A\u0000  title  ', 'A title'], ['𐐀'.repeat(201), '𐐀'.repeat(200)]]) {
      for (const selection of [{ videoId: VIDEO.id }, { url: `https://youtu.be/${VIDEO.id}` }]) {
        const response = await post({ ...selection, title });
        assert.deepEqual([response.status, await response.json()], [status, action
          ? { action, done: true, message: 'Added to the Van TV queue' } : { videoId: VIDEO.id, position: 0 }]);
        assert.deepEqual(calls.at(-1), action ? ['add', { videoId: VIDEO.id, ...(expected ? { title: expected } : {}) }]
          : [VIDEO.id, 0, ...(expected ? [expected] : [])]);
      }
    }
  }
  assert.equal(calls.length, 16);
});

test('Queue HTTP titles appear immediately in an idle load and in upcoming entries without oEmbed', async t => {
  const lookups = [];
  const castQueue = new CastQueue({ lookupTitle: async id => { lookups.push(id); return 'Lookup'; } });
  const { player } = playerFixture({ castQueue, resolver: { resolve: (_id, { signal }) =>
    new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true })) } });
  t.after(() => player.endSession());
  const queue = createQueueControls(player, { log: quiet });
  const server = await createStatusServer({ snapshot: () => ({ ok: true, video: player.video, queue: castQueue.snapshot() }),
    pairing: { snapshot: () => ({}) }, queue: (action, fields) => queue[action](fields) });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  const base = `http://127.0.0.1:${server.address().port}`;
  for (const [id, title] of [[VIDEO.id, 'Playing title'], [SECOND.id, 'Next title']]) {
    const response = await fetch(`${base}/api/queue`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'add', videoId: id, title }) });
    assert.equal(response.status, 200);
    await settleUntil(() => player.video);
  }
  const state = await (await fetch(`${base}/api/status`)).json();
  assert.deepEqual(state.video, { id: VIDEO.id, title: 'Playing title' });
  assert.equal(state.queue[0].title, 'Next title');
  assert.deepEqual(lookups, []);
});
