import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PrivateDataStore } from '../../src/storage/private-data-store.mjs';
import { playerFixture, FakeMpv, VIDEO, SECOND, settleUntil } from './player-fixture.mjs';

const track = language => ({ url: `https://captions.invalid/${language}.vtt`, language, automatic: false });
const selected = language => ({ videoUrl: 'https://video.invalid/video', subtitleLanguage: language,
  subtitle: track(language) });

class CaptionMpv extends FakeMpv {
  constructor() { super(); this.tracks = []; }
  async command(command) {
    await super.command(command);
    if (command[0] === 'sub-add') this.tracks.push({ id: this.tracks.length + 1,
      type: 'sub', 'external-filename': command[1] });
    if (command[0] === 'get_property' && command[1] === 'track-list') return this.tracks;
  }
}

function captions(t, resolver = { resolve: async () => null, resolveSubtitle: async (_id, { language }) => track(language) }, options = {}) {
  const instances = [];
  const fixture = playerFixture({ resolver, createMpv: () => {
    const mpv = new CaptionMpv(); instances.push(mpv); return mpv;
  }, ...options });
  t.after(() => fixture.player.endSession());
  return { ...fixture, instances };
}

test('Subtitles default off, enable English live, reuse the loaded track, and follow language across videos', async t => {
  const languages = [];
  const { player, instances } = captions(t, { resolve: async () => null,
    resolveSubtitle: async (_id, { language }) => { languages.push(language); return track(language); } });
  assert.deepEqual(player.subtitles, { enabled: false, language: 'en', available: null, loading: false, error: false });
  await player.play(VIDEO);
  assert.equal(instances[0].tracks.length, 0);
  await player.setSubtitles({ enabled: true });
  await settleUntil(() => !player.subtitles.loading);
  assert.equal(player.subtitles.available, true);
  assert.equal(instances[0].properties.get('sid'), 1);
  await player.setSubtitles({ enabled: false });
  assert.equal(instances[0].properties.get('sid'), 'no');
  await player.setSubtitles({ enabled: true });
  await settleUntil(() => !player.subtitles.loading);
  assert.equal(instances[0].tracks.length, 1);
  await player.setSubtitles({ language: 'ES' });
  await settleUntil(() => !player.subtitles.loading);
  assert.equal(instances[0].properties.get('sid'), 2);
  assert.deepEqual(languages, ['en', 'es']);
  await player.play(SECOND);
  await settleUntil(() => !player.subtitles.loading);
  assert.equal(instances[1].properties.get('sid'), 1);
  assert.deepEqual(languages, ['en', 'es', 'es']);
  await player.stop();
  assert.equal(player.subtitles.available, null);
  assert.equal(player.subtitles.enabled, true);
});

test('Saved subtitles survive a real store restart alongside other settings; invalid input cannot change them', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'castit-subtitles-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const store = new PrivateDataStore(directory);
  await store.initialize();
  const { player } = captions(t, undefined, { store });
  await player.initialize();
  await Promise.all([player.setSubtitles({ language: 'pt-BR' }), player.setAudioDelay(0.15), player.setSpeed(1.25)]);
  await player.setSubtitles({ enabled: false });
  const restored = captions(t, undefined, { store: new PrivateDataStore(directory) }).player;
  await restored.initialize();
  assert.deepEqual(restored.subtitles, { enabled: false, language: 'pt-br', available: null, loading: false, error: false });
  assert.equal(restored.audioDelay, 0.15);
  assert.equal(restored.speed, 1.25);
  for (const fields of [{}, { enabled: 'yes' }, { language: 'all' }, { language: 'ALL' },
    { language: 'en.*' }, { language: '--unsafe' }, { language: null }]) {
    assert.equal(await restored.setSubtitles(fields), false);
  }
  assert.equal(restored.subtitles.language, 'pt-br');
});

