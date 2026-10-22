import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, chmod, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { YtdlpHistory, HISTORY_TIMEOUT_MS, inspectCookieFile,
  historyCommand, classifyHistoryResult } from '../../src/history/ytdlp-history.mjs';
import { playback } from '../../src/config/receiver-config.mjs';

const VIDEO = 'dQw4w9WgXcQ';

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'castit-history-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const file = join(directory, 'youtube-cookies.txt');
  const install = () => writeFile(file, '# Netscape HTTP Cookie File\nfixture-cookie-content', { mode: 0o600 });
  return { directory, file, install };
}

test('Cookie opt-in requires a regular, service-owned file with exactly mode 600', async t => {
  const f = await fixture(t);
  assert.deepEqual(await inspectCookieFile(f.file), { enabled: false, reason: null, version: null });
  await f.install();
  assert.equal((await inspectCookieFile(f.file)).enabled, true);
  assert.equal((await inspectCookieFile(f.file, process.getuid() + 1)).reason, 'rejected-file');
  for (const mode of [0o644, 0o400, 0o660, 0o1600]) {
    await chmod(f.file, mode);
    assert.deepEqual(await inspectCookieFile(f.file), { enabled: false, reason: 'rejected-file', version: null });
  }
  await rm(f.file);
  await mkdir(f.file, { mode: 0o600 });
  assert.equal((await inspectCookieFile(f.file)).reason, 'rejected-file');
  await rm(f.file, { recursive: true });
  const target = join(f.directory, 'target');
  await writeFile(target, 'fixture', { mode: 0o600 });
  await symlink(target, f.file);
  assert.equal((await inspectCookieFile(f.file)).reason, 'rejected-file');
});

test('History argv uses configured venv and Deno, low priorities, simulation and no cookie contents', async t => {
  const f = await fixture(t);
  await f.install();
  const calls = [];
  const history = new YtdlpHistory({ stateDirectory: f.directory, hasIonice: async () => true,
    run: async (...args) => { calls.push(args); return { code: 0, stdout: 'fixture private output', stderr: '' }; } });
  const abort = new AbortController();
  const result = await history.mark(VIDEO, { signal: abort.signal });
  assert.equal(result.enabled, true);
  assert.equal(result.reason, null);
  assert.deepEqual(calls[0][0], ['/usr/bin/nice', '-n', '19', '/usr/bin/ionice', '-c3',
    playback.ytdlp, '--ignore-config', '--no-cache-dir', '--cookies', f.file,
    '--mark-watched', '--simulate', '--no-playlist', '--js-runtimes',
    playback.ytdlpOptions.split('js-runtimes=')[1], '--', `https://www.youtube.com/watch?v=${VIDEO}`]);
  assert.deepEqual(calls[0][1], { signal: abort.signal, timeoutMs: HISTORY_TIMEOUT_MS, maxBytes: 65536 });
  assert.equal(HISTORY_TIMEOUT_MS, 120_000);
  assert.equal(JSON.stringify(calls).includes('fixture-cookie-content'), false);
  assert.equal(JSON.stringify(result).includes('fixture private output'), false);
  assert.deepEqual(historyCommand({ videoId: VIDEO, cookieFile: f.file }).slice(0, 4),
    ['/usr/bin/nice', '-n', '19', playback.ytdlp]);
});

test('Adapter refuses missing and insecure files before invoking any subprocess', async t => {
  const f = await fixture(t);
  let calls = 0;
  const history = new YtdlpHistory({ stateDirectory: f.directory, run: () => { calls++; } });
  assert.equal((await history.mark(VIDEO)).enabled, false);
  await f.install();
  await chmod(f.file, 0o644);
  assert.equal((await history.mark(VIDEO)).reason, 'rejected-file');
  assert.equal(calls, 0);
});

test('Warnings classify invalid cookies even with exit zero; unrelated failures stay generic', async () => {
  for (const text of ['The provided YouTube account cookies are no longer valid.',
    'Your cookies have expired', 'Invalid cookies', 'Sign in to confirm your age',
    'Sign-in required', 'You are not logged in']) {
    for (const stream of ['stdout', 'stderr']) {
      assert.equal(classifyHistoryResult({ code: 0, [stream]: text }), 'signed-out', text);
    }
  }
  assert.equal(classifyHistoryResult({ code: 1, stderr: 'Video unavailable' }), 'error');
  assert.equal(classifyHistoryResult({ code: 0, stderr: 'A harmless extractor warning' }), null);
});

test('Adapter contains spawn/timeout errors and preserves only the failure category', async t => {
  const f = await fixture(t);
  await f.install();
  const history = new YtdlpHistory({ stateDirectory: f.directory, hasIonice: async () => false,
    run: async () => { throw new Error('private subprocess output'); } });
  const result = await history.mark(VIDEO);
  assert.equal(result.reason, 'error');
  assert.equal(JSON.stringify(result).includes('private'), false);
  assert.throws(() => historyCommand({ videoId: '../invalid', cookieFile: f.file }), /Invalid/);
  assert.throws(() => historyCommand({ videoId: VIDEO, cookieFile: f.file, ytdlpOptions: 'no-playlist=' }), /JS runtime/);
});
