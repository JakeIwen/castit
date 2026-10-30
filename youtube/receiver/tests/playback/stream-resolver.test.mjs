import test from 'node:test';
import assert from 'node:assert/strict';
import { StreamResolver } from '../../src/playback/stream-resolver.mjs';
import { playback, watchUrl } from '../../src/config/receiver-config.mjs';
import { CommandTimeoutError, runCommandOutput } from '../../src/host/process-command.mjs';

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
  assert.ok(argv.includes('--no-write-subs'));
  assert.ok(argv.includes('--no-write-auto-subs'));
  assert.ok(!argv.includes('--all-subs'));
  assert.ok(argv.includes('--no-playlist'));
  const runtime = argv[argv.indexOf('--js-runtimes') + 1];
  assert.ok(playback.ytdlpOptions.includes(`js-runtimes=${runtime}`));
  assert.equal(options.timeoutMs, playback.resolveTimeoutMs);
  assert.equal(options.maxBytes, playback.resolveMaxBytes);
});

test('Per-format headers without a top-level set still select the direct stream', async () => {
  const headers = { 'User-Agent': 'Fixture UA', Accept: '*/*' };
  const { http_headers: _, ...data } = metadata();
  data.requested_formats = data.requested_formats.map(format => ({ ...format, http_headers: headers }));
  const stream = await new StreamResolver({ run: async () => result(data) }).resolve(ID);
  assert.deepEqual(stream?.httpOptions, { 'user-agent': 'Fixture UA' });
  data.requested_formats[1] = { ...data.requested_formats[1], http_headers: { 'User-Agent': 'different' } };
  assert.equal(await new StreamResolver({ run: async () => result(data) }).resolve(ID), null);
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

test('Timeout rejects rather than selecting the hook and leaves an explicit retry possible', async () => {
  let calls = 0;
  const resolver = new StreamResolver({ now: () => NOW, run: async (_argv, options) => {
    if (++calls > 1) return result(metadata());
    return runCommandOutput([process.execPath, '-e', 'setInterval(() => {}, 1000)'],
      { ...options, timeoutMs: 30 });
  } });
  await assert.rejects(resolver.resolve(ID), CommandTimeoutError);
  assert.ok(await resolver.resolve(ID));
  assert.equal(calls, 2, 'timeout must not poison the stream cache');
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

const caption = (name, expiry = NOW / 1000 + 3600) => ({ ext: 'vtt',
  url: `https://www.youtube.com/api/timedtext?name=${name}&expire=${expiry}`, name: 'English', impersonate: true });

test('Uploaded English beats auto captions, only its language is requested, and subtitles retain the direct path', async () => {
  const uploaded = caption('uploaded');
  const automatic = caption('auto');
  const data = { ...metadata(), subtitles: { en: [uploaded], es: [caption('spanish')] },
    automatic_captions: { en: [automatic] }, requested_subtitles: { en: uploaded } };
  const calls = [];
  const resolver = new StreamResolver({ now: () => NOW, run: async argv => { calls.push(argv); return result(data); } });
  const stream = await resolver.resolve(ID, { language: 'en' });
  assert.equal(stream.videoUrl, url('video'));
  assert.deepEqual(stream.subtitle, { url: uploaded.url, language: 'en', automatic: false });
  assert.equal(calls[0][calls[0].indexOf('--sub-langs') + 1], 'en');
  assert.equal(calls[0].includes('--all-subs'), false);
  assert.ok(calls[0].includes('--write-auto-subs'));
  assert.ok(calls[0].includes('--write-subs'));
  assert.equal(await resolver.resolveSubtitle(ID, { language: 'en' }), stream.subtitle);
  assert.equal(calls.length, 1);
  const spanish = await resolver.resolve(ID, { language: 'es' });
  assert.equal(spanish.subtitle.language, 'es');
  assert.equal(calls.length, 2);
  const off = await resolver.resolve(ID);
  assert.equal(off.subtitle, undefined);
  assert.equal(off.videoUrl, stream.videoUrl);
});

test('Auto-only captions choose a playable format over HLS/json and expire before their signed URL', async () => {
  let now = NOW;
  let calls = 0;
  const automatic = caption('auto', NOW / 1000 + 90);
  const data = { ...metadata(), subtitles: {}, automatic_captions: { en: [
    { ...automatic, protocol: 'm3u8_native' }, { ...automatic, ext: 'json3' }, automatic,
  ] }, requested_subtitles: { en: automatic } };
  const resolver = new StreamResolver({ now: () => now, run: async () => { calls++; return result(data); } });
  const first = await resolver.resolve(ID, { language: 'en', prefetch: true });
  assert.equal(first.subtitle.automatic, true);
  assert.equal(first.subtitle.url, automatic.url);
  now += 29999;
  assert.equal(await resolver.resolve(ID, { language: 'en' }), first);
  assert.equal(calls, 1);
  now++;
  await resolver.resolve(ID, { language: 'en' });
  assert.equal(calls, 2);
  assert.equal((await resolver.resolve(ID, { language: 'fr' })).subtitle, null);
});

test('Missing or unsafe subtitles never demote playable streams; failed extraction is not absence', async () => {
  const data = { ...metadata(), subtitles: { en: [null, { ext: 'vtt', url: 'file:///etc/passwd' }] } };
  const resolver = new StreamResolver({ now: () => NOW, run: async () => result(data) });
  assert.equal((await resolver.resolve(ID, { language: 'en' })).subtitle, null);
  assert.equal(await resolver.resolveSubtitle(ID, { language: 'en' }), null);
  const failed = new StreamResolver({ run: async () => ({ code: 1 }) });
  assert.equal(await failed.resolveSubtitle(ID, { language: 'en' }), undefined);
  const invalid = new StreamResolver({ run: () => assert.fail('invalid language must not spawn') });
  assert.equal(await invalid.resolve(ID, { language: 'en.*' }), null);
});

test('Hook-only video formats still cache a usable subtitle for live selection', async () => {
  let calls = 0;
  const uploaded = caption('live');
  const resolver = new StreamResolver({ now: () => NOW, run: async () => {
    calls++;
    return result({ ...metadata(), is_live: true, subtitles: { en: [uploaded] } });
  } });
  assert.equal(await resolver.resolve(ID, { language: 'en' }), null);
  assert.equal((await resolver.resolveSubtitle(ID, { language: 'en' })).url, uploaded.url);
  assert.equal(calls, 1);
});
