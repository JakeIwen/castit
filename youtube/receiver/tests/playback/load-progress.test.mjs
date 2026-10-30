import test from 'node:test';
import assert from 'node:assert/strict';
import { LoadProgress, LOAD_PHASES } from '../../src/playback/load-progress.mjs';
import { FakeMpv, playerFixture, VIDEO, SECOND, settleUntil } from './player-fixture.mjs';

function gate() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

test('Load progress reports rounded elapsed seconds and medians of only the last ten successful totals', () => {
  let now = 0;
  const progress = new LoadProgress({ now: () => now });
  assert.equal(progress.snapshot(), null);
  for (let duration = 1; duration <= 11; duration++) {
    const abort = new AbortController();
    const load = progress.start(abort.signal);
    assert.equal(progress.snapshot().phase, LOAD_PHASES.RESOLVE);
    assert.equal(progress.snapshot().expected, duration === 1 ? null : duration / 2);
    now += 260;
    assert.equal(progress.snapshot().elapsed, 0.3);
    load.resolved();
    assert.equal(progress.snapshot().phase, LOAD_PHASES.START);
    load.buffering();
    assert.equal(progress.snapshot().phase, LOAD_PHASES.BUFFER);
    now += duration * 1000 - 260;
    load.finish(true);
    assert.equal(progress.snapshot(), null);
  }
  const failed = progress.start(new AbortController().signal);
  now += 100_000;
  failed.finish(false);
  const abort = new AbortController();
  const cancelled = progress.start(abort.signal);
  now += 100_000;
  abort.abort();
  assert.equal(progress.snapshot(), null);
  cancelled.finish(true);
  progress.start(new AbortController().signal);
  assert.deepEqual(progress.snapshot(), { phase: LOAD_PHASES.RESOLVE, elapsed: 0, expected: 6.5 });
});

test('Superseded loads cannot change or clear progress or contribute a successful timing', () => {
  let now = 0;
  const progress = new LoadProgress({ now: () => now });
  const oldAbort = new AbortController();
  const old = progress.start(oldAbort.signal);
  now = 1000;
  const current = progress.start(new AbortController().signal);
  current.resolved();
  oldAbort.abort();
  old.resolved();
  old.buffering();
  old.finish(true);
  assert.deepEqual(progress.snapshot(), { phase: LOAD_PHASES.START, elapsed: 0, expected: null });
  now = 2501;
  current.finish(true);
  progress.start(new AbortController().signal);
  assert.equal(progress.snapshot().expected, 1.501);
  const aborted = new AbortController();
  aborted.abort();
  progress.start(aborted.signal).finish(true);
  assert.equal(progress.snapshot(), null);
});

test('Player progress follows resolution, startup and buffering, including quality reloads and queue navigation', async t => {
  let resolve = gate();
  let wake = gate();
  let handoff = gate();
  let start = gate();
  let buffer = gate();
  let opening = false;
  class LoadingMpv extends FakeMpv {
    async start(signal) { await start.promise; await super.start(signal); }
    async load(...args) { opening = true; await buffer.promise; await super.load(...args); }
  }
  const { player } = playerFixture({ createMpv: () => new LoadingMpv(),
    resolver: { resolve: () => resolve.promise }, handoff: () => handoff.promise,
    room: { beforeVideo: () => wake.promise, afterPlayback() {}, cancelPending() {}, endSession() {} } });
  t.after(() => player.endSession());
  assert.equal(player.loading, null);
  const playing = player.play(VIDEO);
  await settleUntil(() => player.loading);
  assert.equal(player.loading.phase, LOAD_PHASES.RESOLVE);
  assert.equal(player.loading.expected, null);
  assert.ok(player.loading.elapsed >= 0);
  resolve.resolve(null);
  await settleUntil(() => player.loading.phase === LOAD_PHASES.START);
  wake.resolve();
  assert.equal(player.loading.phase, LOAD_PHASES.START);
  handoff.resolve();
  await new Promise(setImmediate);
  assert.equal(player.loading.phase, LOAD_PHASES.START);
  start.resolve();
  await settleUntil(() => opening);
  assert.equal(player.loading.phase, LOAD_PHASES.BUFFER);
  buffer.resolve();
  assert.equal(await playing, true);
  assert.equal(player.loading, null);
  buffer = gate();
  opening = false;
  assert.equal(await player.setQuality('720'), true);
  await settleUntil(() => opening);
  assert.equal(player.loading.phase, LOAD_PHASES.BUFFER);
  assert.equal(typeof player.loading.expected, 'number');
  buffer.resolve();
  await settleUntil(() => player.loading === null);
  player.castQueue.add(SECOND.id, 'Next');
  buffer = gate();
  opening = false;
  const next = player.playNext();
  await settleUntil(() => opening);
  assert.equal(player.loading.phase, LOAD_PHASES.BUFFER);
  buffer.resolve();
  assert.equal(await next, true);
  assert.equal(player.loading, null);
  const previous = player.playPrevious();
  assert.equal(await previous, true);
  assert.equal(player.video.id, VIDEO.id);
  assert.equal(player.loading, null);
});

test('Cancellation clears loading immediately, even while prior cleanup drains; failures also clear it', async t => {
  const cleanup = gate();
  let resolving = false;
  const { player } = playerFixture({ resolver: { resolve: async (_id, { signal }) => {
    resolving = true;
    await new Promise(done => signal.addEventListener('abort', done, { once: true }));
    await cleanup.promise;
    signal.throwIfAborted();
  } } });
  t.after(() => player.endSession());
  const old = player.play(VIDEO);
  await settleUntil(() => resolving);
  assert.equal(player.loading.phase, LOAD_PHASES.RESOLVE);
  const stopped = player.stop();
  assert.equal(player.loading, null);
  cleanup.resolve();
  await stopped;
  assert.equal(await old, false);
  assert.equal(player.loading, null);
  const failing = playerFixture({ handoff: async () => { throw new Error('busy'); } }).player;
  t.after(() => failing.endSession());
  assert.equal(await failing.play(VIDEO), false);
  assert.equal(failing.loading, null);
});
