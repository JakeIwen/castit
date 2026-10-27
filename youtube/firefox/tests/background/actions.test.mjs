import assert from 'node:assert/strict';
import test from 'node:test';
import { createMessageHandler, installCommands, installContextMenus, installRemoteAction } from '../../background/actions.mjs';
import { createReceiverClient } from '../../background/receiver-client.mjs';
import { castTab, tabVideo } from '../../background/tab-casting.mjs';
import { startReceiver, videoId } from './receiver-fixture.mjs';

const config = globalThis.VAN_TV_CONFIG;
const tab = { id: 4, url: `https://www.youtube.com/watch?v=${videoId}&t=15` };

function browserFixture({ current = { videoId, position: 64 }, noScript = false,
  openSidebar = async () => {} } = {}) {
  const messages = [], menus = [], titles = [], badges = [];
  const sidebars = [];
  let onClick, onCommand, onRemoteClick, finish;
  const completed = new Promise(resolve => { finish = resolve; });
  const browserApi = {
    tabs: {
      query: async () => [tab],
      sendMessage: async (id, message) => {
        messages.push({ id, ...message });
        if (noScript) throw new Error('No content script');
        return message.type === config.message.getVideo ? current : undefined;
      },
    },
    contextMenus: {
      removeAll: async () => {}, create: menu => menus.push(menu),
      onClicked: { addListener: callback => { onClick = callback; } },
    },
    commands: { onCommand: { addListener: callback => { onCommand = callback; } } },
    sidebarAction: {
      open: () => { sidebars.push('open'); return openSidebar(); },
      toggle: () => { sidebars.push('toggle'); return Promise.resolve(); },
    },
    browserAction: {
      onClicked: { addListener: callback => { onRemoteClick = callback; } },
      setBadgeText: async value => badges.push(value.text),
      setTitle: async value => { titles.push(value.title); finish(); },
    },
  };
  return { browserApi, messages, menus, titles, badges, sidebars, completed,
    click: info => onClick(info, tab), command: name => onCommand(name), remoteClick: () => onRemoteClick() };
}

test('popup cast uses the current tab playhead and pauses only after an accepted HTTP cast', async t => {
  const fixture = await startReceiver(t);
  const browser = browserFixture();
  const receiver = createReceiverClient({ baseUrls: [fixture.url] });
  const handle = createMessageHandler(browser.browserApi, receiver);
  const result = await handle({ type: config.message.castTab }, {});
  assert.deepEqual(result, { ok: true, data: { videoId, position: 64 } });
  assert.deepEqual(browser.messages, [
    { id: tab.id, type: config.message.getVideo, url: tab.url, videoId },
    { id: tab.id, type: config.message.castAccepted, videoId, url: tab.url },
  ]);
  assert.equal(fixture.requests.find(request => request.method === 'POST').body.position, 64);
});

test('unavailable content script falls back to URL timestamp, including short links', async t => {
  const fixture = await startReceiver(t);
  const browser = browserFixture({ noScript: true });
  const receiver = createReceiverClient({ baseUrls: [fixture.url] });
  assert.deepEqual(await castTab(browser.browserApi, receiver, tab), { videoId, position: 15 });
  const shortTab = { id: 5, url: `https://youtu.be/${videoId}?t=2m` };
  assert.deepEqual(await tabVideo(browser.browserApi, shortTab), { videoId, position: 120 });
  assert.equal(await tabVideo(browser.browserApi, { url: 'https://example.test/' }), null);
});

test('a video page without a usable media playhead falls back to its URL timestamp', async () => {
  const browser = browserFixture({ current: { videoId, position: null } });
  assert.deepEqual(await tabVideo(browser.browserApi, tab), { videoId, position: 15 });
  const invalid = browserFixture({ current: { videoId, position: '90' } });
  await assert.rejects(tabVideo(invalid.browserApi, tab), /Invalid tab playback position/);
});

test('tab navigation during the playhead query refuses a stale cast', async t => {
  const fixture = await startReceiver(t);
  const browser = browserFixture({ current: null });
  const receiver = createReceiverClient({ baseUrls: [fixture.url] });
  await assert.rejects(castTab(browser.browserApi, receiver, tab), /tab changed/);
  assert.equal(fixture.requests.length, 0);
});

test('failed casts never send a pause acknowledgement', async t => {
  const fixture = await startReceiver(t, { respond(request, response) {
    if (request.method !== 'POST') return false;
    response.writeHead(400); response.end('{}'); return true;
  } });
  const browser = browserFixture();
  const receiver = createReceiverClient({ baseUrls: [fixture.url] });
  const handle = createMessageHandler(browser.browserApi, receiver);
  assert.deepEqual(await handle({ type: config.message.castTab }, {}), {
    ok: false, error: 'Van TV request failed (HTTP 400)',
  });
  assert.equal(browser.messages.some(message => message.type === config.message.castAccepted), false);
});

