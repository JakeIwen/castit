import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { commands, createWorkflow, createWorkflows } from '../workflow.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const examplePath = new URL('../../local.example.json', import.meta.url);
const prefix = 'is.workflow.actions.';
const id = action => action.WFWorkflowActionIdentifier.slice(prefix.length);
const params = action => action.WFWorkflowActionParameters;
const ref = action => params(action).UUID;
const inlineOutput = field => field.Value.attachmentsByRange['{0, 1}'].OutputUUID;
const workflows = () => createWorkflows('https://receiver.example:9443/van');
const fields = dictionary => Object.fromEntries(dictionary.Value.WFDictionaryFieldValueItems
  .map(item => [item.WFKey.Value.string, item.WFValue]));
const names = ['Van TV Cast', 'Van TV Queue'];

async function checkout(t) {
  const dir = await mkdtemp(join(tmpdir(), 'castit-shortcut-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await mkdir(join(dir, 'ios-shortcut'));
  for (const file of ['generate.mjs', 'workflow.mjs', 'workflow-format.mjs']) {
    await copyFile(join(root, file), join(dir, 'ios-shortcut', file));
  }
  const validator = join(dir, 'firefox/build/generate-config.mjs');
  await mkdir(dirname(validator), { recursive: true });
  await copyFile(new URL('../../firefox/build/generate-config.mjs', import.meta.url), validator);
  await copyFile(examplePath, join(dir, 'local.example.json'));
  return dir;
}

function generate(dir, configPath = join(dir, 'local.example.json')) {
  return spawnSync(process.execPath, [join(dir, 'ios-shortcut/generate.mjs')], {
    cwd: dir, env: { ...process.env, CASTIT_LOCAL_CONFIG: configPath }, encoding: 'utf8',
  });
}

function plist(path) {
  return JSON.parse(execFileSync('/usr/bin/plutil', ['-convert', 'json', '-o', '-', path], { encoding: 'utf8' }));
}

function endpoint(workflow) {
  const requests = workflow.WFWorkflowActions.filter(action => id(action) === 'downloadurl');
  assert.equal(requests.length, 1);
  return params(requests[0]).WFURL;
}

test('each command is its own share-sheet Shortcut with no menu, prompt or alert', () => {
  const list = workflows();
  assert.deepEqual(list.map(workflow => workflow.WFWorkflowName), names);
  for (const workflow of list) {
    assert.deepEqual(workflow.WFWorkflowTypes, ['ActionExtension']);
    assert.deepEqual(workflow.WFWorkflowInputContentItemClasses, ['WFURLContentItem', 'WFStringContentItem']);
    assert.equal(workflow.WFWorkflowHasShortcutInputVariables, true);
    assert.equal(workflow.WFWorkflowNoInputBehavior.Name, 'WFWorkflowNoInputBehaviorGetClipboard');
    const ids = workflow.WFWorkflowActions.map(id);
    assert.deepEqual(ids.slice(0, 3), ['detect.text', 'comment', 'downloadurl']);
    for (const dialog of ['choosefrommenu', 'ask', 'alert', 'detect.link', 'setvariable']) {
      assert.ok(!ids.includes(dialog), `${workflow.WFWorkflowName} has ${dialog}`);
    }
  }
});

test('the shared text goes straight from Shortcut Input into the POST body', () => {
  for (const [index, workflow] of workflows().entries()) {
    const [shared, , request] = workflow.WFWorkflowActions;
    assert.equal(params(shared).WFInput.Value.Type, 'ExtensionInput');
    const post = params(request);
    assert.equal(post.WFURL, `https://receiver.example:9443/van${commands[index].path}`);
    assert.equal(post.WFHTTPMethod, 'POST');
    assert.equal(post.WFHTTPBodyType, 'JSON');
    assert.deepEqual(Object.keys(fields(post.WFHTTPHeaders)), ['Content-Type']);
    assert.equal(fields(post.WFHTTPHeaders)['Content-Type'].Value.string, 'application/json');
    const body = fields(post.WFJSONValues);
    assert.equal(inlineOutput(body.url), ref(shared));
    assert.deepEqual(Object.keys(body).sort(), index === 0 ? ['url'] : ['action', 'url']);
    if (index) assert.equal(body.action.Value.string, 'add');
  }
});

test('JSON errors stop before success; cast and queue outcomes use receiver response values', () => {
  for (const workflow of workflows()) {
    const list = workflow.WFWorkflowActions;
    const index = list.findIndex(action => id(action) === 'downloadurl');
    const request = list[index];
    const error = params(list[index + 1]);
    assert.equal(error.WFDictionaryKey, 'error');
    assert.equal(error.WFInput.Value.OutputUUID, ref(request));
    assert.equal(params(list[index + 2]).WFCondition, 100);
    assert.equal(params(list[index + 2]).WFInput.Variable.Value.OutputUUID, error.UUID);
    assert.equal(inlineOutput(params(list[index + 3]).WFNotificationActionBody), error.UUID);
    assert.equal(id(list[index + 4]), 'exit');
    const result = params(list[index + 6]);
    assert.equal(result.WFInput.Value.OutputUUID, ref(request));
    assert.equal(params(list[index + 7]).WFInput.Variable.Value.OutputUUID, result.UUID);
    if (workflow.WFWorkflowName === 'Van TV Queue') {
      assert.equal(result.WFDictionaryKey, 'done');
      assert.equal(params(list[index + 8]).WFCondition, 4);
      assert.equal(params(list[index + 8]).WFNumberValue, 1);
      assert.equal(params(list[index + 9]).WFNotificationActionBody.Value.string, 'Added to the Van TV queue');
      assert.equal(params(list[index + 11]).WFNotificationActionBody.Value.string, 'The Van TV queue is full');
    } else {
      assert.equal(result.WFDictionaryKey, 'videoId');
      assert.equal(params(list[index + 8]).WFNotificationActionBody.Value.string, 'Casting on Van TV');
    }
  }
});

test('control-flow groups nest correctly and every output token refers to an earlier action', () => {
  for (const workflow of workflows()) {
    const stack = [];
    const seen = new Set();
    function checkReferences(value) {
      if (!value || typeof value !== 'object') return;
      if (value.Type === 'ActionOutput') assert.ok(seen.has(value.OutputUUID), `Unknown output ${value.OutputUUID}`);
      for (const child of Object.values(value)) checkReferences(child);
    }
    for (const action of workflow.WFWorkflowActions) {
      const p = params(action);
      checkReferences(p);
      assert.ok(!seen.has(p.UUID));
      seen.add(p.UUID);
      if (!p.GroupingIdentifier) continue;
      const group = `${id(action)}:${p.GroupingIdentifier}`;
      if (p.WFControlFlowMode === 0) stack.push(group);
      else {
        assert.equal(stack.at(-1), group);
        if (p.WFControlFlowMode === 2) stack.pop();
      }
    }
    assert.deepEqual(stack, []);
  }
});

test('clean-checkout CLI writes one plist per Shortcut from the example config and they round-trip', async t => {
  const dir = await checkout(t);
  const result = generate(dir);
  assert.equal(result.status, 0, result.stderr);
  const example = JSON.parse(await readFile(examplePath, 'utf8'));
  for (const [index, name] of names.entries()) {
    const path = join(dir, `ios-shortcut/dist/${name}.plist`);
    const workflow = plist(path);
    assert.equal(workflow.WFWorkflowName, name);
    assert.equal(endpoint(workflow), `${example.senders.receiverUrls[0]}${commands[index].path}`);
    const binary = join(dir, `${index}.unsigned.shortcut`);
    execFileSync('/usr/bin/plutil', ['-convert', 'binary1', '-o', binary, path]);
    assert.deepEqual(plist(binary), workflow);
    const xml = join(dir, `${index}.roundtrip.plist`);
    execFileSync('/usr/bin/plutil', ['-convert', 'xml1', '-o', xml, binary]);
    assert.deepEqual(plist(xml), workflow);
  }
});

test('config override selects only the normalized primary receiver, not private metadata', async t => {
  const dir = await checkout(t);
  const local = JSON.parse(await readFile(examplePath, 'utf8'));
  local.senders.receiverUrls = ['https://configured.example:9443/base/', 'http://unused.example:9876'];
  local.senders.extensionId = 'private-extension@example.invalid';
  local.receiver = { sshTarget: 'private-ssh-target', lanAddress: 'private-lan-address' };
  const path = join(dir, 'override.json');
  await writeFile(path, JSON.stringify(local));
  const result = generate(dir, path);
  assert.equal(result.status, 0, result.stderr);
  for (const [index, name] of names.entries()) {
    const workflow = plist(join(dir, `ios-shortcut/dist/${name}.plist`));
    assert.equal(endpoint(workflow), `https://configured.example:9443/base${commands[index].path}`);
    const serialized = JSON.stringify(workflow);
    for (const excluded of ['unused.example', 'private-', 'raspberrypi', '192.168.', '10.0.']) {
      assert.ok(!serialized.includes(excluded), `Output contains ${excluded}`);
    }
  }
});

test('missing, malformed and unsafe configs fail without exposing their values', async t => {
  const dir = await checkout(t);
  const path = join(dir, 'invalid.json');
  assert.match(generate(dir, path).stderr, /Missing local config/);
  await writeFile(path, '{');
  assert.match(generate(dir, path).stderr, /Invalid JSON/);
  for (const url of ['file:///private/value', 'http://private-user:private-password@receiver.example', 'http://receiver.example?private-token=secret']) {
    await writeFile(path, JSON.stringify({ senders: { receiverUrls: [url], extensionId: 'example' } }));
    const result = generate(dir, path);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /senders.receiverUrls\[0\]/);
    assert.ok(!result.stderr.includes(url));
  }
});

test('createWorkflow builds one command on its own', () => {
  const workflow = createWorkflow('https://receiver.example', commands[1]);
  assert.equal(workflow.WFWorkflowName, 'Van TV Queue');
  assert.equal(endpoint(workflow), 'https://receiver.example/api/queue');
});
