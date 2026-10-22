import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PrivateDataStore } from '../../src/storage/private-data-store.mjs';
import { PlayerStatus } from '../../src/playback/player.mjs';
import { playerFixture, FakeMpv, VIDEO, SECOND, settleUntil } from './player-fixture.mjs';

test('Public player API reports loading/play/pause/resume/seek/volume/stop', async t => {
  const { player, instances, events } = playerFixture();
  t.after(() => player.endSession());
  assert.equal(await player.play(VIDEO, 12), true);
  assert.deepEqual(events.slice(0, 2), [PlayerStatus.LOADING, PlayerStatus.PLAYING]);
  assert.deepEqual(instances[0].loaded, { id: VIDEO.id, position: 12 });
  instances[0].property('duration', 120);
  instances[0].property('time-pos', 15);
  assert.equal(await player.getDuration(), 120);
  assert.equal(await player.getPosition(), 15);
  assert.equal(await player.pause(), true);
  assert.equal(player.status, PlayerStatus.PAUSED);
  assert.equal(await player.resume(), true);
  assert.equal(await player.seek(40), true);
  assert.equal(await player.getPosition(), 40);
  assert.equal(await player.setVolume({ level: 34, muted: true }), true);
  assert.deepEqual(await player.getVolume(), { level: 34, muted: true });
  await player.stop();
  assert.equal(player.status, PlayerStatus.STOPPED);
  assert.equal(instances[0].closed, true);
  assert.equal(player.video, null);
  assert.ok(instances[0].commands.some(command => command[0] === 'seek' && command[1] === 40));
});

test('Playback works with the default null room and video-library integrations', async t => {
  const { player, instances } = playerFixture({ room: undefined, handoff: undefined });
  t.after(() => player.endSession());
  assert.equal(await player.play(VIDEO, 12), true);
  assert.equal(player.status, PlayerStatus.PLAYING);
  assert.deepEqual(instances[0].loaded, { id: VIDEO.id, position: 12 });
  await player.stop();
  assert.equal(instances[0].closed, true);
  assert.equal(await player.play(SECOND), true);
  assert.deepEqual(instances[1].loaded, { id: SECOND.id, position: 0 });
});

test('Natural EOF advances the real receiver queue, then closes mpv at queue end', async t => {
  const { player, instances } = playerFixture();
  t.after(() => player.endSession());
  await player.queue.updateByMessage({ name: 'setPlaylist', payload: {
    listId: 'queue', videoIds: `${VIDEO.id},${SECOND.id}`, videoId: VIDEO.id, currentIndex: '0',
  } }, VIDEO.client);
  await player.play(VIDEO);
  await settleUntil(() => !player.queue.isUpdating);
  instances[0].emit('event', { event: 'end-file', reason: 'eof' });
  await settleUntil(() => player.video?.id === SECOND.id && player.status === PlayerStatus.PLAYING);
  assert.equal(instances[0].closed, true);
  await settleUntil(() => !player.queue.isUpdating);
  instances[1].emit('event', { event: 'end-file', reason: 'eof' });
  await settleUntil(() => player.status === PlayerStatus.STOPPED);
  assert.equal(instances[1].closed, true);
});

test('External mpv pause/volume and SponsorBlock seeks reach phone state', async t => {
  const { player, instances } = playerFixture({ segments: async () => [[10, 20]] });
  t.after(() => player.endSession());
  await player.play(VIDEO);
  instances[0].property('time-pos', 12);
  await settleUntil(() => player.position === 20);
  instances[0].property('pause', true);
  await settleUntil(() => player.status === PlayerStatus.PAUSED);
  instances[0].property('volume', 23);
  assert.equal((await player.getVolume()).level, 23);
});

test('Stop cancels a pending load, closes the process and never reports playing', async () => {
  let loading;
  const started = new Promise(resolve => { loading = resolve; });
  class SlowMpv extends FakeMpv {
    async load(_id, _position, signal) {
      loading();
      return new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(new Error('cancelled')), { once: true }));
    }
  }
  const mpv = new SlowMpv();
  const { player, events } = playerFixture({ createMpv: () => mpv });
  const play = player.play(VIDEO);
  await started;
  await player.stop();
  assert.equal(await play, false);
  assert.equal(mpv.closed, true);
  assert.equal(events.includes(PlayerStatus.PLAYING), false);
});

test('Rapid replacement cancels old preparation; old completion cannot overwrite new state', async t => {
  let preparing;
  const started = new Promise(resolve => { preparing = resolve; });
  let first = true;
  const { player } = playerFixture({ handoff: async ({ signal }) => {
    if (!first) return;
    first = false;
    preparing();
    await new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(new Error('cancelled')), { once: true }));
  } });
  t.after(() => player.endSession());
  const old = player.play(VIDEO);
  await started;
  const replacement = player.play(SECOND);
  assert.equal(await old, false);
  assert.equal(await replacement, true);
  assert.equal(player.status, PlayerStatus.PLAYING);
  assert.equal(player.video.id, SECOND.id);
});

