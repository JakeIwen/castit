import assert from 'node:assert/strict';
import test from 'node:test';
import { castTab, queueTab, tabVideo } from '../../background/tab-casting.mjs';
import { videoId } from './receiver-fixture.mjs';

const tab = { id: 4, url: `https://www.youtube.com/watch?v=${videoId}&t=15`,
  title: '(3) Tab title - YouTube' };

function fixture(current, noScript = false) {
  const requests = [], messages = [];
  const browser = { tabs: { sendMessage: async (_id, message) => {
    messages.push(message);
    if (noScript) throw new Error('No content script');
    return current;
  } } };
  const receiver = {
    cast: async (...args) => requests.push(['cast', ...args]),
    queue: async (...args) => requests.push(['queue', ...args]),
  };
  return { browser, receiver, requests, messages };
}

test('casting prefers the content title, even when URL time supplies the playhead', async () => {
  for (const position of [64, null]) {
    const f = fixture({ videoId, position, title: ' Page title ' });
    assert.equal((await tabVideo(f.browser, tab)).title, 'Page title');
    await castTab(f.browser, f.receiver, tab);
    assert.deepEqual(f.requests, [['cast', videoId, position ?? 15, 'Page title']]);
    assert.equal(f.messages.at(-1).type, globalThis.VAN_TV_CONFIG.message.castAccepted);
  }
});

test('casting uses the cleaned tab title only when no content script answers', async () => {
  const f = fixture(null, true);
  await castTab(f.browser, f.receiver, tab);
  assert.deepEqual(f.requests, [['cast', videoId, 15, 'Tab title']]);
});

test('a content script without a title for this video sends none, since the tab title may be stale', async () => {
  for (const current of [{ videoId, position: 64 }, { videoId, position: 64, title: '  ' }]) {
    const f = fixture(current);
    await castTab(f.browser, f.receiver, tab);
    assert.deepEqual(f.requests, [['cast', videoId, 64, undefined]]);
  }
});

test('queuing uses only the cleaned tab title and never asks for or pauses page playback', async () => {
  const f = fixture(null);
  await queueTab(f.browser, f.receiver, tab);
  assert.deepEqual(f.requests, [['queue', 'add', { videoId, title: 'Tab title' }]]);
  assert.deepEqual(f.messages, []);
});
