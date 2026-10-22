import assert from 'node:assert/strict';
import test from 'node:test';
import { createReceiverClient, decodeStatus } from '../receiver-client.mjs';
import { defaultStatus, startReceiver, videoId } from './receiver-fixture.mjs';

test('background HTTP round trip sends JSON casts and controls without cookies or pairing data', async t => {
  const fixture = await startReceiver(t);
  const receiver = createReceiverClient({ baseUrls: [fixture.url] });
  const status = await receiver.status();
  assert.equal(status.video.title, 'A test video');
  assert.equal(status.pairing, undefined);
  assert.deepEqual(await receiver.cast(videoId, 12.5), { videoId, position: 12.5 });
  assert.deepEqual(await receiver.control('pause'), { action: 'pause', done: true });
  assert.deepEqual(await receiver.control('toggle'), { action: 'toggle', done: true });
  assert.deepEqual(await receiver.control('seek', { position: 27 }), { action: 'seek', done: true });
  assert.deepEqual(await receiver.control('seek', { offset: -20 }), { action: 'seek', done: true });
  const posts = fixture.requests.filter(request => request.method === 'POST');
  assert.deepEqual(posts.map(request => [request.path, request.body]), [
    ['/api/cast', { videoId, position: 12.5 }],
    ['/api/control', { action: 'pause' }],
    ['/api/control', { action: 'toggle' }],
    ['/api/control', { action: 'seek', position: 27 }],
    ['/api/control', { action: 'seek', offset: -20 }],
  ]);
  for (const request of posts) {
    assert.equal(request.headers['content-type'], 'application/json');
    assert.equal(request.headers.cookie, undefined);
  }
});

test('A/V offset controls send one absolute delay or relative offset', async t => {
  const fixture = await startReceiver(t);
  const receiver = createReceiverClient({ baseUrls: [fixture.url] });
  assert.deepEqual(await receiver.control('audio_delay', { offset: -0.05 }), { action: 'audio_delay', done: true });
  assert.deepEqual(await receiver.control('audio_delay', { delay: 0 }), { action: 'audio_delay', done: true });
  for (const fields of [{}, { delay: 0, offset: 0.05 }, { delay: '0' }, { offset: NaN }, { position: 3 }]) {
    await assert.rejects(receiver.control('audio_delay', fields), /Invalid audio delay fields/);
  }
  assert.deepEqual(fixture.requests.filter(request => request.method === 'POST').map(request => request.body), [
    { action: 'audio_delay', offset: -0.05 },
    { action: 'audio_delay', delay: 0 },
  ]);
});

test('status keeps a reported A/V offset and marks an older receiver as lacking one', () => {
  assert.equal(decodeStatus({ ...defaultStatus, audioDelay: -0.12 }).audioDelay, -0.12);
  assert.equal(decodeStatus(defaultStatus).audioDelay, null);
  assert.equal(decodeStatus({ ...defaultStatus, audioDelay: 'loud' }).audioDelay, null);
});

test('speed, volume and mute controls send one absolute value or offset; mute may toggle', async t => {
  const fixture = await startReceiver(t);
  const receiver = createReceiverClient({ baseUrls: [fixture.url] });
  await receiver.control('speed', { speed: 1.5 });
  await receiver.control('speed', { offset: -0.25 });
  await receiver.control('volume', { offset: 5 });
  await receiver.control('mute');
  await receiver.control('mute', { muted: false });
  await assert.rejects(receiver.control('speed', {}), /Invalid speed fields/);
  await assert.rejects(receiver.control('volume', { level: 'max' }), /Invalid volume fields/);
  await assert.rejects(receiver.control('mute', { muted: 'yes' }), /Invalid mute fields/);
  assert.deepEqual(fixture.requests.filter(request => request.method === 'POST').map(request => request.body), [
    { action: 'speed', speed: 1.5 }, { action: 'speed', offset: -0.25 }, { action: 'volume', offset: 5 },
    { action: 'mute' }, { action: 'mute', muted: false },
  ]);
});

test('queue requests carry a video id to add and an entry key to play or remove', async t => {
  const fixture = await startReceiver(t);
  const receiver = createReceiverClient({ baseUrls: [fixture.url] });
  assert.deepEqual(await receiver.queue('add', { videoId }), { action: 'add', done: true });
  await receiver.queue('play', { key: 3 });
  await receiver.queue('remove', { key: 4 });
  await receiver.queue('clear');
  await assert.rejects(receiver.queue('add', { videoId: 'nope' }), /Invalid YouTube video/);
  await assert.rejects(receiver.queue('remove', {}), /Invalid queue entry/);
  await assert.rejects(receiver.queue('shuffle'), /Unknown queue action/);
  assert.deepEqual(fixture.requests.filter(request => request.method === 'POST').map(request => [request.path, request.body]), [
    ['/api/queue', { action: 'add', videoId }], ['/api/queue', { action: 'play', key: 3 }],
    ['/api/queue', { action: 'remove', key: 4 }], ['/api/queue', { action: 'clear' }],
  ]);
});

