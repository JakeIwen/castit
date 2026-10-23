import test from 'node:test';
import assert from 'node:assert/strict';
import { QueuePrefetch } from '../../src/playback/queue-prefetch.mjs';
import { playback } from '../../src/config/receiver-config.mjs';

const flush = () => new Promise(resolve => setImmediate(resolve));

test('Prefetch notices mid-play queue changes and never overlaps extractions', async t => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  const calls = [];
  const entries = [];
  let finish;
  const prefetch = new QueuePrefetch({ resolve: async (id, options) => {
    calls.push({ id, options });
    await new Promise(resolve => { finish = resolve; });
  } }, () => entries.map(entry => ({ ...entry })));
  const abort = new AbortController();
  prefetch.start(abort.signal);
  assert.equal(calls.length, 0);
  entries.push({ id: 'abcdefghijk' });
  t.mock.timers.tick(playback.prefetchIntervalMs);
  assert.equal(calls.length, 1);
  entries[0] = { id: '0123456789a' };
  t.mock.timers.tick(playback.prefetchIntervalMs * 3);
  assert.equal(calls.length, 1);
  finish(); await flush();
  t.mock.timers.tick(playback.prefetchIntervalMs);
  assert.equal(calls[1].id, '0123456789a');
  assert.equal(calls[1].options.prefetch, true);
  finish(); await flush();
  t.mock.timers.tick(playback.prefetchIntervalMs * 3);
  assert.equal(calls.length, 2, 'do not repeatedly prefetch the same head');
  await prefetch.stop();
  entries[0] = { id: 'zzzzzzzzzzz' };
  t.mock.timers.tick(playback.prefetchIntervalMs);
  assert.equal(calls.length, 2);
});

test('Aborting a playback cancels the only prefetch and clears its timer', async t => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  let calls = 0;
  let cancelled = false;
  const prefetch = new QueuePrefetch({ resolve: async (_id, { signal }) => {
    calls++;
    await new Promise((resolve, reject) => signal.addEventListener('abort', () => {
      cancelled = true; reject(new Error('cancelled'));
    }, { once: true }));
  } }, () => [{ id: 'abcdefghijk' }]);
  const abort = new AbortController();
  prefetch.start(abort.signal);
  abort.abort();
  await prefetch.stop();
  t.mock.timers.tick(playback.prefetchIntervalMs * 3);
  assert.equal(cancelled, true);
  assert.equal(calls, 1);
});

test('Prefetch follows live language changes even when the queue head stays the same', async () => {
  let language = null;
  const calls = [];
  const prefetch = new QueuePrefetch({ resolve: async (_id, options) => calls.push(options.language) },
    () => [{ id: 'abcdefghijk' }], () => language);
  prefetch.start(new AbortController().signal);
  await flush();
  language = 'en'; prefetch.tick(); await flush();
  language = 'es'; prefetch.tick(); await flush();
  language = null; prefetch.tick(); await flush();
  await prefetch.stop();
  assert.deepEqual(calls, [null, 'en', 'es', null]);
});
