import test from 'node:test';
import assert from 'node:assert/strict';
import { realpathSync, mkdtempSync, mkdirSync, symlinkSync, existsSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
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
  symlinkSync('/usr/bin/node', join(proc, '123', 'exe'));
  writeFileSync(join(proc, '123', 'maps'), '');
  writeFileSync(join(proc, '123', 'cmdline'), 'node');
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

function protect(names, setup) {
  const { app, proc } = fixture(names);
  symlinkSync(join(app, 'releases', names[3]), join(app, 'current'));
  symlinkSync(join(app, 'releases', names[2]), join(app, 'previous'));
  mkdirSync(join(proc, '321'));
  const rel = join(app, 'releases', names[0]);
  setup(join(proc, '321'), rel);
  const r = run(app, proc);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(names.map((n) => has(app, n)), [true, false, true, true, true]);
}
const five = ['release.ddddddd1', 'release.ddddddd2', 'release.ddddddd3', 'release.ddddddd4', 'release.ddddddd5'];
// ddddddd5 is the spare (newest not linked); ddddddd1 is old and only a process uses it.
const idle = (d) => { symlinkSync('/', join(d, 'cwd')); symlinkSync('/usr/bin/node', join(d, 'exe')); writeFileSync(join(d, 'maps'), ''); writeFileSync(join(d, 'cmdline'), 'node\0'); };

test('a process using a release through exe keeps it', () =>
  protect(five, (d, rel) => { idle(d); rmSync(join(d, 'exe')); symlinkSync(join(rel, 'bin/node'), join(d, 'exe')); }));
test('a process mapping a file of a release keeps it', () =>
  protect(five, (d, rel) => { idle(d); writeFileSync(join(d, 'maps'), `7f00 r-xp 0 08:01 9 ${rel}/node_modules/x.node\n`); }));
test('a process with a release path in its command line keeps it', () =>
  protect(five, (d, rel) => { idle(d); writeFileSync(join(d, 'cmdline'), `node\0${rel}/src/index.mjs\0`); }));

test('a link into a release subdirectory protects the enclosing release', () => {
  const names = ['release.eeeeeee1', 'release.eeeeeee2', 'release.eeeeeee3', 'release.eeeeeee4'];
  const { app, proc } = fixture(names);
  mkdirSync(join(app, 'releases', names[3], 'src'));
  mkdirSync(join(app, 'releases', names[0], 'src'));
  symlinkSync(join(app, 'releases', names[3], 'src'), join(app, 'current'));
  symlinkSync(join(app, 'releases', names[0], 'src'), join(app, 'previous'));
  const r = run(app, proc);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(names.map((n) => has(app, n)), [true, false, true, true]);
});

test('prunes nothing when current points outside releases', () => {
  const names = ['release.fffffff1', 'release.fffffff2', 'release.fffffff3'];
  const { app, proc } = fixture(names);
  symlinkSync(tmpdir(), join(app, 'current'));
  symlinkSync(join(app, 'releases', names[2]), join(app, 'previous'));
  assert.equal(run(app, proc).status, 0);
  assert.deepEqual(names.map((n) => has(app, n)), [true, true, true]);
});

test('prunes nothing when current is dangling', () => {
  const names = ['release.ggggggg1', 'release.ggggggg2', 'release.ggggggg3'];
  const { app, proc } = fixture(names);
  symlinkSync(join(app, 'releases', 'release.gone0000'), join(app, 'current'));
  symlinkSync(join(app, 'releases', names[2]), join(app, 'previous'));
  assert.equal(run(app, proc).status, 0);
  assert.deepEqual(names.map((n) => has(app, n)), [true, true, true]);
});

test('prunes nothing when an own process cannot be inspected', () => {
  const names = ['release.hhhhhhh1', 'release.hhhhhhh2', 'release.hhhhhhh3', 'release.hhhhhhh4', 'release.hhhhhhh5'];
  const { app, proc } = fixture(names);
  symlinkSync(join(app, 'releases', names[3]), join(app, 'current'));
  symlinkSync(join(app, 'releases', names[2]), join(app, 'previous'));
  mkdirSync(join(proc, '99')); // no cwd/exe entries: unreadable
  const r = run(app, proc);
  assert.equal(r.status, 1);
  assert.deepEqual(names.map((n) => has(app, n)), [true, true, true, true, true]);
});
