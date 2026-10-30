import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, access } from 'node:fs/promises';
import { join } from 'node:path';
import { runCommand, runCommandOutput } from '../../src/host/process-command.mjs';
import { fixture, range, ID, options, finishedDownload } from './store-fixture.mjs';
import { VideoStore } from '../../src/video-store/video-store.mjs';
import { safeName, savedExtension } from '../../src/video-store/saved-library.mjs';
import { FakeMpv, playerFixture } from '../playback/player-fixture.mjs';

const ffmpeg = process.platform === 'darwin' ? '/opt/homebrew/bin/ffmpeg' : '/usr/bin/ffmpeg';
const ffprobe = process.platform === 'darwin' ? '/opt/homebrew/bin/ffprobe' : '/usr/bin/ffprobe';

test('Download fills only holes, really muxes H264/AAC, and local playback survives a restart with no extraction', async t => {
  const resources = { video: Buffer.alloc(1), audio: Buffer.alloc(1) };
  const { store, directory, root, state, disk, clock } = await fixture(t, { resources });
  const video = join(directory, 'video.mp4');
  const audio = join(directory, 'audio.m4a');
  await runCommand([ffmpeg, '-nostdin', '-loglevel', 'error', '-f', 'lavfi', '-i', 'color=size=64x64:rate=10',
    '-t', '1', '-an', '-c:v', 'libx264', video]);
  await runCommand([ffmpeg, '-nostdin', '-loglevel', 'error', '-f', 'lavfi', '-i', 'sine=frequency=440',
    '-t', '1', '-vn', '-c:a', 'aac', audio]);
  resources.video = await readFile(video);
  resources.audio = await readFile(audio);
  const abort = new AbortController();
  const stream = await store.resolve(ID, options(abort.signal));
  await range(stream.videoUrl, 100, 200);
  await range(stream.audioUrl, 0, 100);
  assert.equal(await store.download(ID), true);
  const saved = await finishedDownload(store, ID);
  assert.equal(saved.state, 'saved', saved.error);
  assert.equal(saved.progress, 1);
  assert.equal(state.resolutions.length, 1, 'current video uses the already resolved streams');
  for (const name of ['video', 'audio']) {
    assert.equal(state.requests.filter(item => item.name === name)
      .reduce((sum, item) => sum + item.end - item.start, 0), resources[name].length);
  }
  const library = await store.list();
  assert.equal(library.available, true);
  assert.deepEqual(Object.keys(library.channels[0].videos[0]).sort(), ['bytes', 'channel', 'duration', 'id', 'savedAt', 'title']);
  const local = await store.local(ID, '360');
  assert.match(local.videoUrl, /Example_channel\/A title_ safe_ \[abcdefghijk\]\.mp4$/);
  const probe = await runCommandOutput([ffprobe, '-v', 'error', '-show_entries', 'stream=codec_name', '-of', 'json', local.videoUrl]);
  assert.deepEqual(JSON.parse(probe.stdout).streams.map(stream => stream.codec_name), ['h264', 'aac']);
  const info = JSON.parse(await readFile(`${local.videoUrl}.info.json`));
  assert.equal(info.quality, 'auto');
  assert.equal(info.codecs.length, 2);
  await access(join(root, '.cache', ID));
  assert.deepEqual(await range(stream.videoUrl, 0, 100), resources.video.subarray(0, 100), 'active proxy survives promotion');
  abort.abort(); await store.release();
  await assert.rejects(access(join(root, '.cache', ID)), { code: 'ENOENT' });

  const resolver = { resolve: () => assert.fail('offline replay must not extract'),
    resolveSubtitle: () => assert.fail('offline replay must not extract captions') };
  const reopened = new VideoStore({ disk, resolver, now: clock.now });
  const mpv = new FakeMpv();
  const { player } = playerFixture({ resolver, videoStore: reopened, createMpv: () => mpv,
    room: { beforeVideo: async () => {}, afterPlayback() {}, cancelPending() {}, endSession() {} },
    handoff: async () => {}, segments: async () => { throw new Error('offline'); }, log: { info() {}, warn() {} } });
  t.after(async () => { await player.endSession(); await reopened.close(); });
  await player.initialize();
  await player.setSubtitles({ enabled: true });
  assert.equal(await player.play({ id: ID }), true);
  assert.equal(reopened.snapshot(ID).source, 'saved');
  assert.equal(player.video.title, info.title);
  await player.setSubtitles({ enabled: false });
  await player.setSubtitles({ enabled: true });
  await player.subtitlePlayback.pending;
  assert.equal(player.subtitles.error, false);
  assert.equal(await reopened.deleteSaved(ID), true);
  assert.equal((await reopened.list()).channels.length, 0);
  assert.equal(await reopened.deleteSaved(ID), false);
});

test('A real libavformat client probes and decodes media through the loopback range proxy', async t => {
  const resources = { video: Buffer.alloc(1) };
  const { store, directory, state } = await fixture(t, { resources });
  const path = join(directory, 'fixture.mp4');
  await runCommand([ffmpeg, '-nostdin', '-loglevel', 'error', '-f', 'lavfi', '-i', 'color=size=64x64:rate=10',
    '-f', 'lavfi', '-i', 'sine=frequency=440', '-t', '1', '-c:v', 'libx264', '-c:a', 'aac', path]);
  resources.video = await readFile(path);
  const stream = await store.resolve(ID, options());
  await runCommand([ffmpeg, '-nostdin', '-loglevel', 'error', '-i', stream.videoUrl, '-f', 'null', '-']);
  assert.equal(state.requests.reduce((sum, item) => sum + item.end - item.start, 0), resources.video.length);
  await store.release();
  assert.equal((await store.resolve(ID, options())).source, 'cache');
  assert.equal(state.resolutions.length, 1);
});

test('Non-playing ids download through the same machinery and failures keep cached bytes for retry', async t => {
  let muxes = 0;
  const { store, state } = await fixture(t, { run: async () => { muxes++; throw new Error('private ffmpeg text'); } });
  assert.equal(await store.download(ID), true);
  assert.equal((await finishedDownload(store, ID)).state, 'error');
  const fetched = state.requests.length;
  assert.equal(await store.download(ID), true);
  const retry = await finishedDownload(store, ID);
  assert.equal(retry.state, 'error');
  assert.match(retry.error, /retry/i);
  assert.equal(state.requests.length, fetched);
  assert.equal(state.resolutions.length, 1, 'complete retry does not extract');
  assert.equal(muxes, 2);
});

test('exFAT names cap UTF-16 lengths without splitting characters and codec policy chooses the mux container', () => {
  assert.equal(safeName('a"*/:<>?\\|\u0001. '), 'a__________');
  assert.equal(safeName('..'), 'Untitled');
  assert.equal(safeName('CON'), '_CON');
  assert.equal(safeName('x'.repeat(199) + '😀').length, 199);
  assert.equal(savedExtension([{ role: 'video', vcodec: 'avc1', acodec: 'mp4a' }]), 'mp4');
  assert.equal(savedExtension([{ role: 'video', vcodec: 'vp9', acodec: 'opus' }]), 'mkv');
});
