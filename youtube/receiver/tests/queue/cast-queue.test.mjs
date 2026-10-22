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

test('Cast queue moves to the final index, clamps large indices and rejects missing or played keys', () => {
  const queue = new CastQueue({ lookupTitle: async () => null });
  const a = queue.add('aaaaaaaaaaa');
  const b = queue.add('bbbbbbbbbbb');
  const c = queue.add('ccccccccccc');
  const d = queue.add('ddddddddddd');
  assert.equal(queue.move(a.key, 2), true);
  assert.deepEqual(queue.snapshot().map(entry => entry.key), [b.key, c.key, a.key, d.key]);
  assert.equal(queue.move(d.key, 0), true);
  assert.deepEqual(queue.snapshot().map(entry => entry.key), [d.key, b.key, c.key, a.key]);
  assert.equal(queue.move(d.key, Number.MAX_SAFE_INTEGER), true);
  assert.deepEqual(queue.snapshot().map(entry => entry.key), [b.key, c.key, a.key, d.key]);
  assert.equal(queue.move(b.key, 0), true);
  const played = queue.recordPlayed(queue.take(a.key));
  for (const key of [a.key, played.key, 999, undefined]) assert.equal(queue.move(key, 0), false);
  for (const index of [-1, 1.5, '1', null, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
    assert.equal(queue.move(b.key, index), false);
  }
  assert.deepEqual(queue.snapshot().map(entry => entry.key), [b.key, c.key, d.key]);
  queue.clear();
  assert.equal(queue.move(b.key, 0), false);
});

test('Played entries share queue keys, follow loaded and oEmbed titles, dedupe and survive clear', async () => {
  let supplyTitle;
  const queue = new CastQueue({ lookupTitle: () => new Promise(resolve => { supplyTitle = resolve; }) });
  const upcoming = queue.add('aaaaaaaaaaa');
  const loaded = { id: upcoming.id, title: upcoming.id };
  const first = queue.recordPlayed(loaded, queue.take(upcoming.key));
  assert.equal(first.title, null);
  assert.notEqual(first.key, upcoming.key);
  assert.deepEqual(queue.playedSnapshot(loaded), []);
  await settleUntil(() => supplyTitle);
  supplyTitle('oEmbed title');
  await settleUntil(() => queue.playedSnapshot()[0].title === 'oEmbed title');
  loaded.title = 'mpv title';
  assert.equal(queue.playedSnapshot()[0].title, 'mpv title');
  const second = queue.recordPlayed({ id: 'bbbbbbbbbbb', title: 'B' });
  const replayed = queue.recordPlayed(loaded);
  assert.deepEqual(queue.playedSnapshot().map(entry => entry.key), [second.key, replayed.key]);
  assert.equal(queue.findPlayed(first.key), null);
  assert.equal(queue.findPlayed(replayed.key, loaded), null);
  queue.clear();
  assert.deepEqual(queue.findPlayed(replayed.key), { key: replayed.key, id: loaded.id, title: 'mpv title' });
  assert.ok(queue.add('ccccccccccc').key > replayed.key);
  assert.equal(queue.recordPlayed({ id: 'bad' }), null);
});

test('Title lookup asks YouTube oEmbed for the watch URL and tolerates failures', async () => {
  const requested = [];
  const fetcher = async url => { requested.push(String(url)); return { ok: true, json: async () => ({ title: 'x'.repeat(300) }) }; };
  assert.equal(await fetchTitle('dQw4w9WgXcQ', { fetcher }), 'x'.repeat(200));
  assert.match(requested[0], /^https:\/\/www\.youtube\.com\/oembed\?url=https%3A%2F%2Fwww\.youtube\.com%2Fwatch%3Fv%3DdQw4w9WgXcQ&format=json$/);
  assert.equal(await fetchTitle('dQw4w9WgXcQ', { fetcher: async () => ({ ok: false }) }), null);
});
