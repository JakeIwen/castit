import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { createWorkflow } from '../workflow.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const examplePath = new URL('../../local.example.json', import.meta.url);
const prefix = 'is.workflow.actions.';
const id = action => action.WFWorkflowActionIdentifier.slice(prefix.length);
const params = action => action.WFWorkflowActionParameters;
const ref = action => params(action).UUID;
const inlineOutput = field => field.Value.attachmentsByRange['{0, 1}'].OutputUUID;
const actions = () => createWorkflow('https://receiver.example:9443/van').WFWorkflowActions;
const fields = dictionary => Object.fromEntries(dictionary.Value.WFDictionaryFieldValueItems
  .map(item => [item.WFKey.Value.string, item.WFValue]));

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

test('share input and direct clipboard/prompt converge before URL extraction and menu', () => {
  const workflow = createWorkflow('https://receiver.example');
  assert.equal(workflow.WFWorkflowName, 'Van TV');
  assert.deepEqual(workflow.WFWorkflowTypes, ['ActionExtension']);
  for (const type of ['WFURLContentItem', 'WFStringContentItem', 'WFSafariWebPageContentItem']) {
    assert.ok(workflow.WFWorkflowInputContentItemClasses.includes(type));
  }
  assert.equal(workflow.WFWorkflowHasShortcutInputVariables, true);
  const list = workflow.WFWorkflowActions;
  assert.deepEqual(list.slice(0, 14).map(id), [
    'comment', 'conditional', 'getvariable', 'conditional', 'getclipboard', 'ask', 'conditional',
    'detect.link', 'conditional', 'alert', 'exit', 'conditional', 'getitemfromlist', 'choosefrommenu',
  ]);
  assert.equal(params(list[1]).WFCondition, 100);
  assert.equal(params(list[1]).WFInput.Variable.Value.Type, 'ExtensionInput');
  assert.equal(params(list[2]).WFVariable.Value.Type, 'ExtensionInput');
  assert.equal(inlineOutput(params(list[5]).WFAskActionDefaultAnswer), ref(list[4]));
  assert.equal(params(list[7]).WFInput.Value.OutputUUID, ref(list[6]));
  assert.equal(params(list[8]).WFCondition, 101);
  assert.equal(params(list[8]).WFInput.Variable.Value.OutputUUID, ref(list[7]));
  assert.match(params(list[9]).WFAlertActionMessage, /No URL found/);
  assert.equal(params(list[12]).WFItemSpecifier, 'First Item');
  assert.equal(params(list[12]).WFInput.Value.OutputUUID, ref(list[7]));
  assert.deepEqual(params(list[13]).WFMenuItems.map(item => item.WFValue.Value.string), ['Cast', 'Add to Queue']);
});

test('each menu branch POSTs the first URL as JSON, without Origin or unrelated config', () => {
  const list = actions();
  const first = list.find(action => id(action) === 'getitemfromlist');
  const branches = list.flatMap((action, index) => id(action) === 'choosefrommenu'
    && params(action).WFControlFlowMode === 1 ? [index] : []);
  assert.equal(branches.length, 2);
  for (const [offset, index] of branches.entries()) {
    const expected = offset === 0 ? { title: 'Cast', path: '/api/cast' } : { title: 'Add to Queue', path: '/api/queue' };
    assert.equal(params(list[index]).WFMenuItemTitle, expected.title);
    assert.equal(id(list[index + 1]), 'downloadurl');
    const request = params(list[index + 1]);
    assert.equal(request.WFURL, `https://receiver.example:9443/van${expected.path}`);
    assert.equal(request.WFHTTPMethod, 'POST');
    assert.equal(request.WFHTTPBodyType, 'JSON');
    assert.deepEqual(Object.keys(fields(request.WFHTTPHeaders)), ['Content-Type']);
    assert.equal(fields(request.WFHTTPHeaders)['Content-Type'].Value.string, 'application/json');
    const body = fields(request.WFJSONValues);
    assert.equal(inlineOutput(body.url), ref(first));
    assert.deepEqual(Object.keys(body).sort(), offset === 0 ? ['url'] : ['action', 'url']);
    if (offset) assert.equal(body.action.Value.string, 'add');
  }
});

