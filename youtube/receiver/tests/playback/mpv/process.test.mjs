import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MpvProcess } from '../../../src/playback/mpv/process.mjs';
import { playback, watchUrl } from '../../../src/config/receiver-config.mjs';

const ID = 'abcdefghijk';
const fixture = fileURLToPath(new URL('./process-fixture.mjs', import.meta.url));

async function start(t) {
  const directory = await mkdtemp(join(tmpdir(), 'mpv-test-'));
  const mpv = new MpvProcess({ runtimeDirectory: directory, spawnProcess: (command, args, options) => {
    assert.equal(command, playback.mpv);
    assert.ok(args.includes(`--ytdl-format=${playback.format}`));
    return spawn(process.execPath, [fixture, ...args], options);
  } });
  t.after(async () => { await mpv.close(); await rm(directory, { recursive: true, force: true }); });
  await mpv.start();
  return { mpv, directory };
}

test('Direct load uses mpv 0.35 per-file map, literal external audio and no ytdl hook', async t => {
  const { mpv } = await start(t);
  const stream = { videoUrl: 'https://r.googlevideo.com/video?a=b,c',
    audioUrl: 'https://r.googlevideo.com:443/audio?a=b,c&signature=x\\y',
    title: 'Title, with = punctuation', httpOptions: { 'user-agent': 'Test UA' } };
  await mpv.load(ID, 12.5, undefined, stream);
  assert.deepEqual(await mpv.command(['get_property', 'fixture-loaded']), [
    'loadfile', stream.videoUrl, 'replace', { start: '12.5', 'user-agent': 'Test UA', ytdl: 'no',
      'force-media-title': stream.title, 'audio-files-append': stream.audioUrl },
  ]);
});

test('Fallback loads the watch URL with no direct-only options', async t => {
  const { mpv } = await start(t);
  await mpv.load(ID, 3);
  assert.deepEqual(await mpv.command(['get_property', 'fixture-loaded']), [
    'loadfile', watchUrl(ID), 'replace', { start: '3' },
  ]);
});

test('Cancellation closes the process and removes the IPC directory', async t => {
  const { mpv, directory } = await start(t);
  await mpv.command(['set_property', 'fixture-action', 'hold']);
  const abort = new AbortController();
  const loading = mpv.load(ID, 0, abort.signal);
  abort.abort();
  await assert.rejects(loading, /cancelled/);
  assert.deepEqual(await readdir(directory), []);
  await assert.rejects(mpv.command(['get_property', 'fixture-loaded']), /not connected/);
});

test('mpv load errors and crashes reject and close the abandoned process', async t => {
  for (const action of ['error', 'disconnect']) {
    const { mpv, directory } = await start(t);
    await mpv.command(['set_property', 'fixture-action', action]);
    await assert.rejects(mpv.load(ID, 0), /could not load|disconnected/);
    assert.deepEqual(await readdir(directory), []);
  }
});
