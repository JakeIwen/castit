import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, chmod, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MeteredPermissions, METERED_CONSUMERS } from '../../src/host/metered-permissions.mjs';

async function cliFixture(t, body) {
  const directory = await mkdtemp(join(tmpdir(), 'castit-metered-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const command = join(directory, 'permission CLI');
  await writeFile(command, `#!/bin/sh\n[ "$1" = allows ] || exit 2\n${body}\n`);
  await chmod(command, 0o700);
  return command;
}

test('Admission invokes the configured CLI and only accepts exit zero for each consumer', async t => {
  const command = await cliFixture(t, '[ "$2" = pi.castit_hd ]');
  const permissions = new MeteredPermissions({ command });
  assert.equal(await permissions.allows(METERED_CONSUMERS.HD), true);
  assert.equal(await permissions.allows(METERED_CONSUMERS.SAVES), false);
  assert.equal(await permissions.allows('pi.unknown'), false);
});

test('Invalid/stale state exits, missing CLI and real subprocess timeouts fail closed', async t => {
  for (const code of [1, 2, 75]) {
    const command = await cliFixture(t, `exit ${code}`);
    assert.equal(await new MeteredPermissions({ command }).allows(METERED_CONSUMERS.HD), false);
  }
  const command = await cliFixture(t, 'sleep 10\nexit 0');
  const started = performance.now();
  assert.equal(await new MeteredPermissions({ command, timeoutMs: 100 }).allows(METERED_CONSUMERS.HD), false);
  assert.ok(performance.now() - started < 3000, 'timeout also terminates the CLI descendants');
  assert.equal(await new MeteredPermissions({ command: `${command}-missing` }).allows(METERED_CONSUMERS.HD), false);
});

test('Permission results cache per consumer, coalesce concurrent checks and expire after fifteen seconds', async () => {
  let now = 0;
  let permitted = true;
  const calls = [];
  const permissions = new MeteredPermissions({ now: () => now, run: async (argv, options) => {
    calls.push({ argv, options });
    if (!permitted) throw new Error('denied');
  } });
  assert.deepEqual(await Promise.all(Array.from({ length: 8 }, () => permissions.allows(METERED_CONSUMERS.HD))),
    Array(8).fill(true));
  assert.equal(calls.length, 1);
  assert.equal(calls[0].options.timeoutMs, 2000);
  permitted = false;
  now = 14_999;
  assert.equal(await permissions.allows(METERED_CONSUMERS.HD), true);
  assert.equal(await permissions.allows(METERED_CONSUMERS.SAVES), false, 'consumers never share admission');
  assert.equal(calls.length, 2);
  now = 15_000;
  assert.equal(await permissions.allows(METERED_CONSUMERS.HD), false);
  assert.equal(calls.length, 3);
  permitted = true;
  now = 29_999;
  assert.equal(await permissions.allows(METERED_CONSUMERS.HD), false, 'failures are cached too');
  now = 30_000;
  assert.equal(await permissions.allows(METERED_CONSUMERS.HD), true);
  assert.equal(calls.length, 4);
});
