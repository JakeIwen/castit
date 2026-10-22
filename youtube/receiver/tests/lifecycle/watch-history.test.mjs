import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { Constants } from 'yt-cast-receiver';
import { runReceiver } from '../../src/lifecycle/receiver-lifecycle.mjs';
import { WatchHistory } from '../../src/history/watch-history.mjs';

// Exercise lifecycle wiring without binding configured ports or exiting the test
// process. The same public Player 'state' event drives the production observer.
test('Lifecycle status adds the sanitized watchHistory contract and observes public Player state events', async t => {
  let now = 0;
  let tick;
  let snapshot;
  const calls = [];
  const signals = new Map(['SIGINT', 'SIGTERM'].map(name => [name, process.listeners(name)]));
  const history = new WatchHistory({ now: () => now, wallNow: () => new Date('2026-01-01T00:00:00Z'),
    every: fn => { tick = fn; return 1; }, cancel: () => {}, log: { warn() {} },
    marker: {
      inspect: async () => ({ enabled: true, reason: null, version: 'fixture' }),
      mark: async id => { calls.push(id); return { enabled: true, reason: null, version: 'fixture' }; },
    },
  });
  t.after(() => {
    history.stop();
    for (const [name, before] of signals) {
      for (const listener of process.listeners(name)) {
        if (!before.includes(listener)) process.removeListener(name, listener);
      }
    }
  });
  const pairing = Object.assign(new EventEmitter(), { start() {}, stop() {} });
  const receiver = Object.assign(new EventEmitter(), {
    status: Constants.STATUSES.RUNNING,
    getPairingCodeRequestService: () => pairing,
    getConnectedSenders: () => [], start: async () => {},
  });
  const player = Object.assign(new EventEmitter(), {
    initialize: async () => {}, status: Constants.PLAYER_STATUSES.IDLE,
    video: null, position: 0, duration: 0, audioDelay: 0, speed: 1,
    volume: { level: 70, muted: false },
    castQueue: { snapshot: () => [], playedSnapshot: () => [] },
  });
  await runReceiver({ receiver, player, watchHistory: history,
    store: { initialize: async () => {} }, log: { info() {}, warn() {}, error() {} },
    statusListener: async options => { snapshot = options.snapshot; return async () => {}; },
  });
  await history.refresh();
  assert.deepEqual(snapshot().watchHistory,
    { enabled: true, state: 'ok', reason: null, lastMarkedAt: null });
  player.video = { id: 'dQw4w9WgXcQ', title: 'Fixture title not included in watch history' };
  player.status = Constants.PLAYER_STATUSES.PLAYING;
  player.emit('state', { current: { status: player.status } });
  now = 20_000;
  tick();
  await history.refresh();
  await new Promise(setImmediate);
  assert.deepEqual(calls, ['dQw4w9WgXcQ']);
  assert.deepEqual(snapshot().watchHistory, { enabled: true, state: 'ok', reason: null,
    lastMarkedAt: '2026-01-01T00:00:00.000Z' });
  assert.deepEqual(Object.keys(snapshot().watchHistory).sort(), ['enabled', 'lastMarkedAt', 'reason', 'state']);
  history.stop();
  assert.equal(player.listenerCount('state'), 0);
});
