import { playback, resolverArguments } from '../config/receiver-config.mjs';
import { runCommandOutput } from '../host/process-command.mjs';
import { isVideoId } from '../youtube/video-id.mjs';

/**
 * @typedef {object} ResolvedStream
 * @property {string} videoUrl
 * @property {string|null} audioUrl
 * @property {string} title
 * @property {Readonly<Record<string, string>>} httpOptions mpv file-local HTTP options
 */

function directUrl(track) {
  // Fragmented/live streams need mpv's hook to build its EDL, not a guessed URL.
  if (track.fragments?.length || !['https', 'http'].includes(track.protocol)) return null;
  try {
    const url = new URL(track.url);
    return ['https:', 'http:'].includes(url.protocol) ? url.href : null;
  } catch { return null; }
}

function httpOptions(headers = {}) {
  const options = {};
  if (typeof headers['User-Agent'] === 'string') options['user-agent'] = headers['User-Agent'];
  const fields = ['Cookie', 'Referer', 'X-Forwarded-For'].filter(name => typeof headers[name] === 'string')
    .map(name => `${name}: ${headers[name]}`);
  if (fields.length) options['http-header-fields'] = fields.map(value => value.replace(/[\\,]/g, '\\$&')).join(',');
  if (Object.values(options).some(value => /[\r\n\0]/.test(value))) throw new Error('Unsafe stream headers');
  return options;
}

function selectStream(data, videoId) {
  if (!data || data.id !== videoId || (data._type && data._type !== 'video') || data.is_live
    || data.has_drm || Object.keys(data.requested_subtitles || {}).length) return null;
  const tracks = data.requested_formats || [data];
  if (!Array.isArray(tracks) || !tracks.length || tracks.length > 2) return null;
  const video = tracks.find(track => track.vcodec && track.vcodec !== 'none');
  const audio = tracks.find(track => track.vcodec === 'none' && track.acodec && track.acodec !== 'none');
  if (!video || (tracks.length === 2 && (!audio || video.acodec !== 'none'))) return null;
  const videoUrl = directUrl(video);
  const audioUrl = audio ? directUrl(audio) : null;
  if (!videoUrl || (audio && !audioUrl)) return null;
  const options = httpOptions(data.http_headers);
  // Per-track credentials cannot be represented by one set of file-local headers.
  if (tracks.some(track => track.http_headers
    && JSON.stringify(httpOptions(track.http_headers)) !== JSON.stringify(options))) return null;
  return Object.freeze({ videoUrl, audioUrl, title: typeof data.title === 'string' ? data.title : '',
    httpOptions: Object.freeze(options) });
}

function cacheDeadline(stream) {
  const deadlines = [stream.videoUrl, stream.audioUrl].filter(Boolean).map(value => {
    const url = new URL(value);
    if (!url.hostname.endsWith('.googlevideo.com')) return 0;
    const expiry = Number(url.searchParams.get('expire'));
    return Number.isFinite(expiry) ? expiry * 1000 - playback.resolveExpiryMarginMs : 0;
  });
  return Math.min(...deadlines);
}

export class StreamResolver {
  constructor({ run = runCommandOutput, now = Date.now } = {}) {
    Object.assign(this, { run, now });
    this.cache = new Map();
  }

  /** @returns {Promise<ResolvedStream|null>} null selects mpv's original ytdl hook. */
  async resolve(videoId, { signal, prefetch = false } = {}) {
    signal?.throwIfAborted();
    if (!isVideoId(videoId)) return null;
    const cached = this.cache.get(videoId);
    if (cached && cached.until > this.now()) return cached.stream;
    this.cache.delete(videoId);
    try {
      const result = await this.run(resolverArguments(videoId, { prefetch }), {
        timeoutMs: playback.resolveTimeoutMs, signal, maxBytes: playback.resolveMaxBytes,
      });
      signal?.throwIfAborted();
      if (result.code !== 0) return null;
      const stream = selectStream(JSON.parse(result.stdout), videoId);
      if (!stream) return null;
      const until = cacheDeadline(stream);
      if (until > this.now()) {
        this.cache.set(videoId, { until, stream });
        while (this.cache.size > playback.resolveCacheEntries) this.cache.delete(this.cache.keys().next().value);
      }
      return stream;
    } catch {
      signal?.throwIfAborted();
      // Upstream text includes signed media URLs; failures deliberately carry no payload.
      return null;
    }
  }
}
