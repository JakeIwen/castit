import assert from 'node:assert/strict';
import test from 'node:test';
import { SavedVideos } from '../../popup/saved-videos.mjs';
import { DownloadControl } from '../../popup/download-control.mjs';
import { createReceiverClient } from '../../background/receiver-client.mjs';
import { defaultLibrary, defaultStatus, startReceiver, videoId } from '../background/receiver-fixture.mjs';

// Minimal DOM host: the component's real event handlers and HTTP client run below.
class Element {
  constructor(tag, document) {
    Object.assign(this, { tag, ownerDocument: document, children: [], events: {}, attributes: new Map(),
      textContent: '', hidden: false, disabled: false });
  }
  append(...nodes) { for (const node of nodes) { node.parent = this; this.children.push(node); } }
  before(node) { this.parent.append(node); }
  replaceChildren(...nodes) { this.replacements = (this.replacements ?? 0) + 1; this.children = []; this.append(...nodes); }
  remove() { this.parent.children = this.parent.children.filter(node => node !== this); }
  addEventListener(name, callback) { this.events[name] = callback; }
  setAttribute(name, value) { this.attributes.set(name, String(value)); }
  getAttribute(name) { return this.attributes.get(name) ?? null; }
  querySelectorAll(tag) { return this.children.flatMap(node => [...(node.tag === tag ? [node] : []), ...node.querySelectorAll(tag)]); }
  querySelector(tag) { return this.querySelectorAll(tag)[0] ?? null; }
  focus() { this.ownerDocument.activeElement = this; }
  click() { if (!this.disabled) this.events.click?.(); }
}

function host() {
  const document = { createElement: tag => new Element(tag, document) };
  const body = document.createElement('body');
  const anchor = document.createElement('div');
  body.append(anchor);
  return { document, anchor };
}

function savedFixture(t, options) {
  const { document, anchor } = host();
  const saved = new SavedVideos({ before: anchor, ...options });
  t.after(() => saved.destroy());
  return { saved, document };
}

const tick = () => new Promise(resolve => setTimeout(resolve, 5));

async function until(check) {
  for (let i = 0; i < 500; i++) {
    if (check()) return;
    await tick();
  }
  assert.fail('The component operation did not complete');
}

test('Saved reads only on opening/explicit refresh, retains unchanged rows, and advances download labels in place', async t => {
  const fixture = await startReceiver(t);
  const receiver = createReceiverClient({ baseUrls: [fixture.url] });
  const { saved } = savedFixture(t, { load: receiver.library });
  await saved.refresh();
  assert.equal(fixture.requests.length, 0);
  saved.details.open = true;
  saved.details.events.toggle();
  await until(() => saved.structure !== undefined);
  const original = saved.content.children[1];
  const replacements = saved.content.replacements;
  await receiver.status();
  assert.equal(fixture.requests.filter(r => r.path === '/api/library').length, 1);
  await saved.refresh();
  assert.strictEqual(saved.content.children[1], original);
  assert.equal(saved.content.replacements, replacements);
  const library = { ...defaultLibrary, downloads: [{ id: videoId, title: 'Next', state: 'downloading', progress: 0.4, error: null }] };
  saved.render(library);
  const download = saved.downloads.children[0];
  saved.render({ ...library, downloads: [{ ...library.downloads[0], progress: 0.5 }] });
  assert.strictEqual(saved.downloads.children[0], download);
  assert.equal(download.textContent, 'Next · Downloading 50%');
  assert.strictEqual(saved.content.children[1], original);
});

test('Saved Play/Queue use existing HTTP paths and Delete requires confirmation with an inline Cancel', async t => {
  const fixture = await startReceiver(t);
  const receiver = createReceiverClient({ baseUrls: [fixture.url] });
  const { saved, document } = savedFixture(t, { load: receiver.library,
    act: (type, fields) => type === 'cast' ? receiver.cast(fields.videoId, fields.position, fields.title)
      : type === 'queue' ? receiver.queue(fields.action, fields) : receiver.control(fields.action, fields) });
  saved.details.open = true;
  await saved.refresh();
  const buttons = saved.content.querySelectorAll('button');
  const [play, queue, remove, confirm, cancel] = buttons;
  play.click();
  await until(() => !saved.pending);
  queue.click();
  await until(() => !saved.pending);
  remove.click();
  assert.strictEqual(document.activeElement, cancel);
  assert.equal(fixture.requests.filter(r => r.body?.action === 'delete_saved').length, 0);
  cancel.click();
  assert.strictEqual(document.activeElement, remove);
  assert.equal(fixture.requests.filter(r => r.body?.action === 'delete_saved').length, 0);
  remove.click();
  confirm.click();
  await until(() => !saved.pending);
  assert.deepEqual(fixture.requests.filter(r => r.method === 'POST').map(r => [r.path, r.body]), [
    ['/api/cast', { videoId, position: 0, title: 'A saved video' }],
    ['/api/queue', { action: 'add', videoId, title: 'A saved video' }],
    ['/api/control', { action: 'delete_saved', id: videoId }],
  ]);
  assert.equal(fixture.requests.filter(r => r.path === '/api/library').length, 4);
});

test('Saved reports unavailable/error states locally and does not allow actions while busy', async t => {
  let writes = 0;
  const { saved } = savedFixture(t, { load: async () => defaultLibrary,
    act: async () => { writes++; throw new Error('Drive absent'); } });
  saved.details.open = true;
  await saved.refresh();
  saved.setBusy(true);
  saved.content.querySelectorAll('button')[0].click();
  assert.equal(writes, 0);
  saved.setBusy(false);
  saved.content.querySelectorAll('button')[0].click();
  await until(() => !saved.pending);
  assert.equal(saved.message.textContent, 'Drive absent');
  saved.render({ available: false });
  assert.equal(saved.message.textContent, 'Saved videos unavailable.');
  assert.equal(saved.content.querySelectorAll('button').length, 0);
});

test('download control renders icons, tooltips, progress, visibility and its public click handler', () => {
  const { document } = host();
  const button = document.createElement('button');
  const icon = document.createElement('path');
  icon.setAttribute('d', 'download-path');
  button.append(icon);
  const progress = document.createElement('span');
  let clicks = 0;
  const control = new DownloadControl(button, progress, () => clicks++);
  const status = { ...defaultStatus, library: { available: true }, download: null };
  control.render(status);
  button.click();
  assert.equal(clicks, 1);
  control.render({ ...status, download: { state: 'downloading', progress: 0.42, error: null } });
  assert.equal(button.title, 'Downloading 42%');
  assert.equal(progress.textContent, '42%');
  assert.equal(button.disabled, true);
  for (const [state, label] of [['finalizing', 'Saving…'], ['saved', 'Saved'], ['error', 'Download failed: Drive full']]) {
    control.render({ ...status, download: { state, progress: null, error: 'Drive full' } });
    assert.equal(button.title, label);
    assert.notEqual(icon.getAttribute('d'), 'download-path');
  }
  control.render({ ...status, library: { available: false } });
  assert.equal(button.hidden, true);
  control.render(status);
  assert.equal(icon.getAttribute('d'), 'download-path');
});