test('Persisted volume survives mpv initial property observations', async t => {
  class ObservedMpv extends FakeMpv {
    async command(command) {
      await super.command(command);
      if (command[0] === 'observe_property' && command[2] === 'volume') this.property('volume', 100);
      if (command[0] === 'observe_property' && command[2] === 'mute') this.property('mute', false);
    }
  }
  const mpv = new ObservedMpv();
  const { player } = playerFixture({ createMpv: () => mpv,
    store: { get: async () => ({ volume: { level: 24, muted: true } }) },
  });
  t.after(() => player.endSession());
  await player.initialize();
  await player.play(VIDEO);
  assert.deepEqual(await player.getVolume(), { level: 24, muted: true });
  assert.ok(mpv.commands.some(command => command[1] === 'volume' && command[2] === 24));
});

test('Audio delay defaults safely and normalizes persisted seconds', async t => {
  const cases = [[undefined, 0], [null, 0], ['0.12', 0], [false, 0], [{}, 0], [[], 0],
    [NaN, 0], [Infinity, 0], [-Infinity, 0], [0, 0], [0.126, 0.13], [-0.126, -0.13],
    [0.004, 0], [-0.004, 0], [1.5, 1], [-1.5, -1]];
  for (const [audioDelay, expected] of cases) {
    const { player } = playerFixture({ store: { get: async () => ({ audioDelay }) } });
    t.after(() => player.endSession());
    assert.equal(player.audioDelay, 0);
    await player.initialize();
    assert.equal(player.audioDelay, expected, String(audioDelay));
    assert.deepEqual(await player.getVolume(), { level: 70, muted: false });
  }
  const { player } = playerFixture();
  await player.initialize();
  assert.equal(player.audioDelay, 0);
});

test('Audio delay updates round and clamp, rejecting non-finite or non-number input', async t => {
  const { player } = playerFixture();
  t.after(() => player.endSession());
  for (const [delay, expected] of [[0.126, 0.13], [-0.126, -0.13], [2, 1], [-2, -1],
    [Number.MAX_VALUE, 1], [-Number.MAX_VALUE, -1], [-0.001, 0], [0.1 + 0.2, 0.3]]) {
    assert.equal(await player.setAudioDelay(delay), true);
    assert.equal(player.audioDelay, expected);
  }
  for (const invalid of [undefined, null, '0.1', false, {}, [], NaN, Infinity, -Infinity]) {
    assert.equal(await player.setAudioDelay(invalid), false);
    assert.equal(player.audioDelay, 0.3);
  }
});

test('Audio delay applies before each load and live without replacing playback', async t => {
  const { player, instances } = playerFixture({ store: { get: async () => ({ audioDelay: 0.12 }), set: async () => {} } });
  t.after(() => player.endSession());
  await player.initialize();
  await player.play(VIDEO, 12);
  assert.equal(instances[0].propertiesAtLoad.get('audio-delay'), 0.12);
  assert.equal(await player.setAudioDelay(-0.184), true);
  assert.deepEqual(instances[0].commands.at(-1), ['set_property', 'audio-delay', -0.18]);
  assert.equal(instances.length, 1);
  assert.equal(player.status, PlayerStatus.PLAYING);
  assert.equal(await player.getPosition(), 12);
  await player.play(SECOND);
  assert.equal(instances[0].closed, true);
  assert.equal(instances[1].propertiesAtLoad.get('audio-delay'), -0.18);
  await player.pause();
  assert.equal(await player.setAudioDelay(0), true);
  assert.equal(instances[1].properties.get('audio-delay'), 0);
  assert.equal(player.status, PlayerStatus.PAUSED);
});

test('Idle and concurrent settings writes preserve volume, audio delay and speed across reopening', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'yt-player-settings-'));
  t.after(() => rm(directory, { recursive: true }));
  const store = new PrivateDataStore(directory);
  await store.initialize();
  const volume = { level: 24, muted: true };
  await store.set('settings', { volume });
  const { player, instances } = playerFixture({ store });
  t.after(() => player.endSession());
  await player.initialize();
  assert.equal(player.audioDelay, 0);
  assert.equal(await player.setAudioDelay(0.176), true);
  assert.equal(instances.length, 0);
  assert.deepEqual(await store.get('settings'), { volume, audioDelay: 0.18, speed: 1 });
  await player.setVolume({ level: 36, muted: false });
  assert.deepEqual(await store.get('settings'), { volume: { level: 36, muted: false }, audioDelay: 0.18, speed: 1 });
  await player.play(VIDEO);
  assert.deepEqual(await Promise.all([
    player.setVolume({ level: 42, muted: true }), player.setAudioDelay(-0.15), player.setSpeed(1.5),
  ]), [true, true, true]);
  assert.equal(instances[0].properties.get('speed'), 1.5);
  const reopened = new PrivateDataStore(directory);
  assert.deepEqual(await reopened.get('settings'),
    { volume: { level: 42, muted: true }, audioDelay: -0.15, speed: 1.5 });
  const restored = playerFixture({ store: reopened });
  t.after(() => restored.player.endSession());
  await restored.player.initialize();
  assert.deepEqual(await restored.player.getVolume(), { level: 42, muted: true });
  assert.equal(restored.player.audioDelay, -0.15);
  await restored.player.play(SECOND);
  assert.equal(restored.instances[0].propertiesAtLoad.get('audio-delay'), -0.15);
  assert.equal(restored.instances[0].propertiesAtLoad.get('speed'), 1.5);
});

