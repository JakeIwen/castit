import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createScrubState, formatAudioDelay, formatSpeed, formatTime, formatVolume, isWorking,
  popupState, queueDropIndex, queueListModel, queueRowKind, reorderUpcoming, transitionScrub,
} from '../../popup/state.mjs';
import { defaultStatus } from '../background/receiver-fixture.mjs';

const { player, control } = globalThis.VAN_TV_CONFIG;

const playbackActions = [
  control.previous, control.seek, control.toggle, control.next, control.stop,
];

test('elapsed time supports hours and handles unavailable or invalid values', () => {
  for (const [input, expected] of [[0, '0:00'], [65.9, '1:05'], [3661, '1:01:01'],
    [null, '—'], [-1, '—'], [Infinity, '—']]) assert.equal(formatTime(input), expected);
});

test('popup enables meaningful controls for every receiver state', () => {
  const states = [
    [player.idle, []],
    [player.loading, [control.stop]],
    [player.playing, playbackActions],
    [player.paused, playbackActions],
    [player.stopped, []],
  ];
  for (const [state, actions] of states) {
    const view = popupState({ ...defaultStatus, player: state });
    assert.deepEqual(view.actions, actions);
    assert.equal(view.state, state);
    assert.equal(view.title, defaultStatus.video.title);
    assert.equal(view.time, '0:45 / 3:00');
    assert.equal(view.scrubEnabled, [player.playing, player.paused].includes(state));
    assert.equal(view.toggleLabel, state === player.playing ? 'Pause' : 'Play');
  }
});

test('A/V offset shows signed milliseconds and is adjustable whenever the receiver reports it', () => {
  for (const [input, expected] of [[0, '0 ms'], [0.12, '+120 ms'], [-0.05, '-50 ms'],
    [-0.0001, '0 ms'], [null, '—']]) assert.equal(formatAudioDelay(input), expected);
  for (const state of Object.values(player)) {
    const view = popupState({ ...defaultStatus, player: state, video: null, audioDelay: 0.1 });
    assert.equal(view.audioDelayEnabled, true);
    assert.equal(view.audioDelayLabel, '+100 ms');
  }
  assert.equal(popupState({ ...defaultStatus, audioDelay: null }).audioDelayEnabled, false);
  assert.equal(popupState({ ...defaultStatus, ok: false, audioDelay: 0 }).audioDelayEnabled, false);
});

test('speed, volume and queue show whenever the receiver reports them', () => {
  for (const [input, expected] of [[1, '1×'], [1.25, '1.25×'], [0.5, '0.5×'], [null, '—']]) {
    assert.equal(formatSpeed(input), expected);
  }
  assert.equal(formatVolume({ level: 55, muted: false }), '55%');
  assert.equal(formatVolume({ level: 55, muted: true }), 'Muted');
  assert.equal(formatVolume(null), '—');
  const view = popupState({ ...defaultStatus, player: player.idle, video: null, speed: 1.5,
    volume: { level: 30, muted: true }, queue: [{ key: 1, id: 'dQw4w9WgXcQ', title: null }] });
  assert.deepEqual([view.speedEnabled, view.speedLabel, view.volumeEnabled, view.muted, view.queueEnabled],
    [true, '1.5×', true, true, true]);
  assert.deepEqual(view.queueList.rows, [{ kind: queueRowKind.upcoming, key: 1, id: 'dQw4w9WgXcQ', title: 'dQw4w9WgXcQ' }]);
  const older = popupState({ ...defaultStatus, video: null, speed: null, volume: null, queue: null });
  assert.deepEqual([older.speedEnabled, older.volumeEnabled, older.queueEnabled, older.queueList.rows], [false, false, false, []]);
});

test('combined queue keeps played order, marks current, and preserves upcoming IDs and stable keys', () => {
  const played = [{ key: 1, id: 'aaaaaaaaaaa', title: 'Oldest' }, { key: 2, id: 'bbbbbbbbbbb', title: null }];
  const queue = [{ key: 3, id: 'ccccccccccc', title: '' }];
  const status = { ...defaultStatus, played, queue };
  const model = queueListModel(status);
  assert.deepEqual(model, { currentId: defaultStatus.video.id, anchorIndex: 2, upcomingCount: 1, rows: [
    { kind: queueRowKind.played, key: 1, id: 'aaaaaaaaaaa', title: 'Oldest' },
    { kind: queueRowKind.played, key: 2, id: 'bbbbbbbbbbb', title: 'bbbbbbbbbbb' },
    { kind: queueRowKind.current, key: null, ...defaultStatus.video },
    { kind: queueRowKind.upcoming, key: 3, id: 'ccccccccccc', title: 'ccccccccccc' },
  ] });
  assert.deepEqual(popupState(status).queueList, model);
  assert.deepEqual(queueListModel({ played, queue, video: null }), {
    currentId: null, anchorIndex: 2, upcomingCount: 1, rows: model.rows.filter(row => row.kind !== queueRowKind.current),
  });
  assert.equal(played[1].title, null);
});

