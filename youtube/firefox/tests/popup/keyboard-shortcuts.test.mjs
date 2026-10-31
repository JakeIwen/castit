import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { keymap, shortcutFor, shortcutKind } from '../../popup/keyboard-shortcuts.mjs';

const { skipOffsets } = globalThis.VAN_TV_CONFIG;
const body = { tagName: 'BODY' };
const press = (key, fields = {}) => shortcutFor({ key, shiftKey: false, target: body, ...fields })?.action;

test('Space and K play or pause, ignoring Caps Lock but not Shift', () => {
  const toggle = { kind: shortcutKind.click, button: 'toggle' };
  assert.deepEqual(press(' '), toggle);
  assert.deepEqual(press('k'), toggle);
  assert.deepEqual(press('K'), toggle);
  assert.equal(press('K', { shiftKey: true }), undefined);
});

test('arrows skip 5 seconds, Shift+arrows the ±20 buttons\' distance, J and L 10', () => {
  const seek = offset => ({ kind: shortcutKind.seek, offset });
  assert.deepEqual(press('ArrowRight'), seek(5));
  assert.deepEqual(press('ArrowLeft'), seek(-5));
  assert.deepEqual(press('ArrowRight', { shiftKey: true }), seek(skipOffsets.forwardTwentySeconds));
  assert.deepEqual(press('ArrowLeft', { shiftKey: true }), seek(skipOffsets.backwardTwentySeconds));
  assert.deepEqual(press('l'), seek(10));
  assert.deepEqual(press('j'), seek(-10));
});

test('digits jump to tenths of the video and / or ? toggles the help', () => {
  assert.deepEqual(press('0'), { kind: shortcutKind.seekFraction, fraction: 0 });
  assert.deepEqual(press('7'), { kind: shortcutKind.seekFraction, fraction: 0.7 });
  assert.deepEqual(press('/'), { kind: shortcutKind.help });
  assert.deepEqual(press('?', { shiftKey: true }), { kind: shortcutKind.help });
  assert.deepEqual(press('N', { shiftKey: true }), { kind: shortcutKind.click, button: 'next' });
  assert.equal(press('n'), undefined);
});

test('browser shortcuts, queue reordering and handled keys pass through', () => {
  for (const modifier of ['ctrlKey', 'metaKey', 'altKey']) {
    assert.equal(shortcutFor({ key: 'ArrowUp', [modifier]: true, target: body }), null, modifier);
  }
  assert.equal(shortcutFor({ key: ' ', defaultPrevented: true, target: body }), null);
  assert.equal(shortcutFor({ key: 'x', target: body }), null);
});

test('text fields and menus keep their keys; the scrubber takes the seek steps', () => {
  assert.equal(shortcutFor({ key: 'ArrowDown', target: { tagName: 'SELECT' } }), null);
  assert.equal(shortcutFor({ key: 'k', target: { tagName: 'INPUT', type: 'text' } }), null);
  assert.equal(shortcutFor({ key: ' ', target: { tagName: 'DIV', isContentEditable: true } }), null);
  assert.deepEqual(press('ArrowRight', { target: { tagName: 'INPUT', type: 'range' } }),
    { kind: shortcutKind.seek, offset: 5 });
});

test('held seek keys repeat while a held play key is claimed without toggling again', () => {
  assert.deepEqual(press('ArrowRight', { repeat: true }), { kind: shortcutKind.seek, offset: 5 });
  assert.deepEqual(shortcutFor({ key: ' ', repeat: true, target: body }), { action: null });
});

test('every button a shortcut presses exists in the sidebar', async () => {
  const html = await readFile(new URL('../../popup/popup.html', import.meta.url), 'utf8');
  const ids = new Set([...html.matchAll(/\bid="([^"]+)"/g)].map(match => match[1]));
  const buttons = keymap.flatMap(entry => entry.bindings).map(binding => binding.action)
    .filter(action => action.kind === shortcutKind.click).map(action => action.button);
  assert.ok(buttons.length);
  for (const button of buttons) assert.ok(ids.has(button), button);
});
