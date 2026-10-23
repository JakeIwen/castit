import test from 'node:test';
import assert from 'node:assert/strict';
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { loadLocalConfig } from '../../src/config/local-config.mjs';

const example = JSON.parse(await readFile(new URL('../../../local.example.json', import.meta.url), 'utf8'));

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'castit-config-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return { directory, file: join(directory, 'local.json'), document: structuredClone(example) };
}

function importConfig(file, cwd, overrides = {}) {
  const env = { ...process.env };
  delete env.CASTIT_LOCAL_CONFIG;
  delete env.YOUTUBE_CAST_LAN_ADDRESS;
  return spawnSync(process.execPath, ['--input-type=module', '-e',
    'const {config,mpvArguments}=await import(process.argv[1]); console.log(JSON.stringify({config,args:mpvArguments("/run/test/socket")}))',
    pathToFileURL(file).href], { cwd, env: { ...env, ...overrides }, encoding: 'utf8' });
}

test('Local config accepts the public example and ignores sender settings', async t => {
  const { file, document } = await fixture(t);
  document.senders = { otherWorkerOwnsThis: true };
  await writeFile(file, JSON.stringify(document));
  assert.deepEqual(loadLocalConfig(file), example.receiver);
  const loaded = loadLocalConfig(file);
  assert.ok(Object.isFrozen(loaded));
  assert.ok(Object.isFrozen(loaded.hostnames));
});

test('Local config fails loudly on missing files, invalid JSON and non-object roots', async t => {
  const { file } = await fixture(t);
  assert.throws(() => loadLocalConfig(file), /Cannot read local config.*ENOENT/);
  await writeFile(file, '{invalid');
  assert.throws(() => loadLocalConfig(file), /Invalid JSON in local config/);
  for (const value of [null, [], 'text']) {
    await writeFile(file, JSON.stringify(value));
    assert.throws(() => loadLocalConfig(file), /Local config root must be an object/);
  }
  for (const receiver of [undefined, null, [], 'text']) {
    await writeFile(file, JSON.stringify({ receiver }));
    assert.throws(() => loadLocalConfig(file), /Local config receiver must be an object/);
  }
});

test('Local config names every missing or invalid receiver key', async t => {
  const { file } = await fixture(t);
  const cases = [
    ['sshTarget', [undefined, null, '', '-option', 'pi@host extra', 'host\n']],
    ['hostnames', [undefined, null, 'host', [null], ['http://host'], ['host:8795'], ['host/path']]],
    ['lanAddress', [undefined, null, '', 'host.example', '999.1.1.1']],
    ['audioDevice', [undefined, null, '', ' ', 42, 'bad\0device']],
    ['roomCommand', [undefined, [], {}, [''], ['command', 42], ['command', null], ['command', '\0']]],
    ['videoLibrary', [undefined, [], 'url', {}, { unit: 'player.service' }]],
  ];
  for (const [key, invalid] of cases) {
    for (const value of invalid) {
      const document = structuredClone(example);
      document.receiver[key] = value;
      await writeFile(file, JSON.stringify(document));
      assert.throws(() => loadLocalConfig(file), error => error.message.includes(`receiver.${key}`), key);
    }
  }
  for (const controlUrl of [undefined, null, 'invalid', 'file:///private', 'ftp://host/control',
    'http://user:password@host/control', 'http://host/control#fragment']) {
    await writeFile(file, JSON.stringify({ receiver: { ...example.receiver,
      videoLibrary: { controlUrl, unit: 'player.service' } } }));
    assert.throws(() => loadLocalConfig(file), /receiver\.videoLibrary\.controlUrl/);
  }
  for (const unit of [undefined, null, '', '-player.service', 'player', '../player.service',
    'player.service\n', 'player service']) {
    await writeFile(file, JSON.stringify({ receiver: { ...example.receiver,
      videoLibrary: { controlUrl: 'http://localhost:8789/api/control', unit } } }));
    assert.throws(() => loadLocalConfig(file), /receiver\.videoLibrary\.unit/);
  }
});

