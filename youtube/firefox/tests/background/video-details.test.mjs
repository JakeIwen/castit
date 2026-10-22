import assert from 'node:assert/strict';
import test from 'node:test';
import { createVideoDetails, parseChannelPage } from '../../background/video-details.mjs';
import { watchUrl } from '../../youtube/video-url.mjs';
import { videoId } from './receiver-fixture.mjs';

const channelUrl = 'https://www.youtube.com/@example';
// Shaped like a channel page: another channel's count precedes the header.
const channelPage = [
  '<meta property="og:image" content="https://yt3.googleusercontent.com/abc=s900-c-k-c0x00ffffff-no-rj&amp;x=1">',
  '"subscriberCountText":{"simpleText":"3.92K subscribers"}',
  '"pageHeaderViewModel":{"title":{"dynamicTextViewModel":{"text":{"content":"Example",',
  '"attachmentRuns":[{"element":{"imageName":"CHECK_CIRCLE_FILLED"}}]},"maxLines":2}},',
  '"metadataRows":[{"metadataParts":[{"text":{"content":"@example"}}]},',
  '{"metadataParts":[{"text":{"content":"5.61M subscribers"}}]}]',
].join('');

function fetcherFixture(routes) {
  const requests = [];
  const fetcher = async (url, options) => {
    requests.push({ url, options });
    const route = routes(new URL(url));
    if (route instanceof Error) throw route;
    return new Response(route.body, { status: route.status ?? 200 });
  };
  return { fetcher, requests };
}

const oembed = (fields = {}) => ({
  body: JSON.stringify({ title: 'A test video', author_name: 'Example', author_url: channelUrl, ...fields }),
});

test('channel header supplies the avatar, own subscriber count and verified badge', () => {
  assert.deepEqual(parseChannelPage(channelPage), {
    avatarUrl: 'https://yt3.googleusercontent.com/abc=s88-c-k-c0x00ffffff-no-rj&x=1',
    subscribers: '5.61M subscribers', verified: true,
  });
  const unverified = channelPage.replace('CHECK_CIRCLE_FILLED', 'OTHER');
  assert.equal(parseChannelPage(unverified).verified, false);
  assert.deepEqual(parseChannelPage('<html>consent</html>'), { avatarUrl: null, subscribers: null, verified: false });
});

test('details combine oEmbed and the channel page, fetching each once without cookies', async () => {
  const { fetcher, requests } = fetcherFixture(url => (url.pathname === '/oembed' ? oembed() : { body: channelPage }));
  const { details } = createVideoDetails({ fetcher });
  const expected = { videoId, url: watchUrl(videoId), channel: {
    name: 'Example', url: channelUrl, avatarUrl: 'https://yt3.googleusercontent.com/abc=s88-c-k-c0x00ffffff-no-rj&x=1',
    subscribers: '5.61M subscribers', verified: true } };
  assert.deepEqual(await details(videoId), expected);
  assert.deepEqual(await details(videoId), expected);
  assert.equal(requests.length, 2);
  assert.equal(new URL(requests[0].url).searchParams.get('url'), watchUrl(videoId));
  assert.equal(requests[1].url, channelUrl);
  for (const { options } of requests) assert.equal(options.credentials, 'omit');
});

test('a channel page failure still returns the channel name and link', async () => {
  const { fetcher } = fetcherFixture(url => (url.pathname === '/oembed' ? oembed() : new TypeError('offline')));
  const { channel } = await createVideoDetails({ fetcher }).details(videoId);
  assert.deepEqual(channel, { name: 'Example', url: channelUrl, avatarUrl: null, subscribers: null, verified: false });
});

test('bad IDs, foreign channel links and failed lookups fetch nothing further and are retried later', async () => {
  let status = 500;
  const { fetcher, requests } = fetcherFixture(url => (url.pathname === '/oembed'
    ? { ...oembed({ author_url: 'https://evil.example/@x' }), status } : { body: channelPage }));
  const { details } = createVideoDetails({ fetcher });
  await assert.rejects(details('bad'), /Invalid YouTube video/);
  assert.equal(requests.length, 0);
  await assert.rejects(details(videoId), /HTTP 500/);
  status = 200;
  await assert.rejects(details(videoId), /Invalid YouTube video details/);
  assert.equal(requests.length, 2);
  assert.ok(requests.every(request => new URL(request.url).pathname === '/oembed'));
});
