import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { Constants } from 'yt-cast-receiver';
import { WatchHistory, WATCH_HISTORY_PLAYING_MS } from '../../src/history/watch-history.mjs';

const Status = Constants.PLAYER_STATUSES;
const A = 'dQw4w9WgXcQ';
const B = 'jNQXAC9IVRw';
const C = 'aqz-KE-bpKQ';
const validFile = () => ({ enabled: true, reason: null, version: 'first' });
const wallTime = '2026-01-01T00:00:00.000Z';

function fixture(t, { file = validFile(), mark } = {}) {
  let now = 0;
  let sample;
  const calls = [];
  const warnings = [];
  const marker = { file,
    inspect: async () => marker.file,
    mark: async (id, options) => {
      calls.push({ id, ...options });
      return mark ? mark(id, options) : { ...marker.file, reason: null };
    },
  };
  const player = Object.assign(new EventEmitter(), { status: Status.IDLE, video: null, position: 0 });
  const history = new WatchHistory({ marker, now: () => now, wallNow: () => new Date(wallTime),
    every: fn => { sample = fn; return 42; }, cancel: timer => assert.equal(timer, 42),
    log: { warn: message => warnings.push(message) } });
  history.start(player);
  t.after(() => history.stop());
  const flush = async () => {
    await history.refresh();
    await new Promise(setImmediate);
    await history.refresh();
  };
  return { history, player, marker, calls, warnings, flush,
    state(status, id = player.video?.id) {
      player.status = status;
      player.video = id ? { id } : null;
      player.emit('state', { current: { status } });
    },
    advance(ms) { now += ms; sample(); },
  };
}

test('Twenty seconds count only PLAYING wall time, not loading, pauses, seeks or repeated state events', async t => {
  const f = fixture(t);
  await f.flush();
  assert.equal(WATCH_HISTORY_PLAYING_MS, 20_000);
  f.state(Status.LOADING, A);
  f.advance(50_000);
  f.state(Status.PLAYING, A);
  f.advance(12_000);
  f.player.position = 3000;
  f.state(Status.PAUSED);
  f.advance(60_000);
  await f.flush();
  assert.equal(f.calls.length, 0);
  f.state(Status.PLAYING);
  f.advance(7999);
  await f.flush();
  assert.equal(f.calls.length, 0);
  f.advance(1);
  await f.flush();
  assert.deepEqual(f.calls.map(call => call.id), [A]);
  assert.deepEqual(f.history.snapshot(), { enabled: true, state: 'ok', reason: null, lastMarkedAt: wallTime });
  f.state(Status.PLAYING);
  f.advance(50_000);
  f.state(Status.PAUSED);
  f.state(Status.PLAYING);
  f.advance(50_000);
  await f.flush();
  assert.equal(f.calls.length, 1);
});

test('Each new play starts its own clock, including a replay of the same video', async t => {
  const f = fixture(t);
  f.state(Status.PLAYING, A);
  f.advance(19_000);
  f.state(Status.LOADING, B);
  f.state(Status.PLAYING, B);
  f.advance(19_000);
  await f.flush();
  assert.equal(f.calls.length, 0);
  f.advance(1000);
  await f.flush();
  f.state(Status.LOADING, B);
  f.state(Status.PLAYING, B);
  f.advance(20_000);
  await f.flush();
  assert.deepEqual(f.calls.map(call => call.id), [B, B]);
});

test('Absent and rejected cookie files fail closed; replacing one enables a qualified current play', async t => {
  const f = fixture(t, { file: { enabled: false, reason: null, version: null } });
  f.state(Status.PLAYING, A);
  f.advance(30_000);
  await f.flush();
  assert.deepEqual(f.history.snapshot(), { enabled: false, state: 'off', reason: null, lastMarkedAt: null });
  assert.equal(f.calls.length, 0);
  f.marker.file = { enabled: false, reason: 'rejected-file', version: null };
  await f.flush();
  assert.deepEqual(f.history.snapshot(), { enabled: false, state: 'failed', reason: 'rejected-file', lastMarkedAt: null });
  assert.equal(f.calls.length, 0);
  f.marker.file = validFile();
  f.advance(1);
  await f.flush();
  assert.equal(f.calls.length, 1);
});

test('Only one mark runs at a time; the newest qualified pending play supersedes older pending work', async t => {
  const releases = [];
  const f = fixture(t, { mark: () => new Promise(resolve => releases.push(resolve)) });
  for (const id of [A, B, C]) {
    f.state(Status.LOADING, id);
    f.state(Status.PLAYING, id);
    f.advance(20_000);
    await f.flush();
  }
  assert.deepEqual(f.calls.map(call => call.id), [A]);
  releases.shift()({ ...validFile(), reason: null });
  await f.flush();
  assert.deepEqual(f.calls.map(call => call.id), [A, C]);
  assert.equal(f.calls[0].signal.aborted, false);
  f.history.stop();
  assert.equal(f.calls[1].signal.aborted, true);
  releases.shift()({ ...validFile(), reason: null });
  await f.flush();
  assert.equal(f.player.listenerCount('state'), 0);
});

test('Signed-out status is category-only and suspends further marks until the file is replaced', async t => {
  const f = fixture(t, { mark: async () => ({ ...validFile(), reason: 'signed-out' }) });
  f.state(Status.PLAYING, A);
  f.advance(20_000);
  await f.flush();
  assert.deepEqual(f.history.snapshot(), { enabled: true, state: 'failed', reason: 'signed-out', lastMarkedAt: null });
  assert.deepEqual(f.warnings, ['Watch history: signed-out']);
  f.state(Status.LOADING, B);
  f.state(Status.PLAYING, B);
  f.advance(20_000);
  await f.flush();
  assert.equal(f.calls.length, 1);
  f.marker.file = { ...validFile(), version: 'replacement' };
  await f.flush();
  assert.equal(f.calls.length, 2);
  assert.deepEqual(Object.keys(f.history.snapshot()).sort(), ['enabled', 'lastMarkedAt', 'reason', 'state']);
});

test('Removing cookies cancels the active run and a late completion cannot re-enable history', async t => {
  let release;
  const f = fixture(t, { mark: () => new Promise(resolve => { release = resolve; }) });
  f.state(Status.PLAYING, A);
  f.advance(20_000);
  await f.flush();
  f.marker.file = { enabled: false, reason: null, version: null };
  await f.flush();
  assert.equal(f.calls[0].signal.aborted, true);
  release({ ...validFile(), reason: null });
  await f.flush();
  assert.deepEqual(f.history.snapshot(), { enabled: false, state: 'off', reason: null, lastMarkedAt: null });
});

test('Unexpected adapter errors are sanitized, attempted only once and cannot disrupt player events', async t => {
  const f = fixture(t, { mark: async () => { throw new Error('private account output'); } });
  f.state(Status.PLAYING, A);
  f.advance(20_000);
  await f.flush();
  assert.deepEqual(f.history.snapshot(), { enabled: true, state: 'failed', reason: 'error', lastMarkedAt: null });
  assert.deepEqual(f.warnings, ['Watch history: error']);
  f.advance(30_000);
  await f.flush();
  assert.equal(f.calls.length, 1);
});
