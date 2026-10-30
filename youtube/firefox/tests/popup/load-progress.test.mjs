import assert from 'node:assert/strict';
import test from 'node:test';
import { isWorking, loadProgressModel } from '../../popup/state.mjs';
import { LoadProgress } from '../../popup/load-progress.mjs';

const loading = { phase: 'resolve', elapsed: 6, expected: 20 };

test('load progress labels every receiver phase and interpolates elapsed time between polls', () => {
  for (const [phase, label] of [['resolve', 'Finding the stream'], ['start', 'Starting the player'], ['buffer', 'Buffering']]) {
    assert.deepEqual(loadProgressModel({ ...loading, phase }, 1.25), {
      label: `${label} · 7 s`, percent: 36, indeterminate: false,
    });
  }
  assert.equal(loadProgressModel(null), null);
  assert.equal(loadProgressModel(undefined), null);
  assert.equal(loadProgressModel({ ...loading, phase: 'toString' }), null);
  assert.equal(loadProgressModel({ ...loading, elapsed: 0 }).percent, 0);
  assert.equal(loadProgressModel(loading, -1).label, 'Finding the stream · 6 s');
  assert.equal(isWorking({ loading }), true);
});

test('progress never claims completion and switches to indeterminate beyond the load estimate', () => {
  for (const elapsed of [19, 19.9, 20]) {
    assert.equal(loadProgressModel({ ...loading, elapsed }).percent, 95);
  }
  for (const sample of [{ ...loading, expected: null }, { ...loading, elapsed: 20.01 }]) {
    assert.equal(loadProgressModel(sample).indeterminate, true);
    assert.equal(loadProgressModel(sample).percent, null);
  }
  assert.equal(loadProgressModel(loading, 15).indeterminate, true);
});

function node(writes) {
  const attributes = new Map();
  const classes = new Set();
  return new Proxy({
    textContent: '', style: new Proxy({}, { set(target, key, value) {
      writes.push(key); target[key] = value; return true;
    } }),
    getAttribute: name => attributes.get(name) ?? null,
    hasAttribute: name => attributes.has(name),
    setAttribute(name, value) { writes.push(name); attributes.set(name, value); },
    toggleAttribute(name, enabled) {
      writes.push(name);
      if (enabled) attributes.set(name, ''); else attributes.delete(name);
    },
    classList: { contains: name => classes.has(name), toggle(name, enabled) {
      writes.push(name);
      if (enabled) classes.add(name); else classes.delete(name);
    } },
  }, { set(target, key, value) { writes.push(key); target[key] = value; return true; } });
}

function fixture() {
  const writes = [];
  const elements = Object.fromEntries(['root', 'playback', 'label', 'bar', 'fill'].map(key => [key, node(writes)]));
  const progress = new LoadProgress(elements);
  return { ...elements, progress, writes };
}

test('load progress updates accessible values without rewriting unchanged DOM', () => {
  const f = fixture();
  f.progress.update(loading, 1000);
  assert.equal(f.progress.render(1000), true);
  assert.equal(f.label.textContent, 'Finding the stream · 6 s');
  assert.equal(f.bar.getAttribute('aria-valuenow'), '30');
  assert.equal(f.bar.getAttribute('aria-valuetext'), f.label.textContent);
  assert.equal(f.fill.style.transform, 'scaleX(0.3)');
  assert.equal(f.playback.getAttribute('aria-hidden'), 'true');
  assert.equal(f.playback.classList.contains('is-loading'), true);
  f.writes.length = 0;
  f.progress.update({ ...loading }, 1000);
  f.progress.render(1000);
  assert.deepEqual(f.writes, []);
  f.progress.render(2000);
  assert.equal(f.label.textContent, 'Finding the stream · 7 s');
  assert.equal(f.bar.getAttribute('aria-valuenow'), '35');
});

test('unknown or exceeded estimates omit aria-valuenow; phase changes and completion reset the view', () => {
  const f = fixture();
  f.progress.update(loading, 1000);
  f.progress.render(1000);
  f.progress.render(16000);
  assert.equal(f.bar.hasAttribute('aria-valuenow'), false);
  assert.equal(f.bar.classList.contains('indeterminate'), true);
  f.progress.update({ phase: 'buffer', elapsed: 14, expected: null }, 16000);
  f.progress.render(16000);
  assert.equal(f.label.textContent, 'Buffering · 14 s');
  assert.equal(f.bar.hasAttribute('aria-valuenow'), false);
  f.progress.update({ phase: 'start', elapsed: 9, expected: 30 }, 17000);
  f.progress.render(17000);
  assert.equal(f.label.textContent, 'Starting the player · 9 s');
  assert.equal(f.bar.getAttribute('aria-valuenow'), '30');
  assert.equal(f.bar.classList.contains('indeterminate'), false);
  f.progress.update(null, 18000);
  assert.equal(f.progress.render(18000), false);
  assert.equal(f.root.hasAttribute('hidden'), true);
  assert.equal(f.playback.getAttribute('aria-hidden'), 'false');
  assert.equal(f.playback.classList.contains('is-loading'), false);
});
