import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync, spawn } from 'node:child_process';
import { mkdtemp, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const script = fileURLToPath(new URL('../../../firefox/push-youtube-cookies.zsh', import.meta.url));
const schema = `CREATE TABLE moz_cookies (
  id INTEGER PRIMARY KEY, originAttributes TEXT NOT NULL DEFAULT '', name TEXT,
  value TEXT, host TEXT, path TEXT, expiry INTEGER, lastAccessed INTEGER,
  creationTime INTEGER, isSecure INTEGER, isHttpOnly INTEGER, inBrowserElement INTEGER DEFAULT 0,
  sameSite INTEGER DEFAULT 0, rawSameSite INTEGER DEFAULT 0, schemeMap INTEGER DEFAULT 2);`;
const quote = value => `'${String(value).replaceAll("'", "''")}'`;
const insert = (host, name, value, { expiry = 9999999999, secure = 1, httpOnly = 1, container = '' } = {}) =>
  `INSERT INTO moz_cookies (host,name,value,path,expiry,isSecure,isHttpOnly,originAttributes)
   VALUES (${[host, name, value, '/', expiry, secure, httpOnly, container].map(quote).join(',')});`;

function sql(file, input) {
  const result = spawnSync('/usr/bin/sqlite3', [file], { input, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
}

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'castit-cookie-export-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const home = join(root, 'home');
  const temp = join(root, 'private-temp');
  const profile = join(root, 'fixture-profile');
  await Promise.all([home, temp, profile].map(path => mkdir(path, { recursive: true, mode: 0o700 })));
  const output = join(root, 'output.txt');
  const run = (...args) => spawnSync('zsh', [script, ...args, '--output', output], {
    encoding: 'utf8', env: { ...process.env, HOME: home, TMPDIR: temp,
      CASTIT_LOCAL_CONFIG: join(root, 'must-not-read-local-config.json') },
  });
  const database = join(profile, 'cookies.sqlite');
  return { root, home, temp, profile, output, run, database };
}

const session = insert('.google.com', '__Secure-3PSID', 'fixture-google-session')
  + insert('.youtube.com', 'LOGIN_INFO', 'fixture-youtube-login');

test('Mac cookie exporter syntax parses and --output privately exports only current Google/YouTube cookies', async t => {
  const syntax = spawnSync('zsh', ['-n', script], { encoding: 'utf8' });
  assert.equal(syntax.status, 0, syntax.stderr);
  const f = await fixture(t);
  sql(f.database, schema + session
    + insert('www.youtube.com', 'PREF', 'fixture-preference', { httpOnly: 0 })
    + insert('.google.com.evil.example', 'SID', 'fixture-unrelated')
    + insert('notyoutube.com', 'PREF', 'fixture-unrelated')
    + insert('.youtube.com', 'EXPIRED', 'fixture-expired', { expiry: 1 })
    + insert('.youtube.com', 'CONTAINER', 'fixture-container', { container: '^userContextId=2' }));
  const result = f.run('--profile', f.profile);
  assert.equal(result.status, 0, result.stderr);
  const exported = await readFile(f.output, 'utf8');
  assert.equal(exported, '# Netscape HTTP Cookie File\n'
    + '#HttpOnly_.google.com\tTRUE\t/\tTRUE\t9999999999\t__Secure-3PSID\tfixture-google-session\n'
    + '#HttpOnly_.youtube.com\tTRUE\t/\tTRUE\t9999999999\tLOGIN_INFO\tfixture-youtube-login\n'
    + 'www.youtube.com\tFALSE\t/\tTRUE\t9999999999\tPREF\tfixture-preference\n');
  assert.equal((await stat(f.output)).mode & 0o777, 0o600);
  assert.deepEqual(await readdir(f.temp), []);
  assert.equal(result.stdout.includes('fixture-google-session'), false);
  assert.equal(result.stderr.includes('fixture-youtube-login'), false);
  assert.match(result.stdout, /no receiver was contacted/);
});

test('Mac cookie exporter rejects signed-out, expired and malformed snapshots without replacing output', async t => {
  const f = await fixture(t);
  sql(f.database, schema + insert('.youtube.com', 'PREF', 'fixture-only-preference'));
  await writeFile(f.output, 'preserve existing destination', { mode: 0o600 });
  const signedOut = f.run('--profile', f.profile);
  assert.notEqual(signedOut.status, 0);
  assert.match(signedOut.stderr, /No signed-in session cookies/);
  assert.equal(await readFile(f.output, 'utf8'), 'preserve existing destination');
  sql(f.database, insert('.google.com', 'SID', 'fixture-expired', { expiry: 1 }));
  assert.notEqual(f.run('--profile', f.profile).status, 0);
  sql(f.database, insert('.google.com', '__Secure-3PSID', 'fixture-valid')
    + insert('.youtube.com', 'BAD', 'fixture\nunsafe'));
  const malformed = f.run('--profile', f.profile);
  assert.notEqual(malformed.status, 0);
  assert.match(malformed.stderr, /cannot be exported safely/);
  assert.equal(malformed.stderr.includes('fixture\nunsafe'), false);
  assert.deepEqual(await readdir(f.temp), []);
});

test('Mac cookie exporter selects the Install default, then falls back to a profile containing YouTube cookies', async t => {
  const f = await fixture(t);
  const firefox = join(f.home, 'Library/Application Support/Firefox');
  const first = join(firefox, 'Profiles/first');
  const preferred = join(firefox, 'Profiles/preferred');
  await mkdir(first, { recursive: true });
  await mkdir(preferred, { recursive: true });
  sql(join(first, 'cookies.sqlite'), schema + session);
  sql(join(preferred, 'cookies.sqlite'), schema + insert('.google.com', 'SID', 'fixture-preferred')
    + insert('.youtube.com', 'LOGIN_INFO', 'fixture-preferred-login'));
  await writeFile(join(firefox, 'profiles.ini'), '[Profile0]\nPath=Profiles/first\nIsRelative=1\n'
    + '[Profile1]\nPath=Profiles/preferred\nIsRelative=1\n[InstallExample]\nDefault=Profiles/preferred\n');
  assert.equal(f.run().status, 0);
  assert.match(await readFile(f.output, 'utf8'), /fixture-preferred-login/);
  sql(join(preferred, 'cookies.sqlite'), 'DELETE FROM moz_cookies;');
  assert.equal(f.run().status, 0);
  assert.match(await readFile(f.output, 'utf8'), /fixture-youtube-login/);
  assert.deepEqual(await readdir(f.temp), []);
});

test('SQLite private snapshot includes committed cookies still in an open Firefox-style WAL', async t => {
  const f = await fixture(t);
  sql(f.database, schema);
  const writer = spawn('/usr/bin/sqlite3', [f.database], { stdio: ['pipe', 'pipe', 'pipe'] });
  t.after(() => { writer.stdin.end(); writer.kill(); });
  const ready = new Promise((resolve, reject) => {
    writer.on('error', reject);
    let text = '';
    writer.stdout.on('data', data => { text += data; if (text.includes('READY')) resolve(); });
    writer.once('exit', code => reject(new Error(`SQLite writer exited early: ${code}`)));
  });
  writer.stdin.write(`PRAGMA journal_mode=WAL;\n${session}\nSELECT 'READY';\n`);
  await ready;
  assert.ok((await stat(`${f.database}-wal`)).size > 0);
  const result = f.run('--profile', f.profile);
  assert.equal(result.status, 0, result.stderr);
  assert.match(await readFile(f.output, 'utf8'), /fixture-youtube-login/);
  assert.deepEqual(await readdir(f.temp), []);
});