test('JSON errors stop before success; cast and queue outcomes use receiver response values', () => {
  const list = actions();
  for (const [index, request] of list.entries()) {
    if (id(request) !== 'downloadurl') continue;
    const error = params(list[index + 1]);
    assert.equal(error.WFDictionaryKey, 'error');
    assert.equal(error.WFInput.Value.OutputUUID, ref(request));
    assert.equal(params(list[index + 2]).WFCondition, 100);
    assert.equal(params(list[index + 2]).WFInput.Variable.Value.OutputUUID, error.UUID);
    assert.equal(inlineOutput(params(list[index + 3]).WFNotificationActionBody), error.UUID);
    assert.equal(id(list[index + 4]), 'exit');
    const result = params(list[index + 6]);
    assert.equal(result.WFInput.Value.OutputUUID, ref(request));
    assert.ok(['videoId', 'done'].includes(result.WFDictionaryKey));
    assert.equal(params(list[index + 7]).WFInput.Variable.Value.OutputUUID, result.UUID);
    if (result.WFDictionaryKey === 'done') {
      assert.equal(params(list[index + 8]).WFCondition, 4);
      assert.equal(params(list[index + 8]).WFNumberValue, 1);
      assert.equal(params(list[index + 9]).WFNotificationActionBody.Value.string, 'Added to the Van TV queue');
      assert.equal(params(list[index + 11]).WFNotificationActionBody.Value.string, 'The Van TV queue is full');
    } else {
      assert.equal(params(list[index + 8]).WFNotificationActionBody.Value.string, 'Casting on Van TV');
    }
  }
});

test('control-flow groups nest correctly and every output token refers to an earlier action', () => {
  const stack = [];
  const seen = new Set();
  function checkReferences(value) {
    if (!value || typeof value !== 'object') return;
    if (value.Type === 'ActionOutput') assert.ok(seen.has(value.OutputUUID), `Unknown output ${value.OutputUUID}`);
    for (const child of Object.values(value)) checkReferences(child);
  }
  for (const action of actions()) {
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
});

test('clean-checkout CLI uses example config and plist round-trips without signing', async t => {
  const dir = await checkout(t);
  const result = generate(dir);
  assert.equal(result.status, 0, result.stderr);
  const path = join(dir, 'ios-shortcut/dist/Van TV.plist');
  const workflow = plist(path);
  const example = JSON.parse(await readFile(examplePath, 'utf8'));
  const endpoints = workflow.WFWorkflowActions.filter(action => id(action) === 'downloadurl').map(action => params(action).WFURL);
  assert.deepEqual(endpoints, ['/api/cast', '/api/queue'].map(path => `${example.senders.receiverUrls[0]}${path}`));
  const binary = join(dir, 'unsigned.shortcut');
  execFileSync('/usr/bin/plutil', ['-convert', 'binary1', '-o', binary, path]);
  assert.deepEqual(plist(binary), workflow);
  const xml = join(dir, 'roundtrip.plist');
  execFileSync('/usr/bin/plutil', ['-convert', 'xml1', '-o', xml, binary]);
  assert.deepEqual(plist(xml), workflow);
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
  const workflow = plist(join(dir, 'ios-shortcut/dist/Van TV.plist'));
  const endpoints = workflow.WFWorkflowActions.filter(action => id(action) === 'downloadurl').map(action => params(action).WFURL);
  assert.deepEqual(endpoints, ['https://configured.example:9443/base/api/cast', 'https://configured.example:9443/base/api/queue']);
  const serialized = JSON.stringify(workflow);
  for (const excluded of ['unused.example', 'private-', 'raspberrypi', '192.168.', '10.0.']) {
    assert.ok(!serialized.includes(excluded), `Output contains ${excluded}`);
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
