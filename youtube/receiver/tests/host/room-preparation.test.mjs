import test from 'node:test';
import assert from 'node:assert/strict';
import { RoomPreparation } from '../../src/host/room-preparation.mjs';
import { config } from '../../src/config/receiver-config.mjs';

const flush = () => new Promise(resolve => setImmediate(resolve));
const roomCommand = ['/room-check'];

test('Room checks wait after playback and a newer start resets the delay', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const calls = [];
  const room = new RoomPreparation({ roomCommand, run: async (command, options) => {
    calls.push({ command, options });
  } });
  t.after(() => room.endSession());
  room.afterPlayback();
  t.mock.timers.tick(1000);
  room.afterPlayback();
  t.mock.timers.tick(config.roomCheckDelayMs - 1);
  assert.deepEqual(calls, []);
  t.mock.timers.tick(1);
  await flush();
  assert.deepEqual(calls, [{ command: roomCommand, options: { timeoutMs: config.roomTimeoutMs } }]);
  t.mock.timers.tick(config.roomCheckDelayMs * 4);
  assert.equal(calls.length, 1);
});

test('Due checks coalesce into at most one follow-up without overlapping commands', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const finishes = [];
  let active = 0;
  let peak = 0;
  const room = new RoomPreparation({ roomCommand, run: async () => {
    peak = Math.max(peak, ++active);
    await new Promise(resolve => finishes.push(resolve));
    active--;
  } });
  t.after(() => room.endSession());
  room.afterPlayback();
  t.mock.timers.tick(config.roomCheckDelayMs);
  for (let attempt = 0; attempt < 4; attempt++) {
    room.afterPlayback();
    t.mock.timers.tick(config.roomCheckDelayMs);
  }
  assert.equal(finishes.length, 1);
  finishes[0]();
  await flush();
  assert.equal(finishes.length, 2);
  assert.equal(peak, 1);
  finishes[1]();
  await flush();
  t.mock.timers.tick(config.roomCheckDelayMs * 4);
  assert.equal(finishes.length, 2);
});

test('A newer start also reschedules a follow-up that was waiting on a running check', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const finishes = [];
  const room = new RoomPreparation({ roomCommand, run: () => new Promise(resolve => finishes.push(resolve)) });
  t.after(() => room.endSession());
  room.afterPlayback();
  t.mock.timers.tick(config.roomCheckDelayMs);
  room.afterPlayback();
  t.mock.timers.tick(config.roomCheckDelayMs);
  room.afterPlayback();
  finishes[0]();
  await flush();
  assert.equal(finishes.length, 1);
  t.mock.timers.tick(config.roomCheckDelayMs);
  assert.equal(finishes.length, 2);
  finishes[1]();
  await flush();
});

test('Ending a session cancels timers and due follow-ups but leaves a running check alone', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const finishes = [];
  const options = [];
  const room = new RoomPreparation({ roomCommand, run: (_command, settings) => {
    options.push(settings);
    return new Promise(resolve => finishes.push(resolve));
  } });
  room.afterPlayback();
  room.endSession();
  t.mock.timers.tick(config.roomCheckDelayMs);
  assert.equal(finishes.length, 0);
  room.afterPlayback();
  t.mock.timers.tick(config.roomCheckDelayMs);
  room.afterPlayback();
  t.mock.timers.tick(config.roomCheckDelayMs);
  room.endSession();
  assert.deepEqual(options, [{ timeoutMs: config.roomTimeoutMs }]);
  finishes[0]();
  await flush();
  t.mock.timers.tick(config.roomCheckDelayMs * 4);
  assert.equal(finishes.length, 1);
  room.afterPlayback();
  t.mock.timers.tick(config.roomCheckDelayMs);
  assert.equal(finishes.length, 2);
  finishes[1]();
  await flush();
  room.endSession();
});

test('Room check failures and timeouts are ignored and logged without command or error data', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const warnings = [];
  let calls = 0;
  const errors = ['private command output', 'Command timeout/cancellation'];
  const room = new RoomPreparation({ roomCommand, log: { warn: line => warnings.push(line) },
    run: async () => { throw new Error(errors[calls++]); },
  });
  t.after(() => room.endSession());
  for (let attempt = 0; attempt < errors.length; attempt++) {
    room.afterPlayback();
    t.mock.timers.tick(config.roomCheckDelayMs);
    await flush();
  }
  assert.equal(calls, 2);
  assert.deepEqual(warnings, Array(2).fill('Room check failed; continuing playback'));
});

test('A null room command never schedules checks but still wakes each video', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const commands = [];
  const room = new RoomPreparation({ roomCommand: null, run: async command => commands.push(command) });
  for (let video = 0; video < 2; video++) {
    await room.beforeVideo();
    room.afterPlayback();
    t.mock.timers.tick(config.roomCheckDelayMs);
  }
  assert.deepEqual(commands, [config.wakeCommand, config.wakeCommand]);
  room.endSession();
});