test('A direct stream supplies subtitles without re-extraction and missing tracks differ from extraction failures', async t => {
  let result = selected('en');
  const { player, instances } = captions(t, { resolve: async () => result,
    resolveSubtitle: async () => { throw new Error('signed URL must not be logged'); } });
  await player.setSubtitles({ enabled: true });
  await player.play(VIDEO);
  await settleUntil(() => !player.subtitles.loading);
  assert.equal(instances[0].properties.get('sid'), 1);
  result = { ...selected('en'), subtitle: null };
  await player.play(SECOND);
  await settleUntil(() => !player.subtitles.loading);
  assert.equal(player.subtitles.available, false);
  assert.equal(player.subtitles.error, false);
  await player.setSubtitles({ language: 'es' });
  await settleUntil(() => !player.subtitles.loading);
  assert.equal(player.subtitles.available, null);
  assert.equal(player.subtitles.error, true);
});

test('Slow caption extraction never blocks controls, and off cancels it without selecting a stale track', async t => {
  let finish;
  let signal;
  const { player, instances } = captions(t, { resolve: async () => null,
    resolveSubtitle: async (_id, options) => {
      signal = options.signal;
      return new Promise(resolve => { finish = resolve; });
    } });
  await player.play(VIDEO);
  assert.equal(await player.setSubtitles({ enabled: true }), true);
  await settleUntil(() => finish);
  assert.equal(player.subtitles.loading, true);
  await player.setSubtitles({ enabled: false });
  assert.equal(signal.aborted, true);
  finish(track('en'));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(instances[0].tracks.length, 0);
  assert.equal(instances[0].properties.get('sid'), 'no');
  assert.equal(player.subtitles.loading, false);
});

test('A setting changed during video load is applied after file-loaded, never to the old language', async t => {
  let finish;
  class SlowMpv extends CaptionMpv {
    async load(...args) { await new Promise(resolve => { finish = resolve; }); await super.load(...args); }
  }
  const mpv = new SlowMpv();
  const { player } = captions(t, { resolve: async () => selected('en'),
    resolveSubtitle: async (_id, { language }) => track(language) }, { createMpv: () => mpv });
  await player.setSubtitles({ enabled: true });
  const playing = player.play(VIDEO);
  await settleUntil(() => finish);
  await player.setSubtitles({ language: 'es' });
  assert.equal(mpv.tracks.length, 0);
  finish();
  await playing;
  await settleUntil(() => !player.subtitles.loading);
  assert.equal(mpv.tracks[0]['external-filename'], track('es').url);
});

test('Stopping or replacing playback prevents pending captions from touching the successor', async t => {
  let finish;
  const { player, instances } = captions(t, { resolve: async id => id === VIDEO.id ? null : selected('en'),
    resolveSubtitle: async () => new Promise(resolve => { finish = resolve; }) });
  await player.setSubtitles({ enabled: true });
  await player.play(VIDEO);
  await settleUntil(() => finish);
  await player.stop();
  await player.play(SECOND);
  await settleUntil(() => !player.subtitles.loading);
  finish(track('es'));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(instances[0].tracks.length, 0);
  assert.equal(instances[1].tracks.length, 1);
  assert.equal(instances[1].tracks[0]['external-filename'], track('en').url);
});

test('Turning CC off during sub-add cannot select it later and a retry reuses that track', async t => {
  let finish;
  class SlowCaptionMpv extends CaptionMpv {
    async command(command, options) {
      if (command[0] === 'sub-add') {
        assert.equal(options.asynchronous, true);
        await new Promise(resolve => { finish = resolve; });
      }
      return super.command(command);
    }
  }
  const mpv = new SlowCaptionMpv();
  const { player } = captions(t, undefined, { createMpv: () => mpv });
  await player.play(VIDEO);
  await player.setSubtitles({ enabled: true });
  await settleUntil(() => finish);
  await player.setSubtitles({ enabled: false });
  finish();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(mpv.properties.get('sid'), 'no');
  await player.setSubtitles({ enabled: true });
  await settleUntil(() => !player.subtitles.loading);
  assert.equal(mpv.tracks.length, 1);
  assert.equal(mpv.properties.get('sid'), 1);
});
