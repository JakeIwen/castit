import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { get } from 'node:http';
import { createStatusServer } from '../../src/http/status-server.mjs';
import { config } from '../../src/config/receiver-config.mjs';
import { createPlayerControls, createQueueControls } from '../../src/controls/player-controls.mjs';
import { PlayerStatus } from '../../src/playback/player.mjs';
import { playerFixture, VIDEO, SECOND, settleUntil, quiet } from '../playback/player-fixture.mjs';

test('Status trusts configured hostnames as well as loopback and the LAN address', async t => {
  const server = await createStatusServer({ snapshot: () => ({ ok: true }),
    pairing: { snapshot: () => ({}) },
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  const base = `http://127.0.0.1:${server.address().port}`;
  for (const host of ['localhost', '127.0.0.1', config.lanAddress, ...config.hostnames, 'foreign.example']) {
    const status = await new Promise((resolve, reject) => {
      get(`${base}/health`, { headers: { Host: `${host}:${server.address().port}` } }, response => {
        response.resume(); resolve(response.statusCode);
      }).on('error', reject);
    });
    assert.equal(status, host === 'foreign.example' ? 403 : 200, host);
  }
});

test('Cast route accepts extension and header-less senders, validates ids, reports readiness', async t => {
  const casts = [];
  let ready = true;
  const server = await createStatusServer({ snapshot: () => ({ ok: true }),
    pairing: { snapshot: () => ({}), refresh: () => true },
    cast: async (videoId, position) => {
      if (!ready) throw new Error('Receiver not running');
      casts.push([videoId, position]);
    },
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = (body, headers = {}) => fetch(`${base}/api/cast`, { method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers }, body });
  const accepted = await post('{"videoId":"dQw4w9WgXcQ","position":12.5}', { Origin: 'moz-extension://abc' });
  assert.equal(accepted.status, 202);
  assert.deepEqual(await accepted.json(), { videoId: 'dQw4w9WgXcQ', position: 12.5 });
  assert.equal((await post('{"videoId":"jNQXAC9IVRw"}')).status, 202);
  assert.equal((await post('{"videoId":"jNQXAC9IVRw"}', { Origin: 'null' })).status, 202);
  assert.equal((await post('{"videoId":"../etc/passwd"}')).status, 400);
  assert.equal((await post('{"videoId":"dQw4w9WgXcQ","position":-1}')).status, 400);
  assert.equal((await post('[]')).status, 400);
  assert.equal((await post('{"videoId":"dQw4w9WgXcQ"}', { Origin: 'https://evil.example' })).status, 403);
  assert.equal((await fetch(`${base}/api/cast`, { method: 'POST', body: 'videoId=dQw4w9WgXcQ' })).status, 403);
  ready = false;
  assert.equal((await post('{"videoId":"dQw4w9WgXcQ"}')).status, 503);
  assert.deepEqual(casts, [['dQw4w9WgXcQ', 12.5], ['jNQXAC9IVRw', 0], ['jNQXAC9IVRw', 0]]);
});

test('Cast links resolve ids and timestamps, keep explicit positions and reject ambiguous inputs', async t => {
  const casts = [];
  const server = await createStatusServer({ snapshot: () => ({ ok: true }),
    pairing: { snapshot: () => ({}) },
    cast: async (videoId, position) => { casts.push([videoId, position]); },
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = (body, headers = {}) => fetch(`${base}/api/cast`, { method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });
  const url = `https://youtu.be/${VIDEO.id}?si=shared&t=1h2m3s`;
  for (const [body, position] of [[{ url }, 3723], [{ url, position: 12.5 }, 12.5],
    [{ url, position: 0 }, 0], [{ url: ` https://music.youtube.com/watch?v=${VIDEO.id} ` }, 0]]) {
    const response = await post(body);
    assert.deepEqual([response.status, await response.json()], [202, { videoId: VIDEO.id, position }]);
  }
  for (const body of [{}, { videoId: VIDEO.id, url }, { videoId: VIDEO.id, url: null },
    { videoId: null, url }, { url, position: -1 }, { url, position: 'nope' }]) {
    assert.equal((await post(body)).status, 400, JSON.stringify(body));
  }
  for (const invalid of ['not a URL', `https://example.com/watch?v=${VIDEO.id}`, null, 12, {}, [],
    `https://youtu.be/${VIDEO.id}?si=${'x'.repeat(2048)}`]) {
    const response = await post({ url: invalid });
    assert.deepEqual([response.status, await response.json()], [400, { error: 'Not a YouTube video link' }]);
  }
  assert.equal((await post({ url }, { Origin: 'https://evil.example' })).status, 403);
  assert.equal((await post({ url }, { 'Content-Type': 'text/plain' })).status, 403);
  assert.deepEqual(casts, [[VIDEO.id, 3723], [VIDEO.id, 12.5], [VIDEO.id, 0], [VIDEO.id, 0]]);
});

test('Cast and queue accept long shared links but bound URL characters and body bytes', async t => {
  const calls = [];
  const server = await createStatusServer({ snapshot: () => ({ ok: true }),
    pairing: { snapshot: () => ({}) }, cast: async (...fields) => { calls.push(fields); },
    queue: async (...fields) => { calls.push(fields); return true; },
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  const post = (path, body) => fetch(`http://127.0.0.1:${server.address().port}${path}`, { method: 'POST',
    headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const prefix = `https://youtu.be/${VIDEO.id}?si=`;
  const url = prefix + 'x'.repeat(2048 - prefix.length);
  for (const [path, action, accepted] of [['/api/cast', undefined, 202], ['/api/queue', 'add', 200]]) {
    assert.equal((await post(path, { action, url })).status, accepted);
    const oversizedUrl = await post(path, { action, url: `${url}x` });
    assert.deepEqual([oversizedUrl.status, await oversizedUrl.json()], [400, { error: 'Not a YouTube video link' }]);
    for (const padding of ['x'.repeat(4096), 'é'.repeat(1500)]) {
      const oversizedBody = await post(path, { action, url, padding });
      assert.deepEqual([oversizedBody.status, await oversizedBody.json()], [413, { error: 'Request too large' }]);
    }
  }
  assert.deepEqual(calls, [[VIDEO.id, 0], ['add', { videoId: VIDEO.id }]]);
});

test('Control route runs only known actions from the same origin', async t => {
  const actions = [];
  const server = await createStatusServer({ snapshot: () => ({ ok: true }),
    pairing: { snapshot: () => ({}), refresh: () => true },
    control: async (action, fields) => { actions.push([action, fields]); return true; },
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = (body, origin = base) => fetch(`${base}/api/control`, { method: 'POST',
    headers: { Origin: origin, 'Content-Type': 'application/json' }, body });
  const paused = await post('{"action":"pause"}');
  assert.deepEqual(await paused.json(), { action: 'pause', done: true });
  assert.equal((await post('{"action":"reboot"}')).status, 400);
  assert.equal((await post('not json')).status, 400);
  assert.equal((await post('{"action":"stop"}', 'https://evil.example')).status, 403);
  assert.equal((await post('{"action":"seek","offset":-20}')).status, 200);
  assert.equal((await post('{"action":"seek","position":95.5}')).status, 200);
  for (const bad of ['{"action":"seek"}', '{"action":"seek","position":-1}',
    '{"action":"seek","position":10,"offset":5}', '{"action":"seek","offset":"20"}']) {
    assert.equal((await post(bad)).status, 400, bad);
  }
  assert.deepEqual(actions, [['pause', {}], ['seek', { offset: -20 }], ['seek', { position: 95.5 }]]);
});

test('Next responds during unresolved loads and repeated navigation keeps only the latest video', { timeout: 3000 }, async t => {
  const pending = new Map();
  const third = { id: 'zzzzzzzzzzz', client: VIDEO.client };
  const { player, instances } = playerFixture({ resolver: { resolve: (id, { signal, prefetch }) => {
    if (prefetch || id === third.id) return Promise.resolve(null);
    pending.set(id, signal);
    return new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
  } } });
  t.after(() => player.endSession());
  const controls = createPlayerControls(player);
  const server = await createStatusServer({ snapshot: () => ({ ok: true }),
    pairing: { snapshot: () => ({}) }, control: (action, fields) => controls[action](fields),
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  const next = () => fetch(`http://127.0.0.1:${server.address().port}/api/control`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"action":"next"}',
  }).then(response => response.json());
  const original = player.play(VIDEO);
  await settleUntil(() => pending.has(VIDEO.id));
  player.castQueue.add(SECOND.id);
  player.castQueue.add(third.id);
  assert.deepEqual(await next(), { action: 'next', done: true });
  assert.equal(await original, false);
  await settleUntil(() => pending.has(SECOND.id));
  assert.equal(player.status, PlayerStatus.LOADING);
  assert.deepEqual(await next(), { action: 'next', done: true });
  await settleUntil(() => player.status === PlayerStatus.PLAYING);
  assert.equal(player.video.id, third.id);
  assert.ok([...pending.values()].every(signal => signal.aborted));
  assert.deepEqual(instances.filter(instance => instance.loaded).map(instance => instance.loaded.id), [third.id]);
});

test('Audio delay HTTP controls validate finite seconds and expose the current setting in status', async t => {
  const { player, instances } = playerFixture();
  t.after(() => player.endSession());
  const controls = createPlayerControls(player);
  const server = await createStatusServer({ snapshot: () => ({ ok: true, audioDelay: player.audioDelay }),
    pairing: { snapshot: () => ({}) }, control: (action, fields) => controls[action](fields),
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = body => fetch(`${base}/api/control`, { method: 'POST',
    headers: { 'Content-Type': 'application/json' }, body });
  const status = async () => (await fetch(`${base}/api/status`)).json();
  assert.equal((await status()).audioDelay, 0);
  for (const [fields, expected] of [[{ delay: 0.126 }, 0.13], [{ offset: -0.05 }, 0.08],
    [{ delay: 3 }, 1], [{ offset: -5 }, -1], [{ delay: 0 }, 0]]) {
    const response = await post(JSON.stringify({ action: 'audio_delay', ...fields }));
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { action: 'audio_delay', done: true });
    assert.equal((await status()).audioDelay, expected);
  }
  for (const fields of [{}, { delay: 0, offset: 0 }, { delay: null }, { offset: null },
    { delay: '0.12' }, { offset: '0.05' }, { delay: false }, { offset: [] }, { delay: {} },
    { position: 0 }, { delay: 0, offset: null }]) {
    const response = await post(JSON.stringify({ action: 'audio_delay', ...fields }));
    assert.equal(response.status, 400, JSON.stringify(fields));
    assert.match((await response.json()).error, /exactly one.*delay or offset.*finite/);
  }
  for (const field of ['delay', 'offset']) {
    const response = await post(`{"action":"audio_delay","${field}":1e999}`);
    assert.equal(response.status, 400);
  }
  assert.equal((await post('{"action":"audio_delay","delay":NaN}')).status, 400);
  assert.equal((await post(JSON.stringify({ action: 'audio_delay', delay: 0, padding: 'x'.repeat(4096) }))).status, 413);
  assert.equal((await status()).audioDelay, 0);
  assert.equal(instances.length, 0);
  await player.play(VIDEO);
  assert.equal((await post('{"action":"audio_delay","offset":0.05}')).status, 200);
  assert.equal((await status()).audioDelay, 0.05);
  assert.equal(instances[0].properties.get('audio-delay'), 0.05);
  assert.equal((await (await fetch(`${base}/health`)).json()).audioDelay, 0.05);
});

test('Status serves code locally, keeps health code-free and rejects cross-origin refresh', async t => {
  let refreshes = 0;
  const server = await createStatusServer({ snapshot: () => ({ ok: true, receiver: 'running', player: 'IDLE' }),
    pairing: { snapshot: () => ({ code: '123 456 789 012' }), refresh: () => { refreshes++; return true; } },
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  const base = `http://127.0.0.1:${server.address().port}`;
  const health = await fetch(`${base}/health`);
  assert.equal(health.status, 200);
  assert.equal((await health.text()).includes('123'), false);
  assert.equal((await (await fetch(`${base}/api/status`)).json()).pairing.code, '123 456 789 012');
  const page = await fetch(base);
  assert.match(await page.text(), /<title>Van TV<\/title>/);
  assert.equal(page.headers.get('cache-control'), 'no-store');
  assert.equal((await fetch(`${base}/api/pairing`, { method: 'POST', headers: {
    Origin: 'https://evil.example', 'Content-Type': 'application/json',
  }, body: '{}' })).status, 403);
  assert.equal((await fetch(`${base}/api/pairing`, { method: 'POST', headers: {
    Origin: base, 'Content-Type': 'application/json',
  }, body: '{}' })).status, 202);
  assert.equal(refreshes, 1);
  const foreignHost = await new Promise((resolve, reject) => {
    get(`${base}/health`, { headers: { Host: 'evil.example' } }, response => {
      response.resume(); resolve(response.statusCode);
    }).on('error', reject);
  });
  assert.equal(foreignHost, 403);
});

test('Queue route validates actions and fields before reaching the queue', async t => {
  const calls = [];
  const server = await createStatusServer({ snapshot: () => ({ ok: true }),
    pairing: { snapshot: () => ({}) },
    queue: async (action, fields) => { calls.push([action, fields]); return action !== 'remove'; },
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  const post = body => fetch(`http://127.0.0.1:${server.address().port}/api/queue`, { method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: 'moz-extension://abc' }, body: JSON.stringify(body) });
  const added = await post({ action: 'add', videoId: VIDEO.id });
  assert.deepEqual([added.status, await added.json()], [200, { action: 'add', done: true }]);
  assert.deepEqual(await (await post({ action: 'remove', key: 4 })).json(), { action: 'remove', done: false });
  assert.equal((await post({ action: 'play', key: 2 })).status, 200);
  for (const index of [0, Number.MAX_SAFE_INTEGER]) {
    const moved = await post({ action: 'move', key: 2, index });
    assert.deepEqual([moved.status, await moved.json()], [200, { action: 'move', done: true }]);
  }
  assert.equal((await post({ action: 'clear' })).status, 200);
  for (const body of [{ action: 'add', videoId: 'nope' }, { action: 'play' }, { action: 'shuffle' }, { action: 'remove', key: 1.5 }]) {
    assert.equal((await post(body)).status, 400, JSON.stringify(body));
  }
  for (const index of [undefined, null, -1, 0.5, '0', false, [], {}, Number.MAX_SAFE_INTEGER + 1]) {
    const response = await post({ action: 'move', key: 2, index });
    assert.equal(response.status, 400, String(index));
    assert.match((await response.json()).error, /move needs a non-negative safe integer index/);
  }
  assert.equal((await post({ action: 'move', index: 0 })).status, 400);
  assert.equal((await post({ action: 'move', key: '2', index: 0 })).status, 400);
  assert.deepEqual(calls, [['add', { videoId: VIDEO.id }], ['remove', { key: 4 }], ['play', { key: 2 }],
    ['move', { key: 2, index: 0 }], ['move', { key: 2, index: Number.MAX_SAFE_INTEGER }], ['clear', {}]]);
});

test('Queue link additions start at zero and need exactly one videoId or url', async t => {
  const { player, instances } = playerFixture();
  t.after(() => player.endSession());
  const queue = createQueueControls(player, { log: quiet });
  const server = await createStatusServer({ snapshot: () => ({ ok: true, queue: player.castQueue.snapshot() }),
    pairing: { snapshot: () => ({}) }, queue: (action, fields) => queue[action](fields),
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = (body, headers = {}) => fetch(`${base}/api/queue`, { method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });
  const url = `https://youtu.be/${VIDEO.id}?t=90s`;
  const added = await post({ action: 'add', url });
  assert.deepEqual([added.status, await added.json()], [200, { action: 'add', done: true }]);
  await settleUntil(() => instances[0]?.loaded);
  assert.deepEqual(instances[0].loaded, { id: VIDEO.id, position: 0 });
  assert.equal((await post({ action: 'add', url: `https://youtube.com/shorts/${SECOND.id}#t=2m` })).status, 200);
  for (const body of [{ action: 'add' }, { action: 'add', videoId: VIDEO.id, url },
    { action: 'add', videoId: null, url }, { action: 'add', videoId: VIDEO.id, url: null }]) {
    assert.equal((await post(body)).status, 400, JSON.stringify(body));
  }
  for (const invalid of ['not a URL', `https://example.com/watch?v=${VIDEO.id}`, null, 12, {}, []]) {
    const response = await post({ action: 'add', url: invalid });
    assert.deepEqual([response.status, await response.json()], [400, { error: 'Not a YouTube video link' }]);
  }
  assert.equal((await post({ action: 'add', url }, { Origin: 'https://evil.example' })).status, 403);
  assert.equal((await post({ action: 'add', url }, { 'Content-Type': 'text/plain' })).status, 403);
  const state = await (await fetch(`${base}/api/status`)).json();
  assert.deepEqual(state.queue.map(entry => entry.id), [SECOND.id]);
});

test('Queue HTTP actions reorder upcoming videos, expose played history and replay a played key', async t => {
  const { player, instances } = playerFixture();
  t.after(() => player.endSession());
  const controls = createPlayerControls(player);
  const queue = createQueueControls(player, { log: quiet });
  const server = await createStatusServer({ snapshot: () => ({ ok: true, video: player.video,
    queue: player.castQueue.snapshot(), played: player.castQueue.playedSnapshot(player.video) }),
    pairing: { snapshot: () => ({}) }, control: (action, fields) => controls[action](fields),
    queue: (action, fields) => queue[action](fields),
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  const base = `http://127.0.0.1:${server.address().port}`;
  const status = async () => (await fetch(`${base}/api/status`)).json();
  const post = async (body, path = '/api/queue') => (await fetch(`${base}${path}`, { method: 'POST',
    headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })).json();
  await player.play(VIDEO);
  instances[0].property('media-title', 'First');
  await player.play(SECOND);
  const [previous] = (await status()).played;
  assert.deepEqual(previous, { key: previous.key, id: VIDEO.id, title: 'First' });
  assert.equal((await status()).video.id, SECOND.id);
  await post({ action: 'add', videoId: 'aaaaaaaaaaa' });
  await post({ action: 'add', videoId: 'bbbbbbbbbbb' });
  const [a, b] = (await status()).queue;
  assert.deepEqual(await post({ action: 'move', key: a.key, index: 999 }), { action: 'move', done: true });
  assert.deepEqual((await status()).queue.map(entry => entry.key), [b.key, a.key]);
  assert.deepEqual(await post({ action: 'move', key: a.key, index: 0 }), { action: 'move', done: true });
  assert.deepEqual((await status()).queue.map(entry => entry.key), [a.key, b.key]);
  for (const key of [previous.key, 9999]) {
    assert.deepEqual(await post({ action: 'move', key, index: 0 }), { action: 'move', done: false });
  }
  assert.deepEqual(await post({ action: 'play', key: previous.key }), { action: 'play', done: true });
  await settleUntil(() => player.castQueue.findPlayed(previous.key) === null);
  assert.deepEqual(instances[2].loaded, { id: VIDEO.id, position: 0 });
  assert.deepEqual((await status()).played.map(entry => entry.id), [SECOND.id]);
  assert.deepEqual(await post({ action: 'play', key: previous.key }), { action: 'play', done: false });
  assert.deepEqual(await post({ action: 'play', key: 9999 }), { action: 'play', done: false });
  assert.deepEqual(await post({ action: 'stop' }, '/api/control'), { action: 'stop', done: true });
  const stopped = await status();
  assert.equal(stopped.queue.length, 2);
  assert.deepEqual(stopped.played.map(entry => entry.id), [SECOND.id, VIDEO.id]);
  await post({ action: 'clear' });
  assert.deepEqual((await status()).played, []);
});

test('Control route parses speed, volume and mute fields', async t => {
  const calls = [];
  const server = await createStatusServer({ snapshot: () => ({ ok: true }),
    pairing: { snapshot: () => ({}) },
    control: async (action, fields) => { calls.push([action, fields]); return true; },
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  const post = body => fetch(`http://127.0.0.1:${server.address().port}/api/control`, { method: 'POST',
    headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  for (const body of [{ action: 'speed', speed: 1.5 }, { action: 'volume', offset: -5 }, { action: 'mute' }, { action: 'mute', muted: true }]) {
    assert.equal((await post(body)).status, 200, JSON.stringify(body));
  }
  for (const body of [{ action: 'speed' }, { action: 'volume', level: 'loud' }, { action: 'mute', muted: 1 }]) {
    assert.equal((await post(body)).status, 400, JSON.stringify(body));
  }
  assert.deepEqual(calls, [['speed', { speed: 1.5 }], ['volume', { offset: -5 }], ['mute', {}], ['mute', { muted: true }]]);
});

test('Subtitle HTTP controls validate fields, preserve language when disabled and expose status', async t => {
  const { player } = playerFixture();
  const controls = createPlayerControls(player);
  const server = await createStatusServer({ snapshot: () => ({ ok: true, subtitles: player.subtitles }),
    pairing: { snapshot: () => ({}) }, control: (action, fields) => controls[action](fields) });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => { await player.endSession(); server.closeAllConnections(); await new Promise(r => server.close(r)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = fields => fetch(`${base}/api/control`, { method: 'POST',
    headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'subtitles', ...fields }) });
  for (const fields of [{}, { enabled: 1 }, { enabled: null }, { language: 'all' }, { language: 'ALL' },
    { language: 'en,es' }, { language: 'en.*' }, { language: {} }]) assert.equal((await post(fields)).status, 400);
  assert.deepEqual(await (await post({ language: 'PT-BR' })).json(), { action: 'subtitles', done: true });
  assert.equal((await post({ enabled: false })).status, 200);
  const state = await (await fetch(`${base}/api/status`)).json();
  assert.deepEqual(state.subtitles, { enabled: false, language: 'pt-br', available: null, loading: false, error: false });
});
