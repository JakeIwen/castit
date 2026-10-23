import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PrivateDataStore } from '../../src/storage/private-data-store.mjs';
import { QUALITY_OPTIONS, qualityArguments, qualityFormat } from '../../src/playback/quality.mjs';
import { PlayerStatus } from '../../src/playback/player.mjs';
import { StreamResolver } from '../../src/playback/stream-resolver.mjs';
import { FakeMpv, playerFixture, VIDEO, SECOND, settleUntil } from './player-fixture.mjs';

const flush = () => new Promise(resolve => setImmediate(resolve));
const gate = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };

test('Quality validates strict string choices and every explicit fallback bounds height and fps', () => {
  for (const { value } of QUALITY_OPTIONS) assert.deepEqual(qualityArguments({ quality: value }), { quality: value });
  for (const quality of [undefined, null, 720, '', 'best', '1080p', '720/1080', {}, ['720']]) {
    assert.equal(qualityArguments({ quality }), null);
  }
  for (const { value } of QUALITY_OPTIONS.filter(option => option.value !== 'auto')) {
    const alternatives = qualityFormat(value).split('/');
    assert.match(alternatives[0], /^bv\*\[vcodec\^=avc1\].*\+ba\[acodec\^=mp4a\]$/);
    for (const alternative of alternatives) {
      const video = alternative.split('+')[0];
      assert.ok(video.includes(`[height<=${value}]`), alternative);
      assert.ok(video.includes('[fps<=30]'), alternative);
    }
  }
  assert.throws(() => qualityFormat('best'), /Invalid quality/);
});

test('Quality defaults to Auto, validates saved values and persists alongside other settings', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'castit-quality-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const store = new PrivateDataStore(directory);
  await store.initialize();
  const { player, instances } = playerFixture({ store });
  t.after(() => player.endSession());
  await player.initialize();
  assert.equal(player.quality.selected, 'auto');
  assert.equal(await player.setQuality('720'), true);
  assert.equal(instances.length, 0, 'idle changes do not start playback');
  await player.setSpeed(1.25);
  assert.equal(await player.setQuality(1080), false);
  const restarted = playerFixture({ store }).player;
  t.after(() => restarted.endSession());
  await restarted.initialize();
  assert.equal(restarted.quality.selected, '720');
  assert.equal(restarted.speed, 1.25);
  await store.set('settings', { quality: 'best' });
  await restarted.initialize();
  assert.equal(restarted.quality.selected, 'auto');
});

test('Playing/paused quality reloads preserve position, settings, queues and history keys', async t => {
  for (const paused of [false, true]) {
    const calls = [];
    const { player, instances } = playerFixture({ resolver: {
      resolve: async (id, options) => { calls.push({ id, ...options }); return null; },
      resolveSubtitle: async () => null,
    } });
    t.after(() => player.endSession());
    await player.play(SECOND);
    await player.play(VIDEO, 42.5);
    await player.setVolume({ level: 37, muted: true });
    await player.setSpeed(1.25);
    await player.setAudioDelay(0.12);
    await player.setSubtitles({ language: 'es' });
    if (paused) await player.pause();
    const queued = player.castQueue.add('zzzzzzzzzzz');
    const history = player.castQueue.playedSnapshot();
    const phoneQueue = player.queue.current;
    assert.equal(await player.setQuality('720'), true);
    await settleUntil(() => !player.quality.loading);
    assert.equal(player.quality.error, false);
    assert.equal(player.status, paused ? PlayerStatus.PAUSED : PlayerStatus.PLAYING);
    const mpv = instances.at(-1);
    assert.equal(instances[1].closed, true);
    assert.deepEqual(mpv.loaded, { id: VIDEO.id, position: 42.5 });
    assert.equal(Boolean(mpv.propertiesAtLoad.get('pause')), paused);
    assert.equal(mpv.propertiesAtLoad.get('ytdl-format'), qualityFormat('720'));
    assert.equal(mpv.propertiesAtLoad.get('volume'), 37);
    assert.equal(mpv.propertiesAtLoad.get('mute'), true);
    assert.equal(mpv.propertiesAtLoad.get('speed'), 1.25);
    assert.equal(mpv.propertiesAtLoad.get('audio-delay'), 0.12);
    assert.equal(player.subtitles.language, 'es');
    assert.deepEqual(player.castQueue.snapshot(), [queued]);
    assert.deepEqual(player.castQueue.playedSnapshot(), history);
    assert.strictEqual(player.queue.current, phoneQueue);
    assert.ok(calls.some(call => call.id === VIDEO.id && call.quality === '720' && call.language === 'es'));
    assert.ok(calls.some(call => call.id === queued.id && call.prefetch && call.quality === '720'));
  }
});

