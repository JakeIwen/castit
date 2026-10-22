import './config.js';
import { isVideoId, watchUrl } from './youtube-video.mjs';

const config = globalThis.VAN_TV_CONFIG;
const { origin } = config.youtube;
// The popup's avatar is 36 CSS px; 88 covers 2x displays without the 900 px original.
const AVATAR_SIZE = 88;

/** @typedef {{name: string, url: string, avatarUrl: string|null,
 * subscribers: string|null, verified: boolean}} ChannelDetails */
/** @typedef {{videoId: string, url: string, channel: ChannelDetails}} VideoDetails */

function youtubeUrl(value) {
  try {
    const url = new URL(value);
    return url.origin === origin ? url.href : null;
  } catch { return null; }
}

function avatarUrl(value) {
  try {
    const url = new URL(value.replaceAll('&amp;', '&'));
    if (url.protocol !== 'https:') return null;
    url.pathname = url.pathname.replace(/=s\d+-/, `=s${AVATAR_SIZE}-`);
    return url.href;
  } catch { return null; }
}

// Channel pages embed many other channels (featured, collaborators), so the
// count and badge are read only from the page header's own title and metadata.
export function parseChannelPage(html) {
  const avatar = /<meta property="og:image" content="([^"]+)"/.exec(html);
  const header = html.indexOf('"pageHeaderViewModel":{"title"');
  const titleEnd = header < 0 ? -1 : html.indexOf('"maxLines"', header);
  const subscribers = header < 0 ? null
    : /"metadataParts":\[\{"text":\{"content":"([^"]{1,40} subscribers?)"/.exec(html.slice(header, header + 20000));
  return {
    avatarUrl: avatar ? avatarUrl(avatar[1]) : null,
    subscribers: subscribers ? subscribers[1] : null,
    verified: titleEnd > header && html.slice(header, titleEnd).includes('CHECK_CIRCLE_FILLED'),
  };
}

async function fetchResponse(fetcher, url, timeoutMs) {
  const response = await fetcher(url, {
    signal: AbortSignal.timeout(timeoutMs), credentials: 'omit', redirect: 'error',
  });
  if (!response.ok) throw new Error(`YouTube request failed (HTTP ${response.status})`);
  return response;
}

// Results are cached for the background page's lifetime; failures are not, so
// a later popup can retry.
function cached(cache, key, load) {
  if (!cache.has(key)) {
    cache.set(key, load().catch(error => { cache.delete(key); throw error; }));
  }
  return cache.get(key);
}

export function createVideoDetails({ fetcher = globalThis.fetch, timeoutMs = config.requestTimeoutMs * 3 } = {}) {
  const videos = new Map();
  const channels = new Map();

  const channelPage = url => cached(channels, url, async () => {
    try { return parseChannelPage(await (await fetchResponse(fetcher, url, timeoutMs)).text()); }
    catch { return { avatarUrl: null, subscribers: null, verified: false }; }
  });

  /** @returns {Promise<VideoDetails>} */
  function details(videoId) {
    if (!isVideoId(videoId)) return Promise.reject(new Error('Invalid YouTube video'));
    return cached(videos, videoId, async () => {
      const oembed = new URL('/oembed', origin);
      oembed.search = new URLSearchParams({ url: watchUrl(videoId), format: 'json' });
      const body = await (await fetchResponse(fetcher, oembed.href, timeoutMs)).json();
      const channelUrl = youtubeUrl(body?.author_url);
      if (typeof body?.author_name !== 'string' || !channelUrl) throw new Error('Invalid YouTube video details');
      return { videoId, url: watchUrl(videoId),
        channel: { name: body.author_name, url: channelUrl, ...await channelPage(channelUrl) } };
    });
  }

  return { details };
}
