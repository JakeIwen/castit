import test from 'node:test';
import assert from 'node:assert/strict';
import { CastQueue, fetchTitle } from '../../src/queue/cast-queue.mjs';
import { settleUntil } from '../playback/player-fixture.mjs';

test('Cast queue keeps order, looks up titles, caps its length and takes by key', async () => {
  const queue = new CastQueue({ lookupTitle: async id => (id === 'aaaaaaaaaaa' ? 'A' : Promise.reject(new Error('down'))), limit: 2 });
  const first = queue.add('aaaaaaaaaaa');
  const second = queue.add('bbbbbbbbbbb');
  assert.equal(queue.add('ccccccccccc'), null);
  assert.equal(queue.add('bad id'), null);
  await settleUntil(() => queue.snapshot()[0].title === 'A');
  assert.deepEqual(queue.snapshot(), [{ key: first.key, id: 'aaaaaaaaaaa', title: 'A' }, { key: second.key, id: 'bbbbbbbbbbb', title: null }]);
  assert.equal(queue.take(second.key).id, 'bbbbbbbbbbb');
  assert.equal(queue.take(second.key), null);
  assert.equal(queue.take().id, 'aaaaaaaaaaa');
  assert.equal(queue.take(), null);
});

test('Title lookup asks YouTube oEmbed for the watch URL and tolerates failures', async () => {
  const requested = [];
  const fetcher = async url => { requested.push(String(url)); return { ok: true, json: async () => ({ title: 'x'.repeat(300) }) }; };
  assert.equal(await fetchTitle('dQw4w9WgXcQ', { fetcher }), 'x'.repeat(200));
  assert.match(requested[0], /^https:\/\/www\.youtube\.com\/oembed\?url=https%3A%2F%2Fwww\.youtube\.com%2Fwatch%3Fv%3DdQw4w9WgXcQ&format=json$/);
  assert.equal(await fetchTitle('dQw4w9WgXcQ', { fetcher: async () => ({ ok: false }) }), null);
});
