import test from 'node:test';
import assert from 'node:assert/strict';
import { RoomPreparation } from '../../src/host/room-preparation.mjs';
import { config } from '../../src/config/receiver-config.mjs';
import { PlayerStatus } from '../../src/playback/player.mjs';
import { createPlayerControls } from '../../src/controls/player-controls.mjs';
import { playerFixture, FakeMpv, VIDEO, SECOND } from './player-fixture.mjs';

const flush = () => new Promise(resolve => setImmediate(resolve));

function roomFixture(t, check = async () => {}) {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const roomCommand = ['/room-check'];
  const commands = [];
  const warnings = [];
  const room = new RoomPreparation({ roomCommand, log: { warn: line => warnings.push(line) },
    run: async (command, options) => {
      commands.push(command);
      if (command === roomCommand) await check(options);
    },
  });
  t.after(() => room.endSession());
  return { room, commands, warnings, checks: () => commands.filter(command => command === roomCommand).length };
}

test('Screen wake precedes each video; room checks wait until after successful playback starts', async t => {
  const { room, commands, checks } = roomFixture(t);
  let enterLoad;
  let finishLoad;
  const entered = new Promise(resolve => { enterLoad = resolve; });
  const loading = new Promise(resolve => { finishLoad = resolve; });
  let loads = 0;
  class DelayedMpv extends FakeMpv {
    async load(...args) {
      assert.equal(commands.filter(command => command === config.wakeCommand).length, ++loads);
      enterLoad();
      await loading;
      await super.load(...args);
    }
  }
  const { player } = playerFixture({ room, createMpv: () => new DelayedMpv() });
  t.after(() => player.endSession());
  const playing = player.play(VIDEO);
  await entered;
  t.mock.timers.tick(config.roomCheckDelayMs * 2);
  assert.equal(checks(), 0, 'loading must not run the room check');
  finishLoad();
  assert.equal(await playing, true);
  t.mock.timers.tick(config.roomCheckDelayMs - 1);
  assert.equal(checks(), 0);
  t.mock.timers.tick(1);
  await flush();
  assert.equal(checks(), 1);
  assert.equal(player.status, PlayerStatus.PLAYING);
  assert.equal(await player.play(SECOND), true);
  assert.equal(checks(), 1);
  t.mock.timers.tick(config.roomCheckDelayMs);
  await flush();
  assert.equal(checks(), 2);
});

test('Phone, API and popup-toggle resumes all schedule checks after resuming', async t => {
  const { room, checks } = roomFixture(t);
  const { player } = playerFixture({ room });
  const controls = createPlayerControls(player);
  t.after(() => player.endSession());
  assert.equal(await player.play(VIDEO), true);
  t.mock.timers.tick(config.roomCheckDelayMs);
  await flush();
  let expected = 1;
  for (const resume of [() => player.resume(), controls.resume, controls.toggle]) {
    assert.equal(await player.pause(), true);
    assert.equal(await resume(), true);
    assert.equal(player.status, PlayerStatus.PLAYING);
    t.mock.timers.tick(config.roomCheckDelayMs - 1);
    assert.equal(checks(), expected);
    t.mock.timers.tick(1);
    await flush();
    assert.equal(checks(), ++expected);
  }
  assert.equal(await player.resume(), false, 'already playing is not a successful resume');
  t.mock.timers.tick(config.roomCheckDelayMs);
  assert.equal(checks(), expected);
});

test('A failed or timed-out room check never changes successful playback or resume', async t => {
  let attempt = 0;
  const { room, checks, warnings } = roomFixture(t, async () => {
    throw new Error(attempt++ ? 'Command timeout/cancellation' : `private ${VIDEO.id}`);
  });
  const { player } = playerFixture({ room });
  t.after(() => player.endSession());
  assert.equal(await player.play(VIDEO), true);
  t.mock.timers.tick(config.roomCheckDelayMs);
  await flush();
  assert.equal(player.status, PlayerStatus.PLAYING);
  assert.equal(await player.pause(), true);
  assert.equal(await player.resume(), true);
  t.mock.timers.tick(config.roomCheckDelayMs);
  await flush();
  assert.equal(checks(), 2);
  assert.deepEqual(warnings, Array(2).fill('Room check failed; continuing playback'));
  assert.equal(player.status, PlayerStatus.PLAYING);
});

