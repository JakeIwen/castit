import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { config } from '../../src/config/receiver-config.mjs';

test('Service keeps extractor cache in writable private state, separate from disposable runtime', async () => {
  const unit = await readFile(new URL('../../youtube-cast.service', import.meta.url), 'utf8');
  const rows = unit.split('\n').filter(line => line.includes('=') && !line.startsWith('#'));
  const environments = Object.fromEntries(rows.filter(line => line.startsWith('Environment='))
    .map(line => line.slice('Environment='.length).split(/=(.*)/s).slice(0, 2)));
  const values = Object.fromEntries(rows.map(line => line.split(/=(.*)/s).slice(0, 2)));
  const cache = environments.XDG_CACHE_HOME;
  assert.equal(cache, join(config.stateDirectory, 'cache'));
  assert.ok(values.ReadWritePaths.split(' ').some(path => cache.startsWith(`${path}/`)));
  assert.equal(environments.TMPDIR, config.runtimeDirectory);
  assert.equal(values.RuntimeDirectoryMode, '0700');
  assert.equal(values.ProtectSystem, 'strict');
  assert.equal(values.ProtectHome, 'read-only');
  assert.equal(values.NoNewPrivileges, 'true');
  assert.equal(values.UMask, '0077');
});
