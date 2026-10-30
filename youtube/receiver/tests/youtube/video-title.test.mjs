import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeVideoTitle, isPlaceholderTitle } from '../../src/youtube/video-title.mjs';

const ID = 'abcdefghijk';

test('Video titles strip control/format characters, collapse whitespace and cap Unicode characters', () => {
  assert.equal(normalizeVideoTitle(' \u0000Hello‮   world​ '), 'Hello world');
  assert.equal(normalizeVideoTitle('A\nB\tC'), 'ABC');
  for (const title of [undefined, null, 42, '', ' \u0000‮ ']) assert.equal(normalizeVideoTitle(title), null);
  assert.equal(normalizeVideoTitle('𐐀'.repeat(201)), '𐐀'.repeat(200));
});

test('Only id and watch-URL placeholders match; real titles are retained', () => {
  for (const title of [ID, `watch?v=${ID}`, `https://www.youtube.com/watch?v=${ID}`,
    `https://m.youtube.com/watch?v=${ID}&t=12`]) assert.equal(isPlaceholderTitle(title, ID), true, title);
  for (const title of ['Real title', 'watch?v=0123456789a', `Watching ${ID}`,
    `https://example.com/watch?v=${ID}`, `https://youtu.be/${ID}`]) {
    assert.equal(isPlaceholderTitle(title, ID), false, title);
  }
});
