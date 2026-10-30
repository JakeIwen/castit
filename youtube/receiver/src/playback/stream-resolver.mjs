import { playback, resolverArguments } from '../config/receiver-config.mjs';
import { CommandTimeoutError, runCommandOutput } from '../host/process-command.mjs';
import { isSubtitleLanguage, selectSubtitle } from './subtitles.mjs';
import { DEFAULT_QUALITY, isQuality, withinQuality } from './quality.mjs';
import { isVideoId } from '../youtube/video-id.mjs';
import { UNKNOWN_CHANNEL, TRACK_ROLES } from '../video-store/contracts.mjs';

/**
 * @typedef {object} ResolvedStream
 * @property {string} videoUrl
 * @property {string|null} audioUrl
 * @property {import('./subtitles.mjs').SubtitleTrack|null} [subtitle]
 * @property {string} [subtitleLanguage]
 * @property {string} title
 * @property {string} channel
 * @property {number|null} duration
 * @property {import('../video-store/contracts.mjs').ResolvedTrack[]} tracks
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

function selectStream(data, videoId, quality) {
  if (!data || data.id !== videoId || (data._type && data._type !== 'video') || data.is_live
    || data.has_drm) return null;
  const tracks = data.requested_formats || [data];
  if (!Array.isArray(tracks) || !tracks.length || tracks.length > 2) return null;
  const video = tracks.find(track => track.vcodec && track.vcodec !== 'none');
  const audio = tracks.find(track => track.vcodec === 'none' && track.acodec && track.acodec !== 'none');
  if (!video || !withinQuality(video, quality) || (tracks.length === 2 && (!audio || video.acodec !== 'none'))) return null;
  const videoUrl = directUrl(video);
  const audioUrl = audio ? directUrl(audio) : null;
  if (!videoUrl || (audio && !audioUrl)) return null;
  // yt-dlp now puts headers only on each format; a track without its own uses
  // the top-level set. Differing per-track credentials cannot be represented by
  // one set of file-local headers.
  const trackOptions = tracks.map(track => httpOptions(track.http_headers ?? data.http_headers));
  const options = trackOptions[0];
  if (trackOptions.some(other => JSON.stringify(other) !== JSON.stringify(options))) return null;
  return Object.freeze({ videoUrl, audioUrl, title: typeof data.title === 'string' ? data.title : '',
    channel: typeof data.channel === 'string' ? data.channel : (typeof data.uploader === 'string' ? data.uploader : UNKNOWN_CHANNEL),
    duration: Number.isFinite(data.duration) && data.duration >= 0 ? data.duration : null,
    tracks: [video, audio].filter(Boolean).map(track => ({
      formatId: String(track.format_id ?? ''), role: track === video ? TRACK_ROLES.VIDEO : TRACK_ROLES.AUDIO,
      url: track.url, headers: { ...(track.http_headers ?? data.http_headers ?? {}) },
      size: Number.isSafeInteger(track.filesize) && track.filesize > 0 ? track.filesize : null,
      ext: track.ext || null, vcodec: track.vcodec || 'none', acodec: track.acodec || 'none',
    })), httpOptions: Object.freeze(options) });
}

function cacheDeadline(stream, subtitle) {
  const urls = [stream?.videoUrl, stream?.audioUrl, subtitle?.url].filter(Boolean);
  if (!urls.length) return 0;
  return Math.min(...urls.map(value => {
    const expiry = Number(new URL(value).searchParams.get('expire'));
    return Number.isFinite(expiry) ? expiry * 1000 - playback.resolveExpiryMarginMs : 0;
  }));
}

export class StreamResolver {
  constructor({ run = runCommandOutput, now = Date.now } = {}) {
    Object.assign(this, { run, now });
    this.cache = new Map();
  }

  /**
   * @returns {Promise<ResolvedStream|null>} null selects mpv's original ytdl hook.
   * @throws {CommandTimeoutError} An exhausted extraction budget must not select the hook.
   */
  async resolve(videoId, options = {}) {
    return (await this.extract(videoId, options))?.stream ?? null;
  }

  // undefined means extraction failed; null means the language has no usable track.
  async resolveSubtitle(videoId, options) {
    return (await this.extract(videoId, options))?.subtitle;
  }

  async extract(videoId, { signal, prefetch = false, language = null, quality = DEFAULT_QUALITY, fresh = false } = {}) {
    signal?.throwIfAborted();
    if (!isQuality(quality) || !isVideoId(videoId) || (language !== null && !isSubtitleLanguage(language))) return null;
    language = language?.toLowerCase() ?? null;
    const key = `${videoId}:${language || ''}:${quality}`;
    const cached = this.cache.get(key);
    if (!fresh && cached && cached.until > this.now()) return cached.result;
    this.cache.delete(key);
    try {
      const result = await this.run(resolverArguments(videoId, { prefetch, language, quality }), {
        timeoutMs: playback.resolveTimeoutMs, signal, maxBytes: playback.resolveMaxBytes,
      });
      signal?.throwIfAborted();
      if (result.code !== 0) return null;
      const data = JSON.parse(result.stdout);
      if (!data || data.id !== videoId || (data._type && data._type !== 'video')) return null;
      const subtitle = language ? selectSubtitle(data, language) : null;
      const direct = selectStream(data, videoId, quality);
      const stream = direct && language
        ? Object.freeze({ ...direct, subtitle, subtitleLanguage: language }) : direct;
      const selected = { stream, subtitle };
      const until = cacheDeadline(stream, subtitle);
      if (until > this.now()) {
        this.cache.set(key, { until, result: selected });
        while (this.cache.size > playback.resolveCacheEntries) this.cache.delete(this.cache.keys().next().value);
      }
      return selected;
    } catch (error) {
      signal?.throwIfAborted();
      // A hook retry repeats the same extraction after its entire budget is spent.
      if (error instanceof CommandTimeoutError) throw error;
      // Upstream text includes signed media URLs; failures deliberately carry no payload.
      return null;
    }
  }
}