test('Speed clamps to 0.25-3x, rounds to hundredths and falls back to 1x', async t => {
  const { player } = playerFixture({ store: { get: async () => ({ speed: 'fast' }), set: async () => {} } });
  t.after(() => player.endSession());
  await player.initialize();
  assert.equal(player.speed, 1);
  for (const [speed, expected] of [[1.333, 1.33], [0.1, 0.25], [9, 3], [2, 2]]) {
    assert.equal(await player.setSpeed(speed), true);
    assert.equal(player.speed, expected);
  }
  assert.equal(await player.setSpeed(NaN), false);
  assert.equal(player.speed, 2);
});

test('At the end of a video the cast queue plays next, then playback stops', async t => {
  const titles = new Map([['0123456789a', 'Second video']]);
  const { player, instances } = playerFixture();
  player.castQueue.lookupTitle = async id => titles.get(id) ?? null;
  t.after(() => player.endSession());
  // A video the fake phone queue has nothing after.
  await player.play({ id: 'zzzzzzzzzzz', client: VIDEO.client });
  player.castQueue.add(SECOND.id);
  await settleUntil(() => player.castQueue.snapshot()[0].title === 'Second video');
  instances[0].emit('event', { event: 'end-file', reason: 'eof' });
  await settleUntil(() => instances[1]?.loaded);
  assert.deepEqual(instances[1].loaded, { id: SECOND.id, position: 0 });
  assert.equal(player.video.title, 'Second video');
  assert.equal(player.castQueue.length, 0);
  instances[1].emit('event', { event: 'end-file', reason: 'eof' });
  await settleUntil(() => player.status === PlayerStatus.STOPPED);
});

test('Played history records direct, phone-next and cast-queue starts and survives stopping or disconnecting', async t => {
  const { player, instances } = playerFixture();
  t.after(() => player.endSession());
  const played = () => player.castQueue.playedSnapshot(player.video);
  await player.queue.updateByMessage({ name: 'setPlaylist', payload: {
    listId: 'queue', videoIds: `${VIDEO.id},${SECOND.id}`, videoId: VIDEO.id, currentIndex: '0',
  } }, VIDEO.client);
  await player.play(VIDEO, 12);
  assert.deepEqual(played(), []);
  instances[0].property('media-title', 'First title');
  await settleUntil(() => !player.queue.isUpdating);
  assert.equal(await player.playNext(), true);
  assert.deepEqual(played().map(({ id, title }) => ({ id, title })), [{ id: VIDEO.id, title: 'First title' }]);
  const queued = player.castQueue.add('zzzzzzzzzzz');
  await settleUntil(() => !player.queue.isUpdating);
  assert.equal(await player.playNext(), true);
  assert.deepEqual(instances[2].loaded, { id: queued.id, position: 0 });
  assert.deepEqual(played().map(entry => entry.id), [VIDEO.id, SECOND.id]);
  assert.equal(played()[1].title, null);
  instances[2].property('media-title', 'Last title');
  await player.stop();
  const history = played();
  assert.deepEqual(history.map(entry => entry.id), [VIDEO.id, SECOND.id, queued.id]);
  assert.equal(history[2].title, 'Last title');
  assert.equal(new Set([...history.map(entry => entry.key), queued.key]).size, 4);
  player.castQueue.add(VIDEO.id);
  player.castQueue.clear();
  assert.deepEqual(played(), history);
  await player.endSession();
  assert.deepEqual(played(), history);
});

