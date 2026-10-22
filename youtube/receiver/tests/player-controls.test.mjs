import test from 'node:test';
import assert from 'node:assert/strict';
import { createPlayerControls, createQueueControls, audioDelayArguments, speedArguments,
  volumeArguments, muteArguments, queueArguments } from '../src/player-controls.mjs';
import { CastQueue } from '../src/cast-queue.mjs';
import { playerFixture, settleUntil, quiet, VIDEO, SECOND } from './player-fixture.mjs';
import { PlayerStatus } from '../src/mpv-player.mjs';

function fakePlayer(state) {
  const calls = [];
  const record = name => async (...args) => { calls.push([name, ...args]); return true; };
  return { calls, video: { id: 'abcdefghijk' }, position: 100, duration: 600,
    queue: { hasNext: true, hasPrevious: true }, castQueue: new CastQueue({ lookupTitle: async () => null }), ...state,
    pause: record('pause'), resume: record('resume'), seek: record('seek'),
    next: record('next'), previous: record('previous'), reset: record('reset') };
}

test('Toggle pauses while playing, resumes while paused, and does nothing otherwise', async () => {
  const playing = fakePlayer({ status: PlayerStatus.PLAYING });
  await createPlayerControls(playing).toggle();
  const paused = fakePlayer({ status: PlayerStatus.PAUSED });
  await createPlayerControls(paused).toggle();
  const idle = fakePlayer({ status: PlayerStatus.IDLE });
  assert.equal(await createPlayerControls(idle).toggle(), false);
  assert.deepEqual([playing.calls, paused.calls, idle.calls], [[['pause']], [['resume']], []]);
});

test('Seek resolves offsets from the current position and clamps to the video', async () => {
  const player = fakePlayer({ status: PlayerStatus.PLAYING });
  const controls = createPlayerControls(player);
  await controls.seek({ offset: -20 });
  await controls.seek({ offset: -300 });
  await controls.seek({ offset: 600 });
  await controls.seek({ position: 42 });
  assert.deepEqual(player.calls, [['seek', 80], ['seek', 0], ['seek', 600], ['seek', 42]]);
  assert.equal(await createPlayerControls(fakePlayer({ video: null })).seek({ offset: 20 }), false);
});

test('Audio delay accepts exactly one finite absolute or relative number', () => {
  assert.deepEqual(audioDelayArguments({ delay: 0 }), { delay: 0 });
  assert.deepEqual(audioDelayArguments({ delay: -0.12 }), { delay: -0.12 });
  assert.deepEqual(audioDelayArguments({ offset: 0.05 }), { offset: 0.05 });
  assert.deepEqual(audioDelayArguments({ offset: 0 }), { offset: 0 });
  assert.equal(audioDelayArguments({}), null);
  assert.equal(audioDelayArguments({ delay: 0, offset: 0 }), null);
  for (const value of [null, '0.1', false, [], {}, NaN, Infinity, -Infinity]) {
    assert.equal(audioDelayArguments({ delay: value }), null);
    assert.equal(audioDelayArguments({ offset: value }), null);
  }
});

test('Audio delay controls adjust the latest setting while idle or playing', async t => {
  const { player, instances } = playerFixture();
  t.after(() => player.endSession());
  const controls = createPlayerControls(player);
  assert.equal(await controls.audio_delay({ delay: 0.12 }), true);
  assert.equal(player.audioDelay, 0.12);
  assert.equal(await controls.audio_delay({ offset: -0.05 }), true);
  assert.equal(player.audioDelay, 0.07);
  assert.equal(instances.length, 0);
  await player.play(VIDEO);
  await controls.audio_delay({ offset: 0.05 });
  assert.equal(player.audioDelay, 0.12);
  assert.equal(instances[0].properties.get('audio-delay'), 0.12);
  await controls.audio_delay({ offset: 5 });
  assert.equal(player.audioDelay, 1);
  await controls.audio_delay({ offset: -5 });
  assert.equal(player.audioDelay, -1);
  await controls.audio_delay({ delay: 0 });
  assert.equal(player.audioDelay, 0);
});

test('Next plays whatever comes next; with nothing queued it leaves the video playing', async t => {
  const { player, instances } = playerFixture();
  t.after(() => player.endSession());
  const controls = createPlayerControls(player);
  await player.play({ id: 'zzzzzzzzzzz', client: VIDEO.client });
  assert.equal(await controls.next(), false);
  assert.equal(player.status, PlayerStatus.PLAYING);
  player.castQueue.add(SECOND.id);
  assert.equal(await controls.next(), true);
  assert.deepEqual(instances[1].loaded, { id: SECOND.id, position: 0 });
});

