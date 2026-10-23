import test from 'node:test';
import assert from 'node:assert/strict';
import { LoadTiming } from '../../src/playback/load-timing.mjs';
import { StreamResolver } from '../../src/playback/stream-resolver.mjs';
import { PlayerStatus } from '../../src/playback/player.mjs';
import { playerFixture, FakeMpv, VIDEO, SECOND, settleUntil } from './player-fixture.mjs';

function gate() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

function untilAborted(signal, cancelled) {
  return new Promise((resolve, reject) => signal.addEventListener('abort', () => {
    cancelled(); reject(new Error('cancelled'));
  }, { once: true }));
}

test('Timing measures overlapping phases, with only receiver phase data in its output', async () => {
  let now = 0;
  const timing = new LoadTiming({ now: () => now });
  const handoff = gate();
  const wake = gate();
  const first = timing.measure('handoff', () => handoff.promise);
  const second = timing.measure('wake', () => wake.promise);
  now = 20; handoff.resolve(); await first;
  now = 30; wake.resolve(); await second;
  const logs = [];
  timing.report({ info: line => logs.push(line) }, 'loaded');
  assert.deepEqual(logs, ['Video load timing handoff=20ms wake=30ms mpv_start=0ms resolve=0ms load=0ms total=30ms outcome=loaded']);
});

test('Resolution and screen wake overlap handoff; mpv never starts before handoff', async t => {
  const handoff = gate();
  const wake = gate();
  const resolved = gate();
  const phases = [];
  const stream = { videoUrl: 'https://media.invalid/video', title: 'Private title' };
  let loaded;
  class ObservedMpv extends FakeMpv {
    async start(signal) { phases.push('mpv'); await super.start(signal); }
    async load(id, position, signal, selected) {
      loaded = selected; phases.push('load'); await super.load(id, position, signal);
    }
  }
  const logs = [];
  const { player } = playerFixture({ createMpv: () => new ObservedMpv(),
    handoff: () => { phases.push('handoff'); return handoff.promise; },
    room: { beforeVideo: () => { phases.push('wake'); return wake.promise; },
      afterPlayback() {}, cancelPending() {}, endSession() {} },
    resolver: { resolve: () => { phases.push('resolve'); return resolved.promise; } },
    log: { warn() {}, info: line => logs.push(line) },
  });
  t.after(() => player.endSession());
  const playing = player.play({ ...VIDEO, title: 'Sender private title' }, 12);
  await settleUntil(() => phases.length === 3);
  assert.deepEqual(new Set(phases), new Set(['resolve', 'wake', 'handoff']));
  handoff.resolve();
  await settleUntil(() => phases.includes('mpv'));
  resolved.resolve(stream);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(phases.includes('load'), false, 'screen wakes before each video loads');
  wake.resolve();
  assert.equal(await playing, true);
  assert.equal(loaded, stream);
  assert.equal(player.video.title, stream.title);
  assert.equal(logs.length, 1);
  assert.match(logs[0], /^Video load timing handoff=\d+ms wake=\d+ms mpv_start=\d+ms resolve=\d+ms load=\d+ms total=\d+ms outcome=loaded path=direct$/);
  assert.ok(!logs[0].includes(VIDEO.id));
  assert.ok(!logs[0].includes('Private'));
});

test('Resolver rejection falls back to the original video load without leaking error text', async t => {
  let selected = 'unset';
  const mpv = new FakeMpv();
  mpv.load = async (_id, _position, _signal, stream) => { selected = stream; };
  const logs = [];
  const { player } = playerFixture({ createMpv: () => mpv,
    resolver: { resolve: async () => { throw new Error(`private ${VIDEO.id}`); } },
    log: { warn: line => logs.push(line), info: line => logs.push(line) },
  });
  t.after(() => player.endSession());
  assert.equal(await player.play(VIDEO), true);
  assert.equal(selected, null);
  assert.ok(logs.every(line => !line.includes(VIDEO.id)));
});

test('New play cancels every old independent phase and awaits their cleanup', async t => {
  const started = new Set();
  const cancelled = new Set();
  let first = true;
  const pending = name => signal => {
    if (!first) return Promise.resolve(null);
    started.add(name);
    return untilAborted(signal, () => cancelled.add(name));
  };
  const resolve = pending('resolve');
  const handoff = pending('handoff');
  const { player, instances } = playerFixture({
    resolver: { resolve: (_id, { signal }) => resolve(signal) },
    room: { beforeVideo: pending('wake'), afterPlayback() {}, cancelPending() {}, endSession() {} },
    handoff: ({ signal }) => handoff(signal),
  });
  t.after(() => player.endSession());
  const old = player.play(VIDEO);
  await settleUntil(() => started.size === 3);
  first = false;
  const replacement = player.play(SECOND);
  assert.equal(await old, false);
  assert.equal(await replacement, true);
  assert.deepEqual(cancelled, started);
  assert.equal(instances[0].closed, true);
  assert.equal(player.video.id, SECOND.id);
});