test('Played history retains the latest 20 previous videos, dedupes and moves repeats to the end', async t => {
  const { player } = playerFixture();
  t.after(() => player.endSession());
  const ids = Array.from({ length: 23 }, (_, index) => String(index).padStart(11, '0'));
  for (const id of ids) assert.equal(await player.play({ id, client: VIDEO.client }), true);
  const played = () => player.castQueue.playedSnapshot(player.video);
  assert.deepEqual(played().map(entry => entry.id), ids.slice(2, -1));
  const previous = played().find(entry => entry.id === ids[5]);
  assert.equal(await player.playQueued(previous.key), true);
  assert.deepEqual(played().map(entry => entry.id), ids.slice(2).filter(id => id !== previous.id));
  assert.equal(await player.playQueued(previous.key), false);
  await player.stop();
  const history = played();
  assert.equal(history.length, 20);
  assert.equal(new Set(history.map(entry => entry.id)).size, 20);
  assert.equal(history.at(-1).id, previous.id);
  assert.ok(history.at(-1).key > previous.key);
  assert.deepEqual(playerFixture().player.castQueue.playedSnapshot(), []);
});

test('Replaying a played key starts at zero and keeps its history entry until a successful start', async t => {
  let finishLoad;
  class DeferredMpv extends FakeMpv {
    async load(id, position, signal) {
      if (id === VIDEO.id) await new Promise(resolve => { finishLoad = resolve; });
      await super.load(id, position, signal);
    }
  }
  const instances = [];
  const { player } = playerFixture({ createMpv: () => {
    const mpv = instances.length < 2 ? new FakeMpv() : new DeferredMpv();
    instances.push(mpv);
    return mpv;
  } });
  t.after(() => player.endSession());
  await player.play(VIDEO, 35);
  instances[0].property('media-title', 'Original title');
  await player.play(SECOND);
  const [previous] = player.castQueue.playedSnapshot(player.video);
  const upcoming = player.castQueue.add('zzzzzzzzzzz');
  const replay = player.playQueued(previous.key);
  await settleUntil(() => finishLoad);
  assert.equal(player.status, PlayerStatus.LOADING);
  assert.deepEqual(player.castQueue.findPlayed(previous.key), previous);
  finishLoad();
  assert.equal(await replay, true);
  assert.deepEqual(instances[2].loaded, { id: VIDEO.id, position: 0 });
  assert.equal(player.castQueue.findPlayed(previous.key), null);
  assert.deepEqual(player.castQueue.snapshot().map(entry => entry.key), [upcoming.key]);
  assert.equal(await player.playQueued(9999), false);
  assert.equal(instances.length, 3);
  instances[2].property('media-title', 'Replay title');
  await player.stop();
  assert.deepEqual(player.castQueue.playedSnapshot().map(({ id, title }) => ({ id, title })),
    [{ id: SECOND.id, title: null }, { id: VIDEO.id, title: 'Replay title' }]);
});

test('Queued playback history follows a late oEmbed title until mpv supplies the loaded title', async t => {
  let supplyTitle;
  const { player, instances } = playerFixture();
  t.after(() => player.endSession());
  player.castQueue.lookupTitle = () => new Promise(resolve => { supplyTitle = resolve; });
  const queued = player.castQueue.add(VIDEO.id);
  assert.equal(await player.playQueued(queued.key), true);
  assert.deepEqual(player.castQueue.playedSnapshot(player.video), []);
  assert.equal(player.castQueue.playedSnapshot()[0].title, null);
  supplyTitle('Late oEmbed title');
  await settleUntil(() => player.castQueue.playedSnapshot()[0].title === 'Late oEmbed title');
  instances[0].property('media-title', 'Loaded mpv title');
  await player.stop();
  assert.equal(player.castQueue.playedSnapshot()[0].title, 'Loaded mpv title');
});

test('Failed and cancelled loads do not enter played history, including a failed replay', async t => {
  let fail = false;
  const { player } = playerFixture({ createMpv: () => {
    const mpv = new FakeMpv();
    if (fail) mpv.load = async () => { throw new Error('load failed'); };
    return mpv;
  } });
  t.after(() => player.endSession());
  const cancelled = player.play(VIDEO);
  const successful = player.play(SECOND);
  assert.equal(await cancelled, false);
  assert.equal(await successful, true);
  await player.stop();
  const history = player.castQueue.playedSnapshot();
  assert.deepEqual(history.map(entry => entry.id), [SECOND.id]);
  fail = true;
  assert.equal(await player.play(VIDEO), false);
  assert.deepEqual(player.castQueue.playedSnapshot(), history);
  assert.equal(await player.playQueued(history[0].key), false);
  assert.deepEqual(player.castQueue.playedSnapshot(), history);
});

test('Playback errors and bad video IDs leave no player window', async () => {
  const mpv = new FakeMpv();
  mpv.load = async () => { throw new Error('yt-dlp failed'); };
  const { player, events } = playerFixture({ createMpv: () => mpv });
  assert.equal(await player.play({ id: '--unsafe' }), false);
  assert.equal(await player.play(VIDEO), false);
  assert.equal(mpv.closed, true);
  assert.equal(player.status, PlayerStatus.STOPPED);
  assert.equal(events.includes(PlayerStatus.PLAYING), false);
  await player.endSession();
});
