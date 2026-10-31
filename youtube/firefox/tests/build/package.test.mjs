import assert from 'node:assert/strict';
import { execFile, execFileSync, spawnSync } from 'node:child_process';
import { copyFile, cp, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { runInNewContext } from 'node:vm';
import test from 'node:test';
import '../../config.js';
import { startReceiver, videoId } from '../background/receiver-fixture.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const config = globalThis.VAN_TV_CONFIG;
const examplePath = new URL('../../../local.example.json', import.meta.url);
const execFileAsync = promisify(execFile);

async function checkout(t) {
  const workspace = await realpath(await mkdtemp(join(tmpdir(), 'castit-firefox-')));
  t.after(() => rm(workspace, { recursive: true, force: true }));
  const dir = join(workspace, 'firefox');
  // No private local.json or prior build output is present in this checkout.
  await cp(root, dir, { recursive: true, filter: path => !path.startsWith(`${root}dist`) });
  await copyFile(examplePath, join(workspace, 'local.example.json'));
  return dir;
}

function build(dir, localConfig = '../local.example.json') {
  return execFileSync('/bin/zsh', [join(dir, 'build.zsh')], {
    cwd: dir, env: { ...process.env, CASTIT_LOCAL_CONFIG: localConfig }, encoding: 'utf8',
  }).trim();
}

async function generated(dir, file) {
  return readFile(join(dir, 'dist/extension', file), 'utf8');
}

test('XPI and unpacked extension match the example config without a private local.json', async t => {
  const dir = await checkout(t);
  const example = JSON.parse(await readFile(examplePath, 'utf8')).senders;
  const output = build(dir);
  assert.equal(output, join(dir, 'dist/van-tv.xpi'));
  const files = execFileSync('/usr/bin/unzip', ['-Z1', output], { encoding: 'utf8' }).trim().split('\n');
  const manifest = JSON.parse(execFileSync('/usr/bin/unzip', ['-p', output, 'manifest.json'], { encoding: 'utf8' }));
  const template = JSON.parse(await readFile(join(root, 'manifest.template.json'), 'utf8'));
  const hosts = example.receiverUrls.map(value => {
    const url = new URL(value);
    return `${url.protocol}//${url.hostname}/*`;
  });
  template.browser_specific_settings.gecko.id = example.extensionId;
  template.permissions.push(...new Set(hosts));
  assert.deepEqual(manifest, template);
  assert.equal(manifest.manifest_version, 2);
  assert.equal(manifest.browser_action.default_popup, undefined);
  assert.equal(manifest.sidebar_action.open_at_install, false);
  assert.match(manifest.version, /^\d+\.\d+\.\d+$/);
  assert.deepEqual(manifest.content_scripts[0].matches, config.youtube.contentMatches);
  assert.deepEqual(Object.keys(manifest.commands), [config.command, config.sidebarShortcut.command]);
  assert.equal(manifest.commands[config.command].suggested_key.default, 'Alt+Shift+V');
  // commands.update can only rebind a declared command; its F13 default would fail manifest validation.
  assert.equal(manifest.commands[config.sidebarShortcut.command].suggested_key, undefined);
  const background = await generated(dir, manifest.background.page);
  const scripts = [...background.matchAll(/<script\b[^>]*src="([^"]+)"/g)].map(match => match[1]);
  assert.deepEqual(scripts, ['../local-config.js', 'main.mjs']);
  const required = [manifest.background.page, ...scripts.map(path => join(dirname(manifest.background.page), path)), manifest.sidebar_action.default_panel,
    manifest.browser_action.default_icon, ...manifest.content_scripts.flatMap(item => [...item.js, ...item.css])];
  for (const path of required) assert.ok(files.includes(path), `Packaged ${path}`);
  for (const file of files) {
    const archived = execFileSync('/usr/bin/unzip', ['-p', output, file]);
    assert.deepEqual(archived, await readFile(join(dir, 'dist/extension', file)));
  }
  const context = {};
  runInNewContext(await generated(dir, 'local-config.js'), context);
  runInNewContext(await generated(dir, 'config.js'), context);
  assert.deepEqual(JSON.parse(JSON.stringify(context.VAN_TV_CONFIG.receiverUrls)), example.receiverUrls);
  assert.deepEqual(Object.keys(context.VAN_TV_LOCAL), ['receiverUrls']);
  assert.equal(Object.isFrozen(context.VAN_TV_CONFIG.receiverUrls), true);
  assert.ok(files.includes('background/receiver-client.mjs'));
  assert.ok(files.includes('popup/queue-list.mjs'));
  assert.ok(files.includes('youtube/video-url.mjs'));
  assert.ok(files.includes('playback/diagnostics.mjs'));
  assert.ok(files.every(path => !path.startsWith('tests/') && !path.endsWith('.test.mjs')));
  for (const excluded of ['build.zsh', 'build/generate-config.mjs', 'manifest.template.json', 'README.md', 'local.json']) {
    assert.equal(files.includes(excluded), false);
  }
  assert.equal(manifest.web_accessible_resources, undefined);
});

test('generated receiver URLs drive the default client through a real local HTTP cast', async t => {
  const dir = await checkout(t);
  const fixture = await startReceiver(t);
  const example = JSON.parse(await readFile(examplePath, 'utf8'));
  example.senders.receiverUrls = [fixture.url];
  const path = join(dir, 'test-local.json');
  await writeFile(path, JSON.stringify(example));
  build(dir, path);
  await execFileAsync(process.execPath, ['--input-type=module', '-e', `
    import './dist/extension/local-config.js';
    import { createReceiverClient } from './dist/extension/background/receiver-client.mjs';
    await createReceiverClient().cast('${videoId}', 12.5);
  `], { cwd: dir });
  assert.deepEqual(fixture.requests.map(request => [request.path, request.body]), [
    ['/api/status', null], ['/api/cast', { videoId, position: 12.5 }],
  ]);
});

test('build preserves HTTPS and URL order, strips trailing slashes and deduplicates host permissions', async t => {
  const dir = await checkout(t);
  const local = JSON.parse(await readFile(examplePath, 'utf8'));
  local.senders.receiverUrls = ['https://receiver.example:9443/', 'http://localhost:8795', 'https://receiver.example:9000'];
  const path = join(dir, 'test-local.json');
  await writeFile(path, JSON.stringify(local));
  build(dir, path);
  const manifest = JSON.parse(await generated(dir, 'manifest.json'));
  assert.deepEqual(manifest.permissions, ['contextMenus', 'tabs', 'https://www.youtube.com/*',
    'https://receiver.example/*', 'http://localhost/*']);
  const context = {};
  runInNewContext(await generated(dir, 'local-config.js'), context);
  assert.deepEqual(JSON.parse(JSON.stringify(context.VAN_TV_LOCAL.receiverUrls)), [
    'https://receiver.example:9443', 'http://localhost:8795', 'https://receiver.example:9000',
  ]);
});

test('invalid sender configuration fails clearly without exposing config contents', async t => {
  const dir = await checkout(t);
  const example = JSON.parse(await readFile(examplePath, 'utf8')).senders;
  const path = join(dir, 'test-local.json');
  const cases = [
    [null, /senders.receiverUrls/],
    [{ ...example, receiverUrls: [] }, /senders.receiverUrls/],
    [{ ...example, receiverUrls: 'http://localhost' }, /senders.receiverUrls/],
    ...[null, 42, 'not-a-url', 'ftp://localhost', 'http://user:secret@localhost',
      'http://localhost?secret=value', 'http://localhost/#secret'].map(url => [
      { ...example, receiverUrls: [url] }, /senders.receiverUrls\[0\]/,
    ]),
    ...[null, 42, '', '   '].map(extensionId => [{ ...example, extensionId }, /senders.extensionId/]),
  ];
  for (const [senders, error] of cases) {
    await writeFile(path, JSON.stringify({ senders, receiver: { private: 'do-not-print' } }));
    const result = spawnSync('/bin/zsh', [join(dir, 'build.zsh')], {
      cwd: dir, env: { ...process.env, CASTIT_LOCAL_CONFIG: path }, encoding: 'utf8',
    });
    assert.equal(result.status, 1);
    assert.match(result.stderr, error);
    assert.doesNotMatch(result.stderr, /secret|do-not-print/);
    assert.equal(result.stdout, '');
  }
});

test('missing local config and malformed JSON have actionable build errors', async t => {
  const dir = await checkout(t);
  const path = join(dir, 'test-local.json');
  for (const [localConfig, error] of [['../local.json', /Missing local config:.*Copy.*local.example.json/],
    [path, /Invalid JSON in local config:/]]) {
    await writeFile(path, '{"private":"do-not-print",');
    const result = spawnSync('/bin/zsh', [join(dir, 'build.zsh')], {
      cwd: dir, env: { ...process.env, CASTIT_LOCAL_CONFIG: localConfig }, encoding: 'utf8',
    });
    assert.equal(result.status, 1);
    assert.match(result.stderr, error);
    assert.doesNotMatch(result.stderr, /do-not-print/);
  }
});