test('Handoff failure aborts screen wake and resolution and prevents mpv startup', async () => {
  const cancelled = new Set();
  let starts = 0;
  const mpv = new FakeMpv();
  mpv.start = async () => { starts++; };
  const { player } = playerFixture({ createMpv: () => mpv,
    handoff: async () => { throw new Error('busy'); },
    resolver: { resolve: (_id, { signal }) => untilAborted(signal, () => cancelled.add('resolve')) },
    room: { beforeVideo: signal => untilAborted(signal, () => cancelled.add('wake')),
      afterPlayback() {}, cancelPending() {}, endSession() {} },
  });
  assert.equal(await player.play(VIDEO), false);
  assert.equal(starts, 0);
  assert.deepEqual(cancelled, new Set(['resolve', 'wake']));
  assert.equal(mpv.closed, true);
  await player.endSession();
});

test('Stop during resolution waits for cleanup and the next play gets a fresh mpv', async t => {
  const cleanup = gate();
  let resolving = false;
  let first = true;
  const { player, instances } = playerFixture({ resolver: { resolve: async (_id, { signal }) => {
    if (!first) return null;
    first = false; resolving = true;
    await untilAborted(signal, () => {}).catch(() => cleanup.promise);
    signal.throwIfAborted();
  } } });
  t.after(() => player.endSession());
  const old = player.play(VIDEO);
  await settleUntil(() => resolving);
  const stopped = player.stop();
  const next = player.play(SECOND);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(instances.length, 1);
  cleanup.resolve();
  await stopped;
  assert.equal(await old, false);
  assert.equal(await next, true);
  assert.equal(instances[0].closed, true);
  assert.equal(instances.length, 2);
});

test('Playing prefetches only the next cast entry, uses low priority, and stop aborts it', async () => {
  const calls = [];
  let aborted = false;
  const { player } = playerFixture({ resolver: { resolve: async (id, options) => {
    calls.push({ id, ...options });
    if (options.prefetch) return untilAborted(options.signal, () => { aborted = true; });
    return null;
  } } });
  player.castQueue.add(SECOND.id);
  player.castQueue.add('zzzzzzzzzzz');
  await player.play(VIDEO);
  await settleUntil(() => calls.length === 2);
  assert.equal(calls[1].id, SECOND.id);
  assert.equal(calls[1].prefetch, true);
  assert.equal(player.castQueue.snapshot().length, 2, 'prefetch must not consume the queue');
  await player.stop();
  assert.equal(aborted, true);
  assert.equal(calls.length, 2);
  await player.endSession();
});

test('Playing a prefetched queue entry reuses its selected streams without another extraction', async t => {
  const extracted = [];
  const loaded = [];
  const resolver = new StreamResolver({ run: async argv => {
    const id = new URL(argv.at(-1)).searchParams.get('v');
    extracted.push(id);
    return { code: 0, stdout: JSON.stringify({ id, title: `Title ${id}`,
      url: `https://r.googlevideo.com/video?id=${id}&expire=${Math.floor(Date.now() / 1000) + 3600}`,
      protocol: 'https', vcodec: 'avc1', acodec: 'mp4a',
    }) };
  } });
  class SelectedMpv extends FakeMpv {
    async load(id, position, signal, stream) {
      loaded.push(stream); await super.load(id, position, signal);
    }
  }
  const { player } = playerFixture({ resolver, createMpv: () => new SelectedMpv() });
  t.after(() => player.endSession());
  player.castQueue.add(SECOND.id);
  await player.play(VIDEO);
  await settleUntil(() => extracted.length === 2);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(await player.playQueued(), true);
  assert.deepEqual(extracted, [VIDEO.id, SECOND.id]);
  assert.equal(new URL(loaded[1].videoUrl).searchParams.get('id'), SECOND.id);
  assert.equal(player.video.id, SECOND.id);
  assert.equal(player.video.title, `Title ${SECOND.id}`);
});

test('A crashed player is closed and replaced rather than reused', async t => {
  const { player, instances } = playerFixture();
  t.after(() => player.endSession());
  await player.play(VIDEO);
  instances[0].emit('disconnect');
  await settleUntil(() => player.status === PlayerStatus.STOPPED);
  assert.equal(instances[0].closed, true);
  assert.equal(await player.play(SECOND), true);
  assert.equal(instances.length, 2);
  assert.equal(player.video.id, SECOND.id);
});