test('queue models support older receivers, current-only, played-only and entirely empty states', () => {
  assert.deepEqual(queueListModel(null), { currentId: null, anchorIndex: -1, upcomingCount: 0, rows: [] });
  assert.deepEqual(queueListModel({ queue: null, played: null }), queueListModel(null));
  const current = queueListModel(defaultStatus);
  assert.equal(current.rows.length, 1);
  assert.equal(current.rows[0].kind, queueRowKind.current);
  assert.equal(current.anchorIndex, 0);
  const history = queueListModel({ played: [{ key: 2, id: 'bbbbbbbbbbb', title: 'Earlier' }] });
  assert.equal(history.rows.length, 1);
  assert.equal(history.anchorIndex, -1);
});

test('working spans loading and any overlapping popup requests', () => {
  for (const state of Object.values(player)) {
    assert.equal(isWorking({ player: state }), state === player.loading);
    for (const requests of [1, 2, 8]) assert.equal(isWorking({ player: state }, requests), true);
  }
  assert.equal(isWorking(null, 0), false);
  assert.equal(isWorking(null, 1), true);
  assert.equal(isWorking({ player: player.loading, ok: false }, 0), true);
});

test('drop index is a final insertion index among remaining rows, clamped at each edge', () => {
  for (const [y, expected] of [[-10, 0], [19, 0], [20, 1], [40, 1], [60, 2], [300, 2]]) {
    assert.equal(queueDropIndex([20, 60], y), expected);
  }
  assert.equal(queueDropIndex([], 40), 0);
});

test('upcoming reorder is immutable, bounded, and never moves history or current', () => {
  const model = queueListModel({ ...defaultStatus,
    played: [{ key: 1, id: 'aaaaaaaaaaa', title: 'Earlier' }],
    queue: [2, 3, 4].map(key => ({ key, id: 'bbbbbbbbbbb', title: `Video ${key}` })),
  });
  const keys = value => value.rows.map(row => row.key);
  assert.deepEqual(keys(reorderUpcoming(model, 2, 2)), [1, null, 3, 4, 2]);
  assert.deepEqual(keys(reorderUpcoming(model, 4, 0)), [1, null, 4, 2, 3]);
  assert.deepEqual(keys(reorderUpcoming(model, 4, -20)), [1, null, 4, 2, 3]);
  assert.deepEqual(keys(reorderUpcoming(model, 2, 100)), [1, null, 3, 4, 2]);
  for (const [key, index] of [[1, 0], [null, 0], [9, 0], [2, -1], [4, 3], [2, NaN]]) {
    assert.strictEqual(reorderUpcoming(model, key, index), model);
  }
  assert.deepEqual(keys(model), [1, null, 2, 3, 4]);
});

test('scrubbing also requires a video with a positive duration', () => {
  for (const patch of [{ video: null }, { duration: 0 }, { ok: false }]) {
    assert.equal(popupState({ ...defaultStatus, ...patch }).scrubEnabled, false);
  }
  const offline = popupState({ ...defaultStatus, ok: false, video: null });
  assert.equal(offline.state, 'Receiver not running');
  assert.equal(offline.title, 'No video');
  assert.deepEqual(offline.actions, []);
});

test('polls do not move a dragging scrubber and release emits one absolute seek', () => {
  let state = createScrubState(45, 180);
  let transition = transitionScrub(state, { type: 'input', position: 80, duration: 180 });
  state = transition.state;
  assert.deepEqual(state, { dragging: true, position: 80 });
  assert.equal(transition.seek, null);

  const polled = transitionScrub(state, { type: 'poll', position: 50, duration: 180 });
  assert.strictEqual(polled.state, state);
  assert.equal(polled.seek, null);

  transition = transitionScrub(state, { type: 'input', position: 95, duration: 180 });
  state = transition.state;
  transition = transitionScrub(state, { type: 'change', position: 95, duration: 180 });
  assert.deepEqual(transition, {
    state: { dragging: false, position: 95 }, seek: { position: 95 },
  });

  const followed = transitionScrub(transition.state,
    { type: 'poll', position: 96, duration: 180 });
  assert.deepEqual(followed.state, { dragging: false, position: 96 });
  assert.equal(followed.seek, null);
});

test('keyboard-style change emits a clamped absolute seek without an input transition', () => {
  const transition = transitionScrub(createScrubState(45, 180),
    { type: 'change', position: 181, duration: 180 });
  assert.deepEqual(transition, {
    state: { dragging: false, position: 180 }, seek: { position: 180 },
  });
});

test('local playback advancement is pure, bounded, and paused while dragging', () => {
  const state = createScrubState(179.8, 180);
  assert.deepEqual(transitionScrub(state,
    { type: 'advance', seconds: 0.25, duration: 180 }).state,
  { dragging: false, position: 180 });
  const dragging = { dragging: true, position: 90 };
  assert.strictEqual(transitionScrub(dragging,
    { type: 'advance', seconds: 1, duration: 180 }).state, dragging);
});