test('popup control messages pass seek and A/V offset fields through', async t => {
  const fixture = await startReceiver(t);
  const browser = browserFixture();
  const receiver = createReceiverClient({ baseUrls: [fixture.url] });
  const handle = createMessageHandler(browser.browserApi, receiver);
  assert.deepEqual(await handle({
    type: config.message.control, action: config.control.seek, position: 71,
  }, {}), { ok: true, data: { action: config.control.seek, done: true } });
  assert.deepEqual(await handle({
    type: config.message.control, action: config.control.seek, offset: -20,
  }, {}), { ok: true, data: { action: config.control.seek, done: true } });
  assert.deepEqual(await handle({
    type: config.message.control, action: config.control.audioDelay, delay: 0.1,
  }, {}), { ok: true, data: { action: config.control.audioDelay, done: true } });
  assert.deepEqual(fixture.requests.filter(request => request.method === 'POST')
    .map(request => request.body), [
    { action: config.control.seek, position: 71 },
    { action: config.control.seek, offset: -20 },
    { action: config.control.audioDelay, delay: 0.1 },
  ]);
});

test('video details are relayed for extension pages only', async () => {
  const lookups = [];
  const details = { details: async id => { lookups.push(id); return { videoId: id }; } };
  const handle = createMessageHandler(browserFixture().browserApi, null, details);
  assert.deepEqual(await handle({ type: config.message.videoDetails, videoId }, {}), { ok: true, data: { videoId } });
  assert.equal(handle({ type: config.message.videoDetails, videoId }, { tab }), undefined);
  assert.deepEqual(lookups, [videoId]);
});

test('unknown messages and content-script receiver controls have no side effects', async t => {
  const fixture = await startReceiver(t);
  const browser = browserFixture();
  const receiver = createReceiverClient({ baseUrls: [fixture.url] });
  const handle = createMessageHandler(browser.browserApi, receiver);
  assert.equal(handle({ type: 'toString' }, {}), undefined);
  assert.equal(handle({ type: config.message.control, action: 'stop' }, { tab }), undefined);
  assert.equal(handle({ type: config.message.control,
    action: config.control.seek, position: 20 }, { tab }), undefined);
  assert.equal(handle({ type: config.message.status }, { tab }), undefined);
  assert.equal(fixture.requests.length, 0);
  assert.deepEqual(await handle({ type: config.message.cast, videoId, position: 9 }, { tab }), {
    ok: true, data: { videoId, position: 9 },
  });
});

test('Shift-clicking the menu queues a link or the watch page from the start without touching the tab', async t => {
  const fixture = await startReceiver(t);
  const queueMenus = async (contexts, info) => {
    const browser = browserFixture();
    await installContextMenus(browser.browserApi, createReceiverClient({ baseUrls: [fixture.url] }));
    const menu = browser.menus.find(item => item.contexts.includes(contexts));
    browser.click({ menuItemId: menu.id, modifiers: ['Shift'], ...info });
    assert.deepEqual(browser.sidebars, ['open']);
    await browser.completed;
    return browser;
  };
  const link = await queueMenus('link', { linkUrl: `https://youtu.be/${videoId}?t=90` });
  const page = await queueMenus('page', {});
  assert.deepEqual(fixture.requests.filter(request => request.method === 'POST').map(request => [request.path, request.body]), [
    ['/api/queue', { action: 'add', videoId }], ['/api/queue', { action: 'add', videoId }],
  ]);
  for (const browser of [link, page]) {
    assert.equal(browser.messages.length, 0);
    assert.deepEqual(browser.titles, ['Van TV — added to the queue']);
  }
});

test('a rejected sidebar still queues the video and reports the queue result', async t => {
  t.mock.method(console, 'warn', () => {});
  const fixture = await startReceiver(t);
  const browser = browserFixture({ openSidebar: async () => { throw new Error('Sidebar unavailable'); } });
  await installContextMenus(browser.browserApi, createReceiverClient({ baseUrls: [fixture.url] }));
  browser.click({ menuItemId: 'cast-link', modifiers: ['Shift'], linkUrl: `https://youtu.be/${videoId}` });
  await browser.completed;
  assert.deepEqual(fixture.requests.filter(request => request.method === 'POST')
    .map(request => request.body), [{ action: 'add', videoId }]);
  assert.deepEqual(browser.titles, ['Van TV — added to the queue']);
});

