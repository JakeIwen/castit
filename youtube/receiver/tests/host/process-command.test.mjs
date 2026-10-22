import test from 'node:test';
import assert from 'node:assert/strict';
import { runCommand, runCommandOutput } from '../../src/host/process-command.mjs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

const node = source => [process.execPath, '-e', source];

test('Output commands capture both streams, environment and nonzero status', async () => {
  const result = await runCommandOutput(node(`
    process.stdout.write(process.env.CAPTURE_TEST);
    process.stderr.write('diagnostic');
    process.exitCode = 7;
  `), { env: { CAPTURE_TEST: 'answer' } });
  assert.deepEqual(result, { code: 7, stdout: 'answer', stderr: 'diagnostic' });
  await assert.rejects(runCommand(node('process.exit(7)')), /Command exited 7/);
  assert.equal(await runCommand(node('')), undefined);
});

test('Output capture caps each stream independently while draining large output', async () => {
  const result = await runCommandOutput(node(`
    process.stdout.write('a'.repeat(2 * 1024 * 1024));
    process.stderr.write('b'.repeat(2 * 1024 * 1024));
  `), { maxBytes: 13 });
  assert.deepEqual(result, { code: 0, stdout: 'a'.repeat(13), stderr: 'b'.repeat(13) });
});

test('Output commands reject spawn failure, timeout and cancellation', async () => {
  await assert.rejects(runCommandOutput(['/nonexistent-castit-test-command']), { code: 'ENOENT' });
  const command = node('setInterval(() => {}, 1000)');
  await assert.rejects(runCommandOutput(command, { timeoutMs: 50 }), /timeout/);
  const abort = new AbortController();
  const pending = runCommandOutput(command, { signal: abort.signal });
  abort.abort();
  await assert.rejects(pending, /cancellation/);
  await assert.rejects(runCommandOutput(command, { signal: abort.signal }), { name: 'AbortError' });
});

test('Cancellation kills TERM-resistant descendants after their parent exits', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'castit-command-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const pidFile = join(directory, 'pid');
  const child = `process.on('SIGTERM', () => {});
    require('node:fs').writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));
    setInterval(() => {}, 1000);`;
  const parent = `const { spawn } = require('node:child_process');
    spawn(process.execPath, ['-e', ${JSON.stringify(child)}], { stdio: 'inherit' });
    process.on('SIGTERM', () => process.exit(0));
    setInterval(() => {}, 1000);`;
  const abort = new AbortController();
  const pending = runCommandOutput(node(parent), { signal: abort.signal });
  const rejected = assert.rejects(pending, /cancellation/);
  let pid;
  for (let attempt = 0; attempt < 100; attempt++) {
    try { pid = Number(await readFile(pidFile, 'utf8')); break; }
    catch (error) { if (error.code !== 'ENOENT') throw error; await delay(10); }
  }
  abort.abort();
  await rejected;
  assert.ok(pid > 0, 'descendant started before cancellation');
  for (let attempt = 0; attempt < 100; attempt++) {
    try { process.kill(pid, 0); }
    catch (error) { assert.equal(error.code, 'ESRCH'); return; }
    await delay(10);
  }
  assert.fail('descendant survived cancellation');
});
