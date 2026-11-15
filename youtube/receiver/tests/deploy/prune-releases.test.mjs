import test from 'node:test';
import assert from 'node:assert/strict';
import { realpathSync, mkdtempSync, mkdirSync, symlinkSync, existsSync, utimesSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const script = join(dirname(fileURLToPath(import.meta.url)), '../../prune-releases.sh');

function fixture(names) {
  const app = realpathSync(mkdtempSync(join(tmpdir(), 'prune-')));
  mkdirSync(join(app, 'releases'));
  names.forEach((n, i) => {
    mkdirSync(join(app, 'releases', n));
    const t = 1_700_000_000 + i * 100; // later in the list = newer
    utimesSync(join(app, 'releases', n), t, t);
  });
  const proc = join(app, 'proc');
  mkdirSync(proc);
  return { app, proc };
}
const run = (app, proc) => spawnSync('/bin/bash', [script, app], { env: { ...process.env, PROC_DIR: proc }, encoding: 'utf8' });
const has = (app, n) => existsSync(join(app, 'releases', n));

test('keeps current, previous and the newest other; prunes the rest', () => {
  const names = ['release.aaaaaaa1', 'release.aaaaaaa2', 'release.aaaaaaa3', 'release.aaaaaaa4', 'release.aaaaaaa5', 'release.aaaaaaa6'];
  const { app, proc } = fixture(names);
  symlinkSync(join(app, 'releases', names[4]), join(app, 'current'));
  symlinkSync(join(app, 'releases', names[0]), join(app, 'previous'));
  const r = run(app, proc);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(names.map((n) => has(app, n)), [true, false, false, false, true, true]);
});

test('ignores names outside the release pattern and keeps a release a process runs in', () => {
  const names = ['release.bbbbbbb1', 'release.bbbbbbb2', 'release.bbbbbbb3', 'release.bbbbbbb4', 'release.bbbbbbb5', 'notes', 'release.short'];
  const { app, proc } = fixture(names);
  symlinkSync(join(app, 'releases', names[4]), join(app, 'current'));
  symlinkSync(join(app, 'releases', names[3]), join(app, 'previous'));
  mkdirSync(join(proc, '123'));
  symlinkSync(join(app, 'releases', names[0], 'src'), join(proc, '123', 'cwd'));
  const r = run(app, proc);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(names.map((n) => has(app, n)), [true, false, true, true, true, true, true]);
});

test('prunes nothing when no link resolves', () => {
  const names = ['release.ccccccc1', 'release.ccccccc2'];
  const { app, proc } = fixture(names);
  writeFileSync(join(app, 'current'), 'not a link');
  const r = run(app, proc);
  assert.equal(r.status, 0);
  assert.deepEqual(names.map((n) => has(app, n)), [true, true]);
});