test('Release config requires its own local file and preserves configured playback and handoff argv', async t => {
  const { directory, file, document } = await fixture(t);
  const release = join(directory, 'release');
  await mkdir(join(release, 'src/config'), { recursive: true });
  for (const module of ['local-config.mjs', 'receiver-config.mjs']) {
    await copyFile(new URL(`../../src/config/${module}`, import.meta.url), join(release, 'src/config', module));
  }
  await mkdir(join(release, 'src/playback'), { recursive: true });
  for (const module of ['subtitles.mjs', 'quality.mjs']) {
    await copyFile(new URL(`../../src/playback/${module}`, import.meta.url), join(release, 'src/playback', module));
  }
  // A parent file must not hide a missing release-local configuration.
  await writeFile(file, JSON.stringify(document));
  const module = join(release, 'src/config/receiver-config.mjs');
  const missing = importConfig(module, directory);
  assert.notEqual(missing.status, 0);
  assert.match(missing.stderr, /Cannot read local config.*release\/local\.json.*ENOENT/);
  document.receiver = { ...document.receiver, lanAddress: '198.51.100.20',
    audioDevice: 'alsa/test-card', roomCommand: ['/usr/bin/true', ''],
    videoLibrary: { controlUrl: 'http://127.0.0.1:9999/api/control', unit: 'media-player.service' } };
  await writeFile(join(release, 'local.json'), JSON.stringify(document));
  const result = importConfig(module, directory);
  assert.equal(result.status, 0, result.stderr);
  const { config, args } = JSON.parse(result.stdout);
  assert.equal(config.lanAddress, document.receiver.lanAddress);
  assert.deepEqual(config.hostnames, document.receiver.hostnames);
  assert.deepEqual(config.roomCommand, document.receiver.roomCommand);
  assert.equal(config.videoLibraryUrl, document.receiver.videoLibrary.controlUrl);
  assert.deepEqual(config.vlcActiveCommand,
    ['/usr/bin/systemctl', '--user', 'is-active', '--quiet', document.receiver.videoLibrary.unit]);
  assert.deepEqual(config.vlcStopCommand, ['/usr/bin/systemctl', '--user', 'stop', document.receiver.videoLibrary.unit]);
  assert.ok(args.includes(`--audio-device=${document.receiver.audioDevice}`));
  assert.equal(args.filter(argument => argument.startsWith('--audio-device=')).length, 1);
  assert.ok(args.includes('--input-ipc-server=/run/test/socket'));
  assert.ok(args.some(argument => argument.endsWith(',no-write-subs=,no-write-auto-subs=')));
  for (const option of ['--hwdec=v4l2m2m-copy', '--vo=gpu', '--gpu-context=x11egl', '--opengl-es=yes', '--sid=no', '--sub-auto=no',
    '--sub-font-size=42', '--sub-border-size=2.5', '--sub-shadow-offset=1', '--sub-pos=94']) {
    assert.ok(args.includes(option), option);
  }
  assert.deepEqual(args.filter(argument => argument.startsWith('--vo=')), ['--vo=gpu']);
  assert.ok(!args.includes('--vo=xv'));
  assert.equal(config.roomCheckDelayMs, 1500);
  assert.equal(config.installDirectory, '/home/pi/youtube-cast');
  assert.equal(config.stateDirectory, '/home/pi/.local/state/youtube-cast');
  assert.deepEqual([config.dialPort, config.statusPort], [8794, 8795]);
});

test('Config honors CASTIT_LOCAL_CONFIG and the existing LAN address environment override', async t => {
  const { directory, file, document } = await fixture(t);
  await writeFile(file, JSON.stringify(document));
  const module = fileURLToPath(new URL('../../src/config/receiver-config.mjs', import.meta.url));
  const result = importConfig(module, directory,
    { CASTIT_LOCAL_CONFIG: file, YOUTUBE_CAST_LAN_ADDRESS: '198.51.100.30' });
  assert.equal(result.status, 0, result.stderr);
  const { config } = JSON.parse(result.stdout);
  assert.equal(config.lanAddress, '198.51.100.30');
  assert.equal(config.roomCommand, null);
  assert.equal(config.videoLibraryUrl, null);
  assert.equal(config.vlcActiveCommand, null);
  assert.equal(config.vlcStopCommand, null);
  const missing = importConfig(module, directory, { CASTIT_LOCAL_CONFIG: join(directory, 'missing.json') });
  assert.notEqual(missing.status, 0);
  assert.match(missing.stderr, /Cannot read local config.*missing\.json.*ENOENT/);
});