test('Stop, release and endSession cancel pending checks without waiting for a running command', async t => {
  const finishes = [];
  const { room, checks } = roomFixture(t, () => new Promise(resolve => finishes.push(resolve)));
  const { player } = playerFixture({ room });
  t.after(() => player.endSession());
  for (const stop of [() => player.stop(), () => player.release(), () => player.endSession()]) {
    assert.equal(await player.play(VIDEO), true);
    await stop();
    t.mock.timers.tick(config.roomCheckDelayMs);
    assert.equal(checks(), 0);
  }
  assert.equal(await player.play(VIDEO), true);
  t.mock.timers.tick(config.roomCheckDelayMs);
  assert.equal(checks(), 1);
  assert.equal(await player.pause(), true);
  assert.equal(await player.resume(), true);
  t.mock.timers.tick(config.roomCheckDelayMs);
  await player.stop();
  assert.equal(player.status, PlayerStatus.STOPPED);
  finishes[0]();
  await flush();
  t.mock.timers.tick(config.roomCheckDelayMs * 3);
  assert.equal(checks(), 1, 'stop also cancels the coalesced follow-up');
});

test('A replacement cancels an old scheduled check while its own load is still pending', async t => {
  const { room, checks } = roomFixture(t);
  let enterLoad;
  let finishLoad;
  const entered = new Promise(resolve => { enterLoad = resolve; });
  const loading = new Promise(resolve => { finishLoad = resolve; });
  class DelayedReplacement extends FakeMpv {
    async load(...args) {
      if (args[0] === SECOND.id) { enterLoad(); await loading; }
      await super.load(...args);
    }
  }
  const { player } = playerFixture({ room, createMpv: () => new DelayedReplacement() });
  t.after(() => player.endSession());
  await player.play(VIDEO);
  t.mock.timers.tick(1000);
  const replacing = player.play(SECOND);
  await entered;
  t.mock.timers.tick(config.roomCheckDelayMs * 2);
  assert.equal(checks(), 0);
  finishLoad();
  assert.equal(await replacing, true);
  t.mock.timers.tick(config.roomCheckDelayMs - 1);
  assert.equal(checks(), 0);
  t.mock.timers.tick(1);
  await flush();
  assert.equal(checks(), 1);
});

test('Failed starts and resumes do not schedule checks', async t => {
  const { room, checks } = roomFixture(t);
  let failLoad = true;
  class FailingMpv extends FakeMpv {
    async load(...args) {
      if (failLoad) throw new Error('failed load');
      await super.load(...args);
    }
    async command(command) {
      if (command[0] === 'set_property' && command[1] === 'pause' && command[2] === false) {
        throw new Error('failed resume');
      }
      await super.command(command);
    }
  }
  const { player } = playerFixture({ room, createMpv: () => new FailingMpv() });
  t.after(() => player.endSession());
  assert.equal(await player.play(VIDEO), false);
  t.mock.timers.tick(config.roomCheckDelayMs);
  assert.equal(checks(), 0);
  failLoad = false;
  assert.equal(await player.play(VIDEO), true);
  t.mock.timers.tick(config.roomCheckDelayMs);
  await flush();
  assert.equal(checks(), 1);
  assert.equal(await player.pause(), true);
  assert.equal(await player.resume(), false);
  t.mock.timers.tick(config.roomCheckDelayMs);
  assert.equal(checks(), 1);
  assert.equal(player.status, PlayerStatus.PAUSED);
});
