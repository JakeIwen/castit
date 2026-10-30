import test from 'node:test';
import assert from 'node:assert/strict';
import { CacheEntries } from '../../src/video-store/cache-entries.mjs';
import { RangeTransfer } from '../../src/video-store/range-transfer.mjs';
import { fixture, ID, options } from './store-fixture.mjs';

test('Cancelling a queued playback range does not wait for Download or let another range bypass its lock', async t => {
  const { disk, resolver, state } = await fixture(t);
  const entries = new CacheEntries(disk);
  const stream = await resolver.resolve(ID, options());
  const entry = await entries.attach(ID, stream, 'auto');
  const session = { entry, stream, quality: 'auto' };
  let unblock;
  let entered;
  let calls = 0;
  const gate = new Promise(resolve => { unblock = resolve; });
  const started = new Promise(resolve => { entered = resolve; });
  const transfer = new RangeTransfer(entries, resolver, { fetcher: async (...args) => {
    calls++;
    entered();
    await gate;
    return fetch(...args);
  } });
  const first = transfer.ensure(session, entry.tracks['137'], 0, 10);
  await started;
  const abort = new AbortController();
  const waiting = transfer.ensure(session, entry.tracks['137'], 5, 15, abort.signal);
  abort.abort();
  let timer;
  let third;
  try {
    await Promise.race([assert.rejects(waiting, { name: 'AbortError' }), new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('Stop waited for the independent Download')), 1000);
    })]);
    third = transfer.ensure(session, entry.tracks['137'], 5, 20);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(calls, 1, 'cancellation must retain queue ordering until its predecessor settles');
  } finally {
    clearTimeout(timer);
    unblock();
    await Promise.all([first, third]);
  }
  assert.deepEqual(state.requests.map(({ start, end }) => [start, end]), [[0, 10], [10, 20]]);
});
