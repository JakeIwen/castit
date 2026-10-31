import '../config.js';

const { skipOffsets } = globalThis.VAN_TV_CONFIG;

// What a shortcut does; popup.mjs keeps one handler per kind.
export const shortcutKind = Object.freeze({
  click: 'click', seek: 'seek', seekFraction: 'seek-fraction', help: 'help',
});

// Pressing a sidebar button reuses its click handler and its disabled state.
const press = button => ({ kind: shortcutKind.click, button });
const seek = offset => ({ kind: shortcutKind.seek, offset });
const help = { kind: shortcutKind.help };

const row = (label, names, bindings) => Object.freeze({
  label, names: Object.freeze(names), bindings: Object.freeze(bindings.map(binding => Object.freeze(binding))),
});

// YouTube's player keys, as far as a remote can follow them. Each row is one
// help line. A binding matches event.key (letters ignore Caps Lock); when it
// sets `shift`, Shift must match too, so Shift+→ can skip further than →.
// `repeats` lets a held key act again on each auto-repeat.
export const keymap = Object.freeze([
  row('Play or pause', ['Space', 'K'], [
    { key: ' ', action: press('toggle') },
    { key: 'k', shift: false, action: press('toggle') },
  ]),
  row('Back or forward 5 seconds', ['←', '→'], [
    { key: 'ArrowLeft', shift: false, action: seek(-5), repeats: true },
    { key: 'ArrowRight', shift: false, action: seek(5), repeats: true },
  ]),
  row('Back or forward 10 seconds', ['J', 'L'], [
    { key: 'j', shift: false, action: seek(-10), repeats: true },
    { key: 'l', shift: false, action: seek(10), repeats: true },
  ]),
  row('Back or forward 20 seconds', ['Shift+←', 'Shift+→'], [
    { key: 'ArrowLeft', shift: true, action: seek(skipOffsets.backwardTwentySeconds), repeats: true },
    { key: 'ArrowRight', shift: true, action: seek(skipOffsets.forwardTwentySeconds), repeats: true },
  ]),
  row('Jump to 0–90% of the video', ['0–9'], Array.from({ length: 10 }, (_, digit) => (
    { key: String(digit), action: { kind: shortcutKind.seekFraction, fraction: digit / 10 } }))),
  row('Previous or next video', ['Shift+P', 'Shift+N'], [
    { key: 'p', shift: true, action: press('previous') },
    { key: 'n', shift: true, action: press('next') },
  ]),
  row('Volume down or up', ['↓', '↑'], [
    { key: 'ArrowDown', shift: false, action: press('volume-down'), repeats: true },
    { key: 'ArrowUp', shift: false, action: press('volume-up'), repeats: true },
  ]),
  row('Mute or unmute', ['M'], [{ key: 'm', shift: false, action: press('mute') }]),
  row('Slower or faster', ['<', '>'], [
    { key: '<', action: press('speed-down') },
    { key: '>', action: press('speed-up') },
  ]),
  row('Subtitles on or off', ['C'], [{ key: 'c', shift: false, action: press('subtitles') }]),
  row('Show or hide these shortcuts', ['/'], [{ key: '/', action: help }, { key: '?', action: help }]),
]);

const bindings = keymap.flatMap(entry => entry.bindings);

// Text fields and menus keep their own keys. The scrubber does not: its arrows
// seek either way, so they take the shortcut steps.
function keepsOwnKeys(target) {
  if (target?.isContentEditable) return true;
  const tag = target?.tagName;
  return tag === 'TEXTAREA' || tag === 'SELECT' || tag === 'INPUT' && target.type !== 'range';
}

// Null for keys the sidebar leaves to the browser; otherwise { action }, where
// action is null while a key that doesn't repeat is held down.
export function shortcutFor(event) {
  if (event.defaultPrevented || event.isComposing || event.ctrlKey || event.metaKey || event.altKey
    || keepsOwnKeys(event.target)) return null;
  const key = event.key?.length === 1 ? event.key.toLowerCase() : event.key;
  const binding = bindings.find(item => item.key === key
    && (item.shift === undefined || item.shift === event.shiftKey));
  if (!binding) return null;
  return { action: event.repeat && !binding.repeats ? null : binding.action };
}
