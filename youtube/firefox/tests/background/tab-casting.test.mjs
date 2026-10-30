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

test('casting falls back to a cleaned tab title if the script or its title is unavailable', async () => {
  for (const [current, noScript] of [[null, true], [{ videoId, position: 64 }, false],
    [{ videoId, position: 64, title: '  ' }, false]]) {
    const f = fixture(current, noScript);
    await castTab(f.browser, f.receiver, tab);
    assert.deepEqual(f.requests, [['cast', videoId, noScript ? 15 : 64, 'Tab title']]);
  }
});

test('queuing uses only the cleaned tab title and never asks for or pauses page playback', async () => {
  const f = fixture(null);
  await queueTab(f.browser, f.receiver, tab);
  assert.deepEqual(f.requests, [['queue', 'add', { videoId, title: 'Tab title' }]]);
  assert.deepEqual(f.messages, []);
});
