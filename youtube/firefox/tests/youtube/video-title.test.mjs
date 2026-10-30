import assert from 'node:assert/strict';
import test from 'node:test';
import '../../youtube/video-title.js';

const cleanVideoTitle = globalThis.VAN_TV_CLEAN_VIDEO_TITLE;

test('titles are optional, bounded plain text with collapsed whitespace', () => {
  for (const value of [undefined, null, false, 42, {}, '', ' \n\0 ']) {
    assert.equal(cleanVideoTitle(value), undefined);
  }
  assert.equal(cleanVideoTitle('  A\nvideo\0  title  '), 'A video title');
  assert.equal(cleanVideoTitle('a'.repeat(220)), 'a'.repeat(200));
  assert.equal(cleanVideoTitle('a'.repeat(199) + ' b'), 'a'.repeat(199));
  assert.equal(cleanVideoTitle('<b>Title</b>'), '<b>Title</b>');
});

test('only page titles lose YouTube chrome and only link text loses duration-only labels', () => {
  assert.equal(cleanVideoTitle('(3) A video - YouTube', { page: true }), 'A video');
  assert.equal(cleanVideoTitle('(3) A video - YouTube'), '(3) A video - YouTube');
  for (const value of ['12:34', '1:02:03', ' 0:05 ']) {
    assert.equal(cleanVideoTitle(value, { link: true }), undefined);
  }
  assert.equal(cleanVideoTitle('12:34'), '12:34');
  assert.equal(cleanVideoTitle('12:34 A video', { link: true }), '12:34 A video');
});
