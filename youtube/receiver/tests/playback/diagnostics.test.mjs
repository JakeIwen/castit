import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { DiagnosticsHistory, unavailableDiagnostics } from '../../src/playback/diagnostics.mjs';
import { MpvDiagnostics } from '../../src/playback/mpv/diagnostics.mjs';
import { FakeMpv, playerFixture, VIDEO, SECOND, settleUntil } from './player-fixture.mjs';

const sample = (changes = {}) => ({ buffering: true, paused: false, position: 60, speed: 1,
  cache: { 'cache-duration': 0.3, 'raw-input-rate': 50_000 },
  videoBitrate: 1_800_000, audioBitrate: 120_000, totalFrameDrops: 5, totalDecoderDrops: 0,
  ...changes });

test('Buffering is immediate; bandwidth remains a suspicion requiring sustained low input', () => {
  const history = new DiagnosticsHistory();
  const first = history.record(sample(), 0);
  assert.equal(first.buffering, true);
  assert.equal(first.reason, 'unknown');
  assert.equal(history.record(sample(), 2000).reason, 'unknown');
  const third = history.record(sample(), 4000);
  assert.equal(third.reason, 'bandwidth');
  assert.equal(third.inputBytesPerSecond, 50_000);
  assert.equal(third.requiredBytesPerSecond, 240_000);
  assert.equal(history.record(sample({ buffering: false }), 6000).reason, null);
});

test('Missing demand, a healthy refill, or a full buffer cannot blame bandwidth', () => {
  for (const changes of [
    { videoBitrate: undefined }, { audioBitrate: null },
    { cache: { 'cache-duration': 0.3, 'raw-input-rate': 300_000 } },
    { cache: { 'cache-duration': 15, 'raw-input-rate': 50_000 } },
  ]) {
    const history = new DiagnosticsHistory();
    for (const at of [0, 2000, 4000]) history.record(sample(changes), at);
    assert.equal(history.snapshot().reason, 'unknown');
  }
  const history = new DiagnosticsHistory();
  history.record(sample(), 0);
  history.record(sample(), 2000);
  assert.equal(history.record(sample({ cache: { 'cache-duration': 0.2, 'raw-input-rate': 400_000 } }), 4000).reason, 'unknown');
});

test('Demand accounts for playback speed and malformed metrics remain unknown', () => {
  const history = new DiagnosticsHistory();
  assert.equal(history.record(sample({ speed: 2 }), 0).requiredBytesPerSecond, 480_000);
  const value = history.record(sample({ videoBitrate: -1, audioBitrate: '120000',
    cache: { 'cache-duration': NaN, 'raw-input-rate': -1 } }), 2000);
  assert.equal(value.requiredBytesPerSecond, null);
  assert.equal(value.bufferSeconds, null);
  assert.equal(value.inputBytesPerSecond, null);
  assert.equal(value.reason, 'unknown');
});

test('Recent frame drops identify a presentation issue without treating buffer recovery as rendering trouble', () => {
  const history = new DiagnosticsHistory();
  history.record(sample({ buffering: false, totalFrameDrops: 100 }), 0);
  assert.equal(history.record(sample({ buffering: false, totalFrameDrops: 102 }), 2000).reason, null);
  const warning = history.record(sample({ buffering: false, totalFrameDrops: 105 }), 4000);
  assert.equal(warning.reason, 'rendering');
  assert.equal(warning.frameDrops, 5);
  history.record(sample({ buffering: true, totalFrameDrops: 108 }), 6000);
  assert.equal(history.record(sample({ buffering: false, totalFrameDrops: 110 }), 8000).reason, null);
  assert.equal(history.record(sample({ buffering: false, totalFrameDrops: 110 }), 20_000).reason, null);
});

test('Pause, seek, unavailable telemetry and reset clear active warnings and old evidence', () => {
  const history = new DiagnosticsHistory();
  for (const at of [0, 2000, 4000]) history.record(sample(), at);
  assert.equal(history.snapshot().reason, 'bandwidth');
  const paused = history.record(sample({ paused: true, totalFrameDrops: 99 }), 6000);
  assert.equal(paused.buffering, false);
  assert.equal(paused.reason, null);
  assert.equal(paused.frameDrops, 0);
  assert.equal(history.record(sample(), 8000).reason, 'unknown');
  assert.equal(history.record(sample({ position: 2 }), 10_000).reason, 'unknown');
  assert.deepEqual(history.record(sample({ buffering: undefined }), 12_000), unavailableDiagnostics());
  history.record(sample(), 14_000);
  history.reset();
  assert.deepEqual(history.snapshot(), unavailableDiagnostics());
});

test('Diagnostics sampler never overlaps slow IPC rounds and ignores completion after stop', async t => {
  const mpv = new EventEmitter();
  let requests = 0;
  let release;
  const pending = new Promise(resolve => { release = resolve; });
  mpv.command = async () => { requests++; await pending; return true; };
  const diagnostics = new MpvDiagnostics({ intervalMs: 5 });
  t.after(() => diagnostics.stop());
  diagnostics.start(mpv);
  const initialRequests = requests;
  assert.ok(initialRequests > 0);
  await delay(25);
  assert.equal(requests, initialRequests);
  diagnostics.stop();
  release();
  await delay(20);
  assert.equal(requests, initialRequests);
  assert.deepEqual(diagnostics.snapshot(), unavailableDiagnostics());
});

test('Public player diagnostics reset on replacement and stop; old replies cannot repopulate them', async t => {
  let releaseOld;
  class ReportingMpv extends FakeMpv {
    async command(command) {
      if (command[0] !== 'get_property') return super.command(command);
      if (command[1] === 'paused-for-cache') return true;
      if (command[1] === 'pause') return false;
      return null;
    }
  }
  class SlowMpv extends ReportingMpv {
    async command(command) {
      if (command[0] === 'get_property') await new Promise(resolve => {
        const prior = releaseOld;
        releaseOld = () => { prior?.(); resolve(); };
      });
      return super.command(command);
    }
  }
  let count = 0;
  const { player } = playerFixture({ createMpv: () => ++count === 1 ? new SlowMpv() : new ReportingMpv() });
  t.after(() => player.endSession());
  await player.play(VIDEO);
  assert.equal(player.diagnostics.available, false);
  await player.play(SECOND);
  await settleUntil(() => player.diagnostics.buffering);
  assert.equal(player.diagnostics.reason, 'unknown');
  await player.stop();
  releaseOld();
  await delay(5);
  assert.deepEqual(player.diagnostics, unavailableDiagnostics());
});
