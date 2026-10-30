import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';
import test from 'node:test';

const videoId = 'dQw4w9WgXcQ';
const manifest = JSON.parse(await readFile(new URL('../../manifest.template.json', import.meta.url), 'utf8'));
const scripts = await Promise.all(manifest.content_scripts[0].js
  .map(path => readFile(new URL(`../../${path}`, import.meta.url), 'utf8')));

function page({ heading = '  Watch page title  ', title = '(3) Document title - YouTube',
  playerData = null, flexyId = videoId } = {}) {
  let listener, click, button;
  const sent = [];
  const controls = { prepend: node => { button = node; node.parentElement = controls; } };
  const video = { currentTime: 42, pause() {} };
  const context = {
    URL, location: { href: `https://www.youtube.com/watch?v=${videoId}` },
    document: {
      title, documentElement: {}, addEventListener() {},
      getElementById: id => id === 'movie_player'
        ? { wrappedJSObject: { getVideoData: () => playerData } } : button,
      querySelector: selector => selector === 'ytd-watch-flexy' ? { getAttribute: () => flexyId }
        : selector.includes('yt-formatted-string')
        ? (heading === null ? null : { textContent: heading })
        : selector === '.ytp-right-controls' ? controls : selector === '#movie_player video' ? video : null,
      createElement: () => ({ dataset: {}, setAttribute() {}, classList: { toggle() {}, remove() {} },
        addEventListener: (_name, handler) => { click = handler; } }),
    },
    browser: { runtime: {
      onMessage: { addListener: callback => { listener = callback; } },
      sendMessage: async message => { sent.push(message); return { ok: true }; },
    } },
    MutationObserver: class { observe() {} },
    requestAnimationFrame() {}, clearTimeout() {}, setTimeout() {},
  };
  for (const script of scripts) runInNewContext(script, context);
  return { context, sent, message: message => listener(message),
    click: () => click({ preventDefault() {}, stopPropagation() {} }) };
}

const plain = value => JSON.parse(JSON.stringify(value));

test('getVideo and the player button send the watch-page title with the playhead', async () => {
  const p = page();
  const selection = await p.message({ type: 'get-video', url: p.context.location.href, videoId });
  assert.deepEqual(plain(selection), { videoId, position: 42, title: 'Watch page title' });
  p.click();
  await Promise.resolve();
  assert.deepEqual(plain(p.sent), [{ type: 'cast', videoId, position: 42, title: 'Watch page title' }]);
});

test('missing or blank watch headings use the cleaned document title, and stale URLs still refuse', async () => {
  for (const heading of [null, '   ']) {
    const p = page({ heading });
    const selection = await p.message({ type: 'get-video', url: p.context.location.href, videoId });
    assert.equal(selection.title, 'Document title');
    assert.equal(await p.message({ type: 'get-video', url: 'https://www.youtube.com/watch?v=other', videoId }), null);
  }
});

test('the player API title wins when it names this video', async () => {
  const p = page({ playerData: { video_id: videoId, title: ' Player title ' } });
  const selection = await p.message({ type: 'get-video', url: p.context.location.href, videoId });
  assert.equal(selection.title, 'Player title');
});

test('titles left over from the previous video are never sent', async () => {
  const stalePlayer = page({ playerData: { video_id: 'aaaaaaaaaaa', title: 'Previous video' } });
  const selection = await stalePlayer.message({ type: 'get-video', url: stalePlayer.context.location.href, videoId });
  assert.equal(selection.title, 'Watch page title');
  const stalePage = page({ playerData: { video_id: 'aaaaaaaaaaa', title: 'Previous video' }, flexyId: 'aaaaaaaaaaa' });
  stalePage.click();
  await Promise.resolve();
  assert.deepEqual(plain(stalePage.sent), [{ type: 'cast', videoId, position: 42 }]);
});