test('status decodes speed, volume and queue, treating malformed or missing ones as unsupported', () => {
  const queue = [{ key: 2, id: videoId, title: 'Next up' }, { key: 3, id: videoId, title: null }];
  const status = decodeStatus({ ...defaultStatus, speed: 1.5, volume: { level: 40, muted: true }, queue });
  assert.deepEqual([status.speed, status.volume, status.queue], [1.5, { level: 40, muted: true }, queue]);
  const older = decodeStatus(defaultStatus);
  assert.deepEqual([older.speed, older.volume, older.queue], [null, null, null]);
  const malformed = decodeStatus({ ...defaultStatus, speed: '2', volume: { level: 40 }, queue: [{ key: 'a', id: videoId }] });
  assert.deepEqual([malformed.speed, malformed.volume, malformed.queue], [null, null, null]);
});

test('unreachable primary falls back on a read and performs exactly one cast', async t => {
  const fixture = await startReceiver(t);
  const receiver = createReceiverClient({ baseUrls: ['http://127.0.0.1:1', fixture.url] });
  await receiver.cast(videoId);
  assert.deepEqual(fixture.requests.map(request => request.path), ['/api/status', '/api/cast']);
  assert.equal(fixture.requests[1].body.position, 0);
});

test('ambiguous POST connection loss is reported and never replayed through another address', async t => {
  const primary = await startReceiver(t, { respond(request, response) {
    if (request.method !== 'POST') return false;
    response.destroy();
    return true;
  } });
  const fallback = await startReceiver(t);
  const receiver = createReceiverClient({ baseUrls: [primary.url, fallback.url] });
  await assert.rejects(receiver.cast(videoId, 20), /request may have been accepted/);
  assert.equal(primary.requests.filter(request => request.method === 'POST').length, 1);
  assert.equal(fallback.requests.length, 0);
});

test('invalid IDs, positions and actions fail before any network request', async t => {
  const fixture = await startReceiver(t);
  const receiver = createReceiverClient({ baseUrls: [fixture.url] });
  for (const [id, position] of [['bad', 0], [videoId, -1], [videoId, Infinity], [videoId, '12']]) {
    await assert.rejects(receiver.cast(id, position), /Invalid YouTube/);
  }
  await assert.rejects(receiver.control('rewind'), /Unknown playback action/);
  assert.equal(fixture.requests.length, 0);
});

test('invalid seek fields fail before any network request', async t => {
  const fixture = await startReceiver(t);
  const receiver = createReceiverClient({ baseUrls: [fixture.url] });
  const invalidFields = [
    undefined, null, [], {}, { position: 0, offset: 0 }, { position: -1 },
    { position: Infinity }, { position: '12' }, { position: undefined },
    { offset: Infinity }, { offset: '-20' }, { offset: undefined },
  ];
  for (const fields of invalidFields) {
    await assert.rejects(receiver.control('seek', fields), /Invalid seek fields/);
  }
  assert.equal(fixture.requests.length, 0);
});

test('receiver HTTP errors are surfaced without endpoint failover', async t => {
  const primary = await startReceiver(t, { respond(request, response) {
    if (request.method !== 'POST') return false;
    response.writeHead(503); response.end('{}'); return true;
  } });
  const fallback = await startReceiver(t);
  const receiver = createReceiverClient({ baseUrls: [primary.url, fallback.url] });
  await assert.rejects(receiver.cast(videoId), /receiver is not running/);
  assert.equal(fallback.requests.length, 0);
});

test('bounded status reads abort a receiver that never answers', async t => {
  const fixture = await startReceiver(t, { respond: () => true });
  const receiver = createReceiverClient({ baseUrls: [fixture.url], timeoutMs: 30 });
  await assert.rejects(receiver.status(), /Van TV unreachable/);
});

test('malformed status and POST acknowledgements do not count as success', async t => {
  for (const patch of [{ player: 'BOGUS' }, { position: null }, { duration: -1 },
    { ok: 'yes' }, { video: { id: videoId, title: null } }]) {
    assert.throws(() => decodeStatus({ ...defaultStatus, ...patch }), /Invalid Van TV status/);
  }
  const fixture = await startReceiver(t, { respond(request, response) {
    if (request.method !== 'POST') return false;
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end('{}'); return true;
  } });
  const receiver = createReceiverClient({ baseUrls: [fixture.url] });
  await assert.rejects(receiver.cast(videoId), /Invalid Van TV cast response/);
  await assert.rejects(receiver.control('stop'), /Invalid Van TV control response/);
});

test('redirects are refused instead of following an unapproved receiver destination', async t => {
  const destination = await startReceiver(t);
  const fixture = await startReceiver(t, { respond(request, response) {
    response.writeHead(302, { Location: `${destination.url}/api/status` });
    response.end(); return true;
  } });
  const receiver = createReceiverClient({ baseUrls: [fixture.url] });
  await assert.rejects(receiver.status(), /Van TV unreachable/);
  assert.equal(destination.requests.length, 0);
});