test('Previous without a queue restarts the video', async () => {
  const player = fakePlayer({ status: PlayerStatus.PLAYING, queue: { hasPrevious: false } });
  await createPlayerControls(player).previous();
  assert.deepEqual(player.calls, [['seek', 0]]);
});

test('Stop clears both queues', async () => {
  const player = fakePlayer({ status: PlayerStatus.PLAYING });
  player.castQueue.add(SECOND.id);
  assert.equal(await createPlayerControls(player).stop(), true);
  assert.deepEqual(player.calls, [['reset']]);
  assert.equal(player.castQueue.length, 0);
});

test('Setting arguments take exactly one finite absolute value or offset', () => {
  assert.deepEqual(speedArguments({ speed: 1.5 }), { speed: 1.5 });
  assert.deepEqual(speedArguments({ offset: -0.25 }), { offset: -0.25 });
  assert.deepEqual(volumeArguments({ level: 40 }), { level: 40 });
  assert.equal(volumeArguments({ level: 40, offset: 5 }), null);
  assert.equal(speedArguments({ speed: '2' }), null);
  assert.deepEqual(muteArguments({}), {});
  assert.deepEqual(muteArguments({ muted: true }), { muted: true });
  assert.equal(muteArguments({ muted: 'yes' }), null);
});

test('Speed, volume and mute controls work while idle and save the result', async t => {
  const saved = [];
  const { player, instances } = playerFixture({ store: { get: async () => null, set: async (_key, value) => saved.push(value) } });
  t.after(() => player.endSession());
  const controls = createPlayerControls(player);
  assert.equal(await controls.speed({ speed: 1.5 }), true);
  assert.equal(await controls.speed({ offset: 0.25 }), true);
  assert.equal(player.speed, 1.75);
  assert.equal(await controls.volume({ offset: -15 }), true);
  assert.deepEqual(player.volume, { level: 55, muted: false });
  assert.equal(await controls.mute({}), true);
  assert.equal(player.volume.muted, true);
  assert.equal(await controls.volume({ level: 140 }), true);
  assert.deepEqual(player.volume, { level: 100, muted: false });
  assert.equal(await controls.mute({ muted: false }), true);
  assert.equal(player.volume.muted, false);
  assert.deepEqual(saved.at(-1), { volume: { level: 100, muted: false }, audioDelay: 0, speed: 1.75 });
  await player.play(VIDEO);
  assert.equal(instances[0].propertiesAtLoad.get('speed'), 1.75);
  assert.equal(instances[0].propertiesAtLoad.get('volume'), 100);
});

test('Queue add starts at once when idle and waits behind a playing video', async t => {
  const { player, instances } = playerFixture();
  t.after(() => player.endSession());
  const queue = createQueueControls(player, { log: quiet });
  assert.equal(queue.add({ videoId: VIDEO.id }), true);
  await settleUntil(() => player.status === PlayerStatus.PLAYING);
  assert.equal(instances[0].loaded.id, VIDEO.id);
  assert.equal(queue.add({ videoId: SECOND.id }), true);
  assert.equal(queue.add({ videoId: 'zzzzzzzzzzz' }), true);
  assert.deepEqual(player.castQueue.snapshot().map(entry => entry.id), [SECOND.id, 'zzzzzzzzzzz']);
  const [second, third] = player.castQueue.snapshot();
  assert.equal(queue.play({ key: third.key }), true);
  await settleUntil(() => instances[1]?.loaded);
  assert.equal(instances[1].loaded.id, 'zzzzzzzzzzz');
  assert.equal(queue.play({ key: third.key }), false);
  assert.equal(queue.remove({ key: second.key }), true);
  assert.equal(queue.remove({ key: second.key }), false);
  queue.add({ videoId: SECOND.id });
  assert.equal(queue.clear(), true);
  assert.equal(player.castQueue.length, 0);
});

test('Queue arguments need a video id to add and an integer key to remove or play', () => {
  assert.deepEqual(queueArguments({ action: 'add', videoId: VIDEO.id }), { videoId: VIDEO.id });
  assert.equal(queueArguments({ action: 'add', videoId: 'bad' }), null);
  assert.deepEqual(queueArguments({ action: 'remove', key: 3 }), { key: 3 });
  assert.equal(queueArguments({ action: 'play', key: '3' }), null);
  assert.deepEqual(queueArguments({ action: 'clear' }), {});
});
