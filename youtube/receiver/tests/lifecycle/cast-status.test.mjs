import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { Constants } from 'yt-cast-receiver';
import { runReceiver } from '../../src/lifecycle/receiver-lifecycle.mjs';
import { CastQueue } from '../../src/queue/cast-queue.mjs';
import { playerFixture, VIDEO, SECOND, settleUntil, quiet } from '../playback/player-fixture.mjs';

// Lifecycle's real cast callback and snapshot, without binding deployment ports.
test('Direct casts carry sender titles, enrich older senders during loading and expose current load progress', async t => {
  const signals = new Map(['SIGINT', 'SIGTERM'].map(name => [name, process.listeners(name)]));
  const pairingService = Object.assign(new EventEmitter(), { start() {}, stop() {} });
  const receiver = Object.assign(new EventEmitter(), { status: Constants.STATUSES.RUNNING,
    getPairingCodeRequestService: () => pairingService, getConnectedSenders: () => [], start: async () => {} });
  const lookups = [];
  const castQueue = new CastQueue({ lookupTitle: async id => { lookups.push(id); return 'Looked up title'; } });
  const { player } = playerFixture({ castQueue, resolver: { resolve: (_id, { signal }) =>
    new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true })) } });
  let api;
  t.after(async () => {
    api?.pairing.stop();
    await player.endSession();
    for (const [name, before] of signals) {
      for (const listener of process.listeners(name)) if (!before.includes(listener)) process.removeListener(name, listener);
    }
  });
  await runReceiver({ receiver, player, store: { initialize: async () => {} }, log: { ...quiet, info() {} },
    watchHistory: { start() {}, snapshot: () => ({}) },
    statusListener: async options => { api = options; return async () => {}; } });
  assert.equal(api.snapshot().loading, null);
  await api.cast(VIDEO.id, 12, 'Sender title');
  await settleUntil(() => player.video);
  assert.equal(api.snapshot().video.title, 'Sender title');
  assert.equal(api.snapshot().position, 12);
  assert.deepEqual(lookups, []);
  assert.equal(api.snapshot().loading.phase, 'resolve');
  await api.cast(SECOND.id, 0);
  await settleUntil(() => player.video?.id === SECOND.id);
  assert.equal(api.snapshot().video.title, 'Looked up title');
  assert.deepEqual(lookups, [SECOND.id]);
  await player.stop();
  assert.equal(api.snapshot().loading, null);
});
