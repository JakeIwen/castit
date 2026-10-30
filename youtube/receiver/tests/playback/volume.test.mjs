import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PrivateDataStore } from '../../src/storage/private-data-store.mjs';
import { createPlayerControls } from '../../src/controls/player-controls.mjs';
import { PlayerStatus } from '../../src/playback/player.mjs';
import { playerFixture, FakeMpv, VIDEO, SECOND, settleUntil } from './player-fixture.mjs';

// Command replies and observed properties are separate IPC messages. Keep the
// observation snapshots in order, but let the test deliver them after loading.
class ObservedVolumeMpv extends FakeMpv {
  constructor({ deferObservations = true } = {}) {
    super();
    this.deferObservations = deferObservations;
    this.properties.set('volume', 100);
    this.properties.set('mute', false);
    this.observed = new Set();
    this.notifications = [];
  }

  async command(command) {
    await super.command(command);
    const [operation, name, value] = command;
    if (operation === 'observe_property' && ['volume', 'mute'].includes(value)) {
      this.observed.add(value);
      this.notifications.push([value, this.properties.get(value)]);
    } else if (operation === 'set_property' && this.observed.has(name)) {
      this.notifications.push([name, value]);
    }
    if (!this.deferObservations) {
      for (const [property, data] of this.notifications.splice(0)) this.property(property, data);
    }
  }

  async deliverObservations(player, expected) {
    for (const [name, value] of this.notifications.splice(0)) {
      this.property(name, value);
      assert.deepEqual(await player.getVolume(), expected, `${name} observation ${value}`);
    }
  }
}

const MUTED_VOLUME = { level: 60, muted: true };

test('Delayed startup observations cannot change or persist the saved volume/mute', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'yt-volume-settings-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const store = new PrivateDataStore(directory);
  await store.initialize();
  await store.set('settings', { volume: MUTED_VOLUME });
  const mpv = new ObservedVolumeMpv();
  const { player } = playerFixture({ createMpv: () => mpv, store });
  t.after(() => player.endSession());
  await player.initialize();
  assert.equal(await player.play(VIDEO), true);
  assert.equal(player.status, PlayerStatus.PLAYING);
  assert.equal(mpv.propertiesAtLoad.get('volume'), 60);
  assert.equal(mpv.propertiesAtLoad.get('mute'), true);
  await mpv.deliverObservations(player, MUTED_VOLUME);
  const controls = createPlayerControls(player);
  await controls.stop();
  await controls.mute({ muted: false });
  const reopened = new PrivateDataStore(directory);
  assert.deepEqual((await reopened.get('settings')).volume, { level: 60, muted: false });
});

test('A recast during EOF cleanup cannot adopt the next mpv startup defaults', async t => {
  let finishClose;
  class SlowClosingMpv extends ObservedVolumeMpv {
    async close() {
      await new Promise(resolve => { finishClose = resolve; });
      await super.close();
    }
  }
  const instances = [];
  const { player } = playerFixture({ createMpv: () => {
    const Implementation = instances.length ? ObservedVolumeMpv : SlowClosingMpv;
    const mpv = new Implementation({ deferObservations: false });
    instances.push(mpv);
    return mpv;
  } });
  t.after(() => { finishClose?.(); return player.endSession(); });
  await player.setVolume(MUTED_VOLUME);
  const video = { id: 'tCDvOQI3pco', client: VIDEO.client };
  await player.play(video);
  instances[0].emit('event', { event: 'end-file', reason: 'eof' });
  await settleUntil(() => finishClose && player.status === PlayerStatus.PAUSED);
  const replay = player.play(video);
  await settleUntil(() => player.status === PlayerStatus.LOADING);
  finishClose();
  assert.equal(await replay, true);
  assert.deepEqual(await player.getVolume(), MUTED_VOLUME);
  assert.equal(instances[1].propertiesAtLoad.get('volume'), 60);
  assert.equal(instances[1].propertiesAtLoad.get('mute'), true);
});

test('Paused replay, local loads, quality reload and queue advance preserve volume/mute', async t => {
  const instances = [];
  const { player } = playerFixture({
    createMpv: () => { const mpv = new ObservedVolumeMpv(); instances.push(mpv); return mpv; },
    videoStore: { initialize: async () => {}, release: async () => {},
      resolve: async () => ({ videoUrl: '/saved/video.mp4', local: true }) },
  });
  t.after(() => player.endSession());
  await player.setVolume(MUTED_VOLUME);
  await player.play(VIDEO);
  await instances.at(-1).deliverObservations(player, MUTED_VOLUME);
  await player.pause();
  await player.play(VIDEO);
  await instances.at(-1).deliverObservations(player, MUTED_VOLUME);
  await player.pause();
  assert.equal(await player.setQuality('720'), true);
  await settleUntil(() => !player.quality.loading);
  assert.equal(player.status, PlayerStatus.PAUSED);
  await instances.at(-1).deliverObservations(player, MUTED_VOLUME);
  player.castQueue.add(SECOND.id);
  instances.at(-1).emit('event', { event: 'end-file', reason: 'eof' });
  await settleUntil(() => player.video?.id === SECOND.id && player.status === PlayerStatus.PLAYING);
  await instances.at(-1).deliverObservations(player, MUTED_VOLUME);
  for (const mpv of instances) {
    assert.equal(mpv.propertiesAtLoad.get('volume'), 60);
    assert.equal(mpv.propertiesAtLoad.get('mute'), true);
  }
});

test('Volume and mute changes from the active mpv still reach sender state', async t => {
  const { player, instances } = playerFixture();
  t.after(() => player.endSession());
  const volumes = [];
  player.on('state', event => volumes.push(event.current.volume));
  await player.play(VIDEO);
  instances[0].property('volume', 31);
  instances[0].property('mute', true);
  await settleUntil(() => volumes.some(volume => volume.level === 31 && volume.muted));
  assert.deepEqual(await player.getVolume(), { level: 31, muted: true });
  await player.pause();
  instances[0].property('volume', 42);
  instances[0].property('mute', false);
  await settleUntil(() => volumes.some(volume => volume.level === 42 && !volume.muted));
  assert.deepEqual(await player.getVolume(), { level: 42, muted: false });
});

test('Replaced and stopped mpv instances cannot overwrite volume/mute', async t => {
  const instances = [];
  class ClosingMpv extends ObservedVolumeMpv {
    async close() {
      this.property('volume', 100);
      this.property('mute', false);
      await super.close();
    }
  }
  const { player } = playerFixture({ createMpv: () => {
    const mpv = new ClosingMpv(); instances.push(mpv); return mpv;
  } });
  t.after(() => player.endSession());
  await player.setVolume(MUTED_VOLUME);
  await player.play(VIDEO);
  await player.play(SECOND);
  await instances[0].deliverObservations(player, MUTED_VOLUME);
  assert.deepEqual(await player.getVolume(), MUTED_VOLUME);
  await player.stop();
  await instances[1].deliverObservations(player, MUTED_VOLUME);
  assert.deepEqual(await player.getVolume(), MUTED_VOLUME);
});