test('Rapid choices cancel stale resolution and keep the original paused playhead', async t => {
  const calls = [];
  const { player, instances } = playerFixture({ resolver: { resolve: async (_id, options) => {
    calls.push(options);
    if (options.quality !== '720') return null;
    await new Promise((resolve, reject) => options.signal.addEventListener('abort', () => reject(new Error('cancelled')), { once: true }));
  } } });
  t.after(() => player.endSession());
  await player.play(VIDEO, 80);
  await player.pause();
  await player.setQuality('720');
  await settleUntil(() => calls.some(call => call.quality === '720'));
  await player.setQuality('360');
  await settleUntil(() => !player.quality.loading);
  assert.equal(calls.find(call => call.quality === '720').signal.aborted, true);
  assert.equal(player.quality.selected, '360');
  assert.equal(player.quality.error, false);
  assert.equal(player.status, PlayerStatus.PAUSED);
  assert.deepEqual(instances.at(-1).loaded, { id: VIDEO.id, position: 80 });
  assert.equal(instances.at(-1).propertiesAtLoad.get('pause'), true);
});

test('Stop/new cast during saving never revives the old video', async t => {
  for (const replace of [false, true]) {
    const saved = gate();
    const { player, instances } = playerFixture({ store: { set: () => saved.promise } });
    t.after(() => player.endSession());
    await player.play(VIDEO);
    const changing = player.setQuality('480');
    if (replace) await player.play(SECOND, 9);
    else await player.stop();
    saved.resolve();
    assert.equal(await changing, true);
    await flush();
    assert.equal(player.quality.loading, false);
    assert.equal(player.video?.id ?? null, replace ? SECOND.id : null);
    assert.equal(instances.length, replace ? 2 : 1);
  }
});

test('Quality uses the latest pause state and position when persistence finishes', async t => {
  const saved = gate();
  const { player, instances } = playerFixture({ store: { set: () => saved.promise } });
  t.after(() => player.endSession());
  await player.play(VIDEO, 20);
  const changing = player.setQuality('720');
  await player.seek(24);
  await player.pause();
  saved.resolve();
  await changing;
  await settleUntil(() => !player.quality.loading);
  assert.equal(player.status, PlayerStatus.PAUSED);
  assert.deepEqual(instances.at(-1).loaded, { id: VIDEO.id, position: 24 });
});

test('Quality racing a queued replacement uses the new cast position and intended playing state', async t => {
  for (const video of [SECOND, VIDEO]) {
    const { player, instances } = playerFixture();
    t.after(() => player.endSession());
    await player.play(VIDEO, 80);
    await player.pause();
    const replacement = player.play(video, 7);
    await player.setQuality('480');
    await replacement;
    await settleUntil(() => !player.quality.loading);
    assert.deepEqual(instances.at(-1).loaded, { id: video.id, position: 7 });
    assert.equal(player.status, PlayerStatus.PLAYING);
    assert.equal(player.quality.error, false);
  }
});

test('Repeated selection while saving waits for persistence instead of acknowledging early', async t => {
  let reject;
  const saving = new Promise((_resolve, fail) => { reject = fail; });
  const { player } = playerFixture({ store: { set: () => saving } });
  t.after(() => player.endSession());
  const first = player.setQuality('720');
  let answered = false;
  const repeated = player.setQuality('720').then(result => { answered = true; return result; });
  await flush();
  assert.equal(answered, false);
  reject(new Error('disk failure'));
  assert.equal(await first, false);
  assert.equal(await repeated, false);
  assert.equal(player.quality.selected, 'auto');
});

test('Stop/new cast during a reload cancels extraction without stale status or restart', async t => {
  for (const replace of [false, true]) {
    let signal;
    let calls = 0;
    const { player, instances } = playerFixture({ resolver: { resolve: async (_id, options) => {
      if (++calls !== 2) return null;
      signal = options.signal;
      await new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(new Error('cancelled')), { once: true }));
    } } });
    t.after(() => player.endSession());
    await player.play(VIDEO);
    await player.setQuality('720');
    await settleUntil(() => signal);
    if (replace) await player.play(SECOND, 7);
    else await player.stop();
    await flush();
    assert.equal(signal.aborted, true);
    assert.equal(player.quality.loading, false);
    assert.equal(player.quality.error, false);
    assert.equal(player.video?.id ?? null, replace ? SECOND.id : null);
    assert.equal(player.status, replace ? PlayerStatus.PLAYING : PlayerStatus.STOPPED);
    assert.equal(instances[1].closed, true);
  }
});

