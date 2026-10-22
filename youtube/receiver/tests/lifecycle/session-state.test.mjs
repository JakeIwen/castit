import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';
import { PrivateDataStore } from '../../src/storage/private-data-store.mjs';
import { PairingCodes } from '../../src/pairing/pairing-codes.mjs';
import { RoomPreparation } from '../../src/host/room-preparation.mjs';
import { config } from '../../src/config/receiver-config.mjs';
import { runCommand } from '../../src/host/process-command.mjs';
import { quiet } from '../playback/player-fixture.mjs';

test('Screen identity and settings survive reopening, remain private and reject corruption', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'yt-state-'));
  t.after(() => rm(directory, { recursive: true }));
  const store = new PrivateDataStore(directory);
  await store.initialize();
  const identity = { screenId: 'screen', deviceId: 'device' };
  await Promise.all([store.set('mdxContext.cl', identity), store.set('settings', { volume: 42 })]);
  const reopened = new PrivateDataStore(directory);
  assert.deepEqual(await reopened.get('mdxContext.cl'), identity);
  assert.deepEqual(await reopened.get('settings'), { volume: 42 });
  assert.equal((await stat(directory)).mode & 0o777, 0o700);
  assert.equal((await stat(join(directory, 'mdxContext.cl.json'))).mode & 0o777, 0o600);
  assert.equal(await reopened.get('missing'), null);
  await writeFile(join(directory, 'mdxContext.cl.json'), 'broken');
  await assert.rejects(reopened.get('mdxContext.cl'), SyntaxError);
  await assert.rejects(reopened.set('../escape', {}), /Invalid state key/);
});

test('Pairing code expires, supports refresh and does not expose invalid server text', async t => {
  const service = new EventEmitter();
  let starts = 0;
  service.start = () => { starts++; service.emit('request'); };
  service.stop = () => {};
  let now = 100;
  const pairing = new PairingCodes(service, { log: quiet, now: () => now });
  t.after(() => pairing.stop());
  pairing.start();
  assert.equal(pairing.refresh(), false);
  service.emit('response', '123456789012');
  assert.equal(pairing.snapshot().code, '123 456 789 012');
  now += config.pairingLifetimeMs;
  assert.equal(pairing.snapshot().code, null);
  assert.equal(pairing.refresh(), true);
  assert.equal(starts, 2);
  service.emit('response', '<html>private upstream error</html>');
  assert.equal(pairing.snapshot().code, null);
  assert.equal(pairing.snapshot().error, 'Pairing code unavailable; retrying');
});

test('Room prepares once per session, wakes every video and tolerates preparation failure', async () => {
  const commands = [];
  const roomCommand = ['/usr/bin/true'];
  const room = new RoomPreparation({ roomCommand, log: quiet, run: async (command, options) => {
    commands.push(command);
    if (command === roomCommand) assert.ok(options.timeoutMs <= 20_000);
  } });
  await room.beforeVideo();
  await room.beforeVideo();
  assert.equal(commands.filter(command => command === roomCommand).length, 1);
  assert.equal(commands.filter(command => command === config.wakeCommand).length, 2);
  room.endSession();
  await room.beforeVideo();
  assert.equal(commands.filter(command => command === roomCommand).length, 2);
  const failing = new RoomPreparation({ roomCommand, log: quiet,
    run: async () => { throw new Error('offline'); } });
  await failing.beforeVideo();
});

test('Null room preparation only wakes the screen and still respects cancellation', async () => {
  assert.equal(config.roomCommand, null);
  const commands = [];
  const room = new RoomPreparation({ run: async command => { commands.push(command); } });
  await room.beforeVideo();
  await room.beforeVideo();
  room.endSession();
  await room.beforeVideo();
  assert.deepEqual(commands, [config.wakeCommand, config.wakeCommand, config.wakeCommand]);
  const abort = new AbortController();
  abort.abort();
  await assert.rejects(room.beforeVideo(abort.signal), { name: 'AbortError' });
});

test('Detached process commands terminate on timeout and cancellation', async () => {
  const command = [process.execPath, '-e', 'setInterval(() => {}, 1000)'];
  const start = Date.now();
  await assert.rejects(runCommand(command, { timeoutMs: 50 }), /timeout/);
  assert.ok(Date.now() - start < 2000);
  const abort = new AbortController();
  const pending = runCommand(command, { signal: abort.signal });
  abort.abort();
  await assert.rejects(pending, /cancellation/);
});
