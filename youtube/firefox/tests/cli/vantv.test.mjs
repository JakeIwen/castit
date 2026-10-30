import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { defaultLibrary, startReceiver, videoId } from '../background/receiver-fixture.mjs';

const execute = promisify(execFile);
const cli = fileURLToPath(new URL('../../../vantv.zsh', import.meta.url));
const run = (fixture, ...args) => execute('zsh', [cli, ...args], { env: { ...process.env, VAN_TV: fixture.url } });

test('vantv download defaults to the current video and accepts ids or YouTube links', async t => {
  const fixture = await startReceiver(t);
  for (const input of [[], [videoId], [`https://youtu.be/${videoId}?t=30`]]) {
    const result = await run(fixture, 'download', ...input);
    assert.match(result.stdout, /Download accepted on Van TV/);
  }
  assert.deepEqual(fixture.requests.map(request => request.body), [
    { action: 'download' }, { action: 'download', id: videoId }, { action: 'download', id: videoId },
  ]);
  await assert.rejects(run(fixture, 'download', 'invalid'), /usage: vantv/);
  await assert.rejects(run(fixture, 'download', 'https://www.youtube.com/'), /No YouTube video id found/);
  assert.equal(fixture.requests.length, 3);
});

test('vantv saved lists the receiver channel groups and video metadata', async t => {
  const fixture = await startReceiver(t);
  const result = await run(fixture, 'saved');
  assert.equal(result.stdout, `Test channel\n  A saved video [${videoId}] · 180 s · 10.0 MiB\n`);
  assert.deepEqual(fixture.requests.map(request => request.path), ['/api/library']);
});

test('vantv saved reports empty/unavailable libraries and refused downloads fail', async t => {
  for (const available of [true, false]) {
    const fixture = await startReceiver(t, { respond(request, response) {
      if (request.path !== '/api/library') return false;
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ ...defaultLibrary, available, channels: [] })); return true;
    } });
    if (available) assert.equal((await run(fixture, 'saved')).stdout, 'No saved videos.\n');
    else await assert.rejects(run(fixture, 'saved'), /Saved videos unavailable/);
  }
  const fixture = await startReceiver(t, { respond(request, response) {
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify({ action: 'download', done: false })); return true;
  } });
  await assert.rejects(run(fixture, 'download'), /could not start the download/);
});