test('a full queue shows as a toolbar error', async t => {
  const fixture = await startReceiver(t, { respond: (request, response) => {
    if (request.path !== '/api/queue') return false;
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify({ action: 'add', done: false }));
    return true;
  } });
  const browser = browserFixture();
  await installContextMenus(browser.browserApi, createReceiverClient({ baseUrls: [fixture.url] }));
  const menu = browser.menus.find(item => item.contexts.includes('link'));
  browser.click({ menuItemId: menu.id, modifiers: ['Shift'], linkUrl: `https://youtu.be/${videoId}` });
  await browser.completed;
  assert.deepEqual([browser.badges, browser.titles], [['!'], ['The Van TV queue is full']]);
});

test('the keyboard shortcut casts the active tab playhead', async t => {
  const fixture = await startReceiver(t);
  const browser = browserFixture();
  installCommands(browser.browserApi, createReceiverClient({ baseUrls: [fixture.url] }));
  browser.command(config.command);
  await browser.completed;
  assert.equal(fixture.requests.find(request => request.method === 'POST').body.position, 64);
  assert.equal(browser.messages.at(-1).type, config.message.castAccepted);
});

test('toolbar clicks toggle the full-height sidebar directly from the user gesture', () => {
  const browser = browserFixture();
  installRemoteAction(browser.browserApi);
  browser.remoteClick();
  browser.remoteClick();
  assert.deepEqual(browser.sidebars, ['toggle', 'toggle']);
});

// Firefox wraps two or more items from one extension in a submenu.
test('the context menu has one top-level item in each context', async () => {
  const browser = browserFixture();
  await installContextMenus(browser.browserApi, {});
  for (const context of ['link', 'page']) {
    assert.deepEqual(browser.menus.filter(item => item.contexts.includes(context))
      .map(item => item.title), ['Van TV: Cast Now (Shift: Add to Queue)']);
  }
  assert.ok(browser.menus.every(item => !Object.hasOwn(item, 'parentId')));
  assert.ok(browser.menus.find(item => item.contexts.includes('link')).targetUrlPatterns.includes('*://youtu.be/*'));
});

test('Cast Now on a link preserves its timestamp without pausing an unrelated tab', async t => {
  const fixture = await startReceiver(t);
  const browser = browserFixture();
  await installContextMenus(browser.browserApi, createReceiverClient({ baseUrls: [fixture.url] }));
  browser.click({ menuItemId: 'cast-link', linkUrl: `https://youtu.be/${videoId}?t=90` });
  await browser.completed;
  assert.deepEqual(fixture.requests.filter(request => request.method === 'POST')
    .map(request => [request.path, request.body]), [['/api/cast', { videoId, position: 90 }]]);
  assert.equal(browser.messages.length, 0);
  assert.deepEqual(browser.titles, ['Van TV — cast accepted']);
});

test('Cast Now on the watch page transfers the current playhead and pauses after acceptance', async t => {
  const fixture = await startReceiver(t);
  const browser = browserFixture();
  await installContextMenus(browser.browserApi, createReceiverClient({ baseUrls: [fixture.url] }));
  browser.click({ menuItemId: 'cast-page' });
  await browser.completed;
  assert.equal(fixture.requests.find(request => request.method === 'POST').body.position, 64);
  assert.equal(browser.messages.at(-1).type, config.message.castAccepted);
  assert.deepEqual(browser.titles, ['Van TV — cast accepted']);
});
test('popup move messages pass the final index and key through to HTTP', async t => {
  const fixture = await startReceiver(t);
  const handle = createMessageHandler(browserFixture().browserApi,
    createReceiverClient({ baseUrls: [fixture.url] }));
  const message = { type: config.message.queue, action: config.queue.move, key: 7, index: 0 };
  assert.equal(handle(message, { tab }), undefined);
  assert.deepEqual(await handle(message, {}), { ok: true, data: { action: 'move', done: true } });
  assert.deepEqual(fixture.requests.filter(request => request.method === 'POST')
    .map(request => [request.path, request.body]), [
    ['/api/queue', { action: 'move', key: 7, index: 0 }],
  ]);
});

test('shortcut failure is visible in the toolbar badge and hover title', async t => {
  const fixture = await startReceiver(t, { respond(request, response) {
    response.writeHead(503); response.end('{}'); return true;
  } });
  const browser = browserFixture();
  installCommands(browser.browserApi, createReceiverClient({ baseUrls: [fixture.url] }));
  browser.command(config.command);
  await browser.completed;
  assert.deepEqual(browser.badges, ['!']);
  assert.match(browser.titles[0], /receiver is not running/);
  assert.equal(browser.messages.some(message => message.type === config.message.castAccepted), false);
});
