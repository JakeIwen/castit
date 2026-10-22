import test from 'node:test';
import assert from 'node:assert/strict';
import { StreamResolver } from '../../src/playback/stream-resolver.mjs';
import { playback, watchUrl } from '../../src/config/receiver-config.mjs';
import { runCommandOutput } from '../../src/host/process-command.mjs';

const ID = 'abcdefghijk';
const NOW = 1_800_000_000_000;
const url = (kind, expiry = NOW / 1000 + 3600) => `https://r1.googlevideo.com/videoplayback?kind=${kind}&expire=${expiry}`;
const track = (kind, expiry) => ({ url: url(kind, expiry), protocol: 'https',
  vcodec: kind === 'video' ? 'avc1' : 'none', acodec: kind === 'audio' ? 'mp4a' : 'none' });
const metadata = () => ({ id: ID, title: 'Title, with: punctuation',
  http_headers: { 'User-Agent': 'Fixture UA', Referer: 'https://www.youtube.com/' },
  requested_formats: [track('video'), track('audio')],
});
const result = value => ({ code: 0, stdout: JSON.stringify(value), stderr: '' });

test('Resolver runs the existing selector and hook options through bounded, niced output capture', async () => {
  const calls = [];
  const resolver = new StreamResolver({ now: () => NOW, run: (argv, options) => {
    calls.push({ argv, options });
    return runCommandOutput([process.execPath, '-e', `process.stdout.write(${JSON.stringify(JSON.stringify(metadata()))})`], options);
  } });
  const stream = await resolver.resolve(ID);
  assert.deepEqual(stream, { videoUrl: url('video'), audioUrl: url('audio'), title: metadata().title,
    httpOptions: { 'user-agent': 'Fixture UA', 'http-header-fields': 'Referer: https://www.youtube.com/' } });
  const { argv, options } = calls[0];
  assert.deepEqual(argv.slice(0, 4), [playback.nice, '-n', String(playback.resolveNice), playback.ytdlp]);
  assert.equal(argv[argv.indexOf('--format') + 1], playback.format);
  assert.deepEqual(argv.slice(-2), ['--', watchUrl(ID)]);
  assert.ok(argv.includes('--flat-playlist'));
  assert.ok(argv.includes('--all-subs'));
  assert.ok(argv.includes('--no-playlist'));
  assert.ok(argv.includes('ass/srt/best'));
  const runtime = argv[argv.indexOf('--js-runtimes') + 1];
  assert.ok(playback.ytdlpOptions.includes(`js-runtimes=${runtime}`));
  assert.equal(options.timeoutMs, playback.resolveTimeoutMs);
  assert.equal(options.maxBytes, playback.resolveMaxBytes);
});

test('Cache hits avoid another process, expiring before the earliest video or audio URL', async () => {
  let now = NOW;
  let calls = 0;
  const data = metadata();
  data.requested_formats[1] = track('audio', NOW / 1000 + 90);
  const resolver = new StreamResolver({ now: () => now, run: async () => { calls++; return result(data); } });
  const first = await resolver.resolve(ID);
  now += 29_999;
  assert.equal(await resolver.resolve(ID), first);
  assert.equal(calls, 1);
  now++;
  await resolver.resolve(ID);
  assert.equal(calls, 2);
});

test('Muxed HTTPS formats are preserved and unknown expiries are never cached', async () => {
  let calls = 0;
  const data = { id: ID, title: 'Muxed', protocol: 'https', url: 'https://media.invalid/muxed', vcodec: 'avc1', acodec: 'mp4a' };
  const resolver = new StreamResolver({ run: async () => { calls++; return result(data); } });
  assert.deepEqual(await resolver.resolve(ID), { videoUrl: data.url, audioUrl: null, title: 'Muxed', httpOptions: {} });
  await resolver.resolve(ID);
  assert.equal(calls, 2);
});

test('Resolution failures and unsupported hook-dependent formats select fallback', async () => {
  const unsupported = [
    { ...metadata(), id: '0123456789a' },
    { ...metadata(), _type: 'playlist' },
    { ...metadata(), is_live: true },
    { ...metadata(), requested_subtitles: { en: { url: 'https://media.invalid/subtitles' } } },
    { ...metadata(), requested_formats: [track('video'), { ...track('audio'), fragments: [{ url: '/part' }] }] },
    { ...metadata(), requested_formats: [track('video'), { ...track('audio'), protocol: 'm3u8_native' }] },
    { ...metadata(), requested_formats: [{ ...track('video'), url: 'file:///etc/passwd' }, track('audio')] },
    { ...metadata(), requested_formats: [track('video'), { ...track('audio'), http_headers: { 'User-Agent': 'different' } }] },
    { ...metadata(), requested_formats: [{ ...track('video'), acodec: 'mp4a' }, track('audio')] },
    { ...metadata(), http_headers: { 'User-Agent': 'Bad\r\nHeader' } },
  ];
  for (const data of unsupported) {
    assert.equal(await new StreamResolver({ run: async () => result(data) }).resolve(ID), null);
  }
  for (const response of [{ code: 1, stdout: '', stderr: 'private' }, { code: 0, stdout: 'bad json' }]) {
    assert.equal(await new StreamResolver({ run: async () => response }).resolve(ID), null);
  }
  assert.equal(await new StreamResolver({ run: async () => { throw new Error('spawn failed'); } }).resolve(ID), null);
  const resolver = new StreamResolver({ run: () => assert.fail('invalid id must not spawn') });
  assert.equal(await resolver.resolve('--invalid'), null);
});

test('Prefetch has lower scheduling priority and successful results serve the foreground', async () => {
  const calls = [];
  const resolver = new StreamResolver({ now: () => NOW, run: async argv => { calls.push(argv); return result(metadata()); } });
  const prefetched = await resolver.resolve(ID, { prefetch: true });
  assert.equal(calls[0][2], String(playback.prefetchNice));
  assert.ok(playback.prefetchNice > playback.resolveNice);
  assert.equal(await resolver.resolve(ID), prefetched);
  assert.equal(calls.length, 1);
});

test('Aborted extraction cannot cache its result or fall back to another extraction', async () => {
  const abort = new AbortController();
  let calls = 0;
  const resolver = new StreamResolver({ now: () => NOW, run: async () => {
    calls++; if (calls === 1) abort.abort(); return result(metadata());
  } });
  await assert.rejects(resolver.resolve(ID, { signal: abort.signal }), { name: 'AbortError' });
  assert.ok(await resolver.resolve(ID));
  assert.equal(calls, 2);
});

test('Resolved URL cache is bounded', async () => {
  let calls = 0;
  const resolver = new StreamResolver({ now: () => NOW, run: async argv => {
    calls++;
    const id = new URL(argv.at(-1)).searchParams.get('v');
    return result({ ...metadata(), id });
  } });
  await resolver.resolve(ID);
  for (let index = 0; index < playback.resolveCacheEntries; index++) {
    await resolver.resolve(String(index).padStart(11, '0'));
  }
  await resolver.resolve(ID);
  assert.equal(calls, playback.resolveCacheEntries + 2);
});