test('A quality choice during the initial load starts and records the video exactly once', async t => {
  let signal;
  const { player } = playerFixture({ resolver: { resolve: async (_id, options) => {
    if (options.quality !== 'auto') return null;
    signal = options.signal;
    await new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(new Error('cancelled')), { once: true }));
  } } });
  t.after(() => player.endSession());
  const playing = player.play(VIDEO, 22);
  await settleUntil(() => signal);
  await player.setQuality('480');
  assert.equal(await playing, false);
  await settleUntil(() => !player.quality.loading);
  assert.equal(player.video.id, VIDEO.id);
  assert.equal(player.position, 22);
  assert.equal(player.castQueue.playedSnapshot().length, 1);
  assert.equal(player.status, PlayerStatus.PLAYING);
});

test('Persistence and reload failures report failure honestly and permit retry', async t => {
  let failSave = true;
  let failLoad = true;
  class FailingMpv extends FakeMpv {
    async load(...args) { if (failLoad) throw new Error('unavailable'); return super.load(...args); }
  }
  const { player } = playerFixture({ store: { set: async () => { if (failSave) throw new Error('disk'); } } });
  t.after(() => player.endSession());
  await player.play(VIDEO);
  await player.pause();
  assert.equal(await player.setQuality('360'), false);
  assert.equal(player.quality.selected, 'auto');
  assert.equal(player.quality.error, false, 'the rejected save did not attempt a reload');
  failSave = false;
  player.createMpv = () => new FailingMpv();
  assert.equal(await player.setQuality('360'), true);
  await settleUntil(() => !player.quality.loading);
  assert.equal(player.quality.error, true);
  assert.equal(player.status, PlayerStatus.STOPPED);
  failLoad = false;
  assert.equal(await player.setQuality('360'), true);
  await settleUntil(() => !player.quality.loading);
  assert.equal(player.quality.error, false);
  assert.equal(player.status, PlayerStatus.PAUSED);
});

test('Changing quality after an ordinary failed cast saves without starting playback', async t => {
  let loads = 0;
  class FailingMpv extends FakeMpv {
    async load() { loads++; throw new Error('unavailable'); }
  }
  const { player } = playerFixture({ createMpv: () => new FailingMpv() });
  t.after(() => player.endSession());
  assert.equal(await player.play(VIDEO), false);
  assert.equal(await player.setQuality('720'), true);
  await flush();
  assert.equal(loads, 1);
  assert.equal(player.quality.loading, false);
  assert.equal(player.quality.error, false);
  assert.equal(player.status, PlayerStatus.STOPPED);
});

test('Resolver segregates qualities and rejects oversized or unknown direct results', async () => {
  const calls = [];
  let height = 1080;
  let fps = 30;
  const resolver = new StreamResolver({ run: async argv => {
    calls.push(argv[argv.indexOf('--format') + 1]);
    return { code: 0, stdout: JSON.stringify({ id: VIDEO.id, height, fps, vcodec: 'avc1', acodec: 'mp4a',
      protocol: 'https', url: `https://media.invalid/video?expire=${Math.floor(Date.now() / 1000) + 3600}` }) };
  } });
  const full = await resolver.resolve(VIDEO.id, { quality: '1080', prefetch: true });
  assert.ok(full);
  assert.equal(await resolver.resolve(VIDEO.id, { quality: '720' }), null);
  height = 720;
  const reduced = await resolver.resolve(VIDEO.id, { quality: '720' });
  assert.ok(reduced);
  assert.strictEqual(await resolver.resolve(VIDEO.id, { quality: '1080' }), full);
  assert.strictEqual(await resolver.resolve(VIDEO.id, { quality: '720' }), reduced);
  height = undefined;
  assert.equal(await resolver.resolve(VIDEO.id, { quality: '480' }), null);
  height = 360; fps = 60;
  assert.equal(await resolver.resolve(VIDEO.id, { quality: '360' }), null);
  fps = 24;
  assert.ok(await resolver.resolve(VIDEO.id, { quality: '360' }));
  assert.deepEqual(calls, ['1080', '720', '720', '480', '360', '360'].map(qualityFormat));
});
