import test from 'node:test';
import assert from 'node:assert/strict';
import { CastQueue, fetchTitle } from '../../src/queue/cast-queue.mjs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PrivateDataStore } from '../../src/storage/private-data-store.mjs';
import { PlayerStatus } from '../../src/playback/player.mjs';
import { playerFixture, settleUntil } from '../playback/player-fixture.mjs';

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

test('Supplied queue titles are immediate and skip lookup; empty titles retain best-effort lookup', async () => {
  const lookups = [];
  const queue = new CastQueue({ lookupTitle: async id => { lookups.push(id); return ' Looked  up‮ '; } });
  const supplied = queue.add('aaaaaaaaaaa', ' Sender  title\u0000 ');
  assert.equal(supplied.title, 'Sender title');
  const capped = queue.add('bbbbbbbbbbb', '𐐀'.repeat(201));
  assert.equal(capped.title, '𐐀'.repeat(200));
  const empty = queue.add('ccccccccccc', ' ‮ ');
  assert.equal(empty.title, null);
  await settleUntil(() => empty.title);
  assert.deepEqual(lookups, ['ccccccccccc']);
  assert.equal(empty.title, 'Looked up');
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

test('Played entries share queue keys, follow loaded and oEmbed titles, dedupe and clear with the queue', async () => {
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
  queue.clear(loaded);
  assert.deepEqual(queue.findPlayed(replayed.key), { key: replayed.key, id: loaded.id, title: 'mpv title' });
  assert.equal(queue.findPlayed(second.key), null);
  queue.clear();
  assert.equal(queue.findPlayed(replayed.key), null);
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

test('Queue and played history survive reopening the store, without starting playback', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'yt-cast-queue-'));
  t.after(() => rm(directory, { recursive: true }));
  const store = new PrivateDataStore(directory);
  await store.initialize();
  const queue = new CastQueue({ store, lookupTitle: async id => `Title ${id}` });
  queue.recordPlayed({ id: 'ppppppppppp', title: 'Watched' });
  queue.add('aaaaaaaaaaa');
  queue.add('bbbbbbbbbbb');
  queue.move(queue.snapshot()[1].key, 0);
  await settleUntil(() => queue.snapshot().every(entry => entry.title));
  await queue.save();

  const reopened = new PrivateDataStore(directory);
  const { player, instances } = playerFixture({ store: reopened,
    castQueue: new CastQueue({ store: reopened, lookupTitle: async () => null }) });
  t.after(() => player.endSession());
  await player.initialize();
  assert.deepEqual(player.castQueue.snapshot().map(({ id, title }) => [id, title]),
    [['bbbbbbbbbbb', 'Title bbbbbbbbbbb'], ['aaaaaaaaaaa', 'Title aaaaaaaaaaa']]);
  assert.deepEqual(player.castQueue.playedSnapshot().map(({ id, title }) => [id, title]), [['ppppppppppp', 'Watched']]);
  assert.equal(instances.length, 0);
  assert.equal(player.status, PlayerStatus.IDLE);
});

test('A corrupt or foreign saved queue restores only valid entries', async () => {
  const saved = { upcoming: [{ id: 'aaaaaaaaaaa', title: 7 }, { id: '../etc' }, null], played: 'nope' };
  const queue = new CastQueue({ store: { get: async () => saved }, log: { warn() {} } });
  await queue.load();
  assert.deepEqual(queue.snapshot().map(({ id, title }) => [id, title]), [['aaaaaaaaaaa', null]]);
  assert.deepEqual(queue.playedSnapshot(), []);
  const unreadable = new CastQueue({ store: { get: async () => { throw new Error('bad'); } }, log: { warn() {} } });
  await unreadable.load();
  assert.equal(unreadable.length, 0);
});
