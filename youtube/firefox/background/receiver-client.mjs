import '../config.js';
import { isPosition, isVideoId } from '../youtube/video-url.mjs';
import { decodeDiagnostics } from '../playback/diagnostics.mjs';

const config = globalThis.VAN_TV_CONFIG;
const states = Object.values(config.player);
const actions = Object.values(config.control);
const queueActions = Object.values(config.queue);
const isFiniteNumber = value => typeof value === 'number' && Number.isFinite(value);

/** @typedef {{key: number, id: string, title: string|null}} QueueEntry */
/** @typedef {{ok: boolean, player: string, video: {id: string, title: string}|null,
 * position: number, duration: number, audioDelay: number|null, speed: number|null,
 * diagnostics: import('../../receiver/src/playback/diagnostics.mjs').PlaybackDiagnostics|null,
 * quality: {selected: string, options: {value: string, label: string}[], loading: boolean, error: boolean}|null,
 * subtitles: {enabled: boolean, language: string, available: boolean|null, loading: boolean, error: boolean}|null,
 * volume: {level: number, muted: boolean}|null, queue: QueueEntry[]|null,
 * played: QueueEntry[]|null, canPlayNext: boolean|null,
 * watchHistory: {enabled: boolean, reason: string|null}|null}} ReceiverStatus */

function isQueueEntry(entry) {
  return Boolean(entry) && Number.isSafeInteger(entry.key) && isVideoId(entry.id)
    && (entry.title === null || typeof entry.title === 'string');
}

function decodeQueue(entries) {
  return Array.isArray(entries) && entries.every(isQueueEntry)
    ? entries.map(({ key, id, title }) => ({ key, id, title })) : null;
}

const historyReasons = Object.values(config.historyReason);

// Only the state the popup explains crosses into extension pages.
function decodeWatchHistory(history) {
  if (!history || typeof history.enabled !== 'boolean'
      || (history.reason !== null && !historyReasons.includes(history.reason))) return null;
  return { enabled: history.enabled, reason: history.reason };
}

function decodeVolume(volume) {
  return volume && isFiniteNumber(volume.level) && typeof volume.muted === 'boolean'
    ? { level: volume.level, muted: volume.muted } : null;
}

function validSubtitleLanguage(value) {
  return typeof value === 'string' && value.toLowerCase() !== 'all' && config.subtitleLanguagePattern.test(value);
}

function decodeSubtitles(value) {
  if (!value || typeof value.enabled !== 'boolean' || !validSubtitleLanguage(value.language)
      || (value.available !== null && typeof value.available !== 'boolean')
      || typeof value.loading !== 'boolean' || typeof value.error !== 'boolean') return null;
  const { enabled, language, available, loading, error } = value;
  return { enabled, language, available, loading, error };
}

function decodeQuality(value) {
  if (!value || typeof value.selected !== 'string' || !Array.isArray(value.options)
      || !value.options.length || value.options.length > 20
      || typeof value.loading !== 'boolean' || typeof value.error !== 'boolean') return null;
  const valid = option => option && typeof option.value === 'string' && /^[a-z0-9]{1,16}$/.test(option.value)
    && typeof option.label === 'string' && option.label.length > 0 && option.label.length <= 40;
  if (!value.options.every(valid) || !value.options.some(option => option.value === value.selected)
      || new Set(value.options.map(option => option.value)).size !== value.options.length) return null;
  const { selected, loading, error } = value;
  return { selected, loading, error, options: value.options.map(({ value, label }) => ({ value, label })) };
}

function subtitleFields(fields) {
  const { enabled, language } = fields ?? {};
  if ((enabled === undefined && language === undefined)
      || (enabled !== undefined && typeof enabled !== 'boolean')
      || (language !== undefined && !validSubtitleLanguage(language))) throw new Error('Invalid subtitle fields');
  return { enabled: enabled ?? true, ...(language === undefined ? {} : { language }) };
}

export function decodeStatus(value) {
  if (!value || typeof value.ok !== 'boolean' || !states.includes(value.player)
      || !isPosition(value.position) || !isPosition(value.duration)
      || (value.video !== null && (!value.video || !isVideoId(value.video.id)
        || typeof value.video.title !== 'string'))) {
    throw new Error('Invalid Van TV status response');
  }
  const { ok, player, video, position, duration } = value;
  // An older receiver omits newer settings; their controls stay off.
  const audioDelay = isFiniteNumber(value.audioDelay) ? value.audioDelay : null;
  const speed = isFiniteNumber(value.speed) ? value.speed : null;
  return { ok, player, video, position, duration, audioDelay, speed,
    canPlayNext: typeof value.canPlayNext === 'boolean' ? value.canPlayNext : null,
    diagnostics: decodeDiagnostics(value.diagnostics),
    quality: decodeQuality(value.quality), subtitles: decodeSubtitles(value.subtitles),
    volume: decodeVolume(value.volume), queue: decodeQueue(value.queue), played: decodeQueue(value.played),
    watchHistory: decodeWatchHistory(value.watchHistory) };
}

// Each action with fields takes exactly one absolute field or a relative offset.
const actionFields = Object.freeze({
  [config.control.seek]: { absolute: 'position', valid: isPosition, error: 'Invalid seek fields' },
  [config.control.audioDelay]: { absolute: 'delay', valid: isFiniteNumber, error: 'Invalid audio delay fields' },
  [config.control.speed]: { absolute: 'speed', valid: isFiniteNumber, error: 'Invalid speed fields' },
  [config.control.volume]: { absolute: 'level', valid: isFiniteNumber, error: 'Invalid volume fields' },
});

function controlBody(action, fields) {
  if (!actions.includes(action)) throw new Error('Unknown playback action');
  if (action === config.control.quality) {
    if (typeof fields?.quality !== 'string' || !/^[a-z0-9]{1,16}$/.test(fields.quality)) {
      throw new Error('Invalid quality fields');
    }
    return { action, quality: fields.quality };
  }
  if (action === config.control.subtitles) return { action, ...subtitleFields(fields) };
  // Mute toggles unless told which way.
  if (action === config.control.mute) {
    if (fields?.muted === undefined) return { action };
    if (typeof fields.muted !== 'boolean') throw new Error('Invalid mute fields');
    return { action, muted: fields.muted };
  }
  const spec = actionFields[action];
  if (!spec) return { action };
  if (!fields || typeof fields !== 'object' || Array.isArray(fields)) throw new Error(spec.error);
  const hasAbsolute = Object.hasOwn(fields, spec.absolute);
  const hasOffset = Object.hasOwn(fields, 'offset');
  const validAbsolute = hasAbsolute && spec.valid(fields[spec.absolute]);
  const validOffset = hasOffset && isFiniteNumber(fields.offset);
  if (hasAbsolute === hasOffset || !validAbsolute && !validOffset) throw new Error(spec.error);
  return hasAbsolute ? { action, [spec.absolute]: fields[spec.absolute] } : { action, offset: fields.offset };
}

async function requestJson(fetcher, url, options, timeoutMs) {
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), timeoutMs);
  try {
    const response = await fetcher(url, {
      ...options, signal: abort.signal, cache: 'no-store', credentials: 'omit', redirect: 'error',
    });
    if (!response.ok) {
      if (response.status === 503) throw new Error('Van TV receiver is not running');
      throw new Error(`Van TV request failed (HTTP ${response.status})`);
    }
    return await response.json();
  } finally { clearTimeout(timer); }
}

export function createReceiverClient({ fetcher = globalThis.fetch,
  baseUrls = config.receiverUrls, timeoutMs = config.requestTimeoutMs } = {}) {
  let preferred;

  async function status() {
    const urls = [...new Set([preferred, ...baseUrls].filter(Boolean))];
    for (const base of urls) {
      try {
        const result = decodeStatus(await requestJson(fetcher, `${base}/api/status`, {}, timeoutMs));
        preferred = base;
        return result;
      } catch (error) {
        if (!(error instanceof TypeError) && error.name !== 'AbortError') throw error;
      }
    }
    throw new Error('Van TV unreachable');
  }

  async function post(path, body) {
    // Probe the read endpoint for failover before a write. A lost POST response
    // is ambiguous, so never replay that write through the second address.
    await status();
    try {
      return await requestJson(fetcher, `${preferred}${path}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
      }, timeoutMs);
    } catch (error) {
      if (error instanceof TypeError || error.name === 'AbortError') {
        throw new Error('Van TV unreachable; request may have been accepted');
      }
      throw error;
    }
  }

  async function cast(videoId, position = 0) {
    if (!isVideoId(videoId) || !isPosition(position)) throw new Error('Invalid YouTube video or position');
    const result = await post('/api/cast', { videoId, position });
    if (result?.videoId !== videoId || !isPosition(result.position)) {
      throw new Error('Invalid Van TV cast response; check playback before retrying');
    }
    return result;
  }

  async function control(action, fields = {}) {
    const body = controlBody(action, fields);
    const result = await post('/api/control', body);
    if (result?.action !== action || typeof result.done !== 'boolean') {
      throw new Error('Invalid Van TV control response; check playback before retrying');
    }
    return result;
  }

  async function queue(action, fields = {}) {
    if (!queueActions.includes(action)) throw new Error('Unknown queue action');
    const body = { action };
    if (action === config.queue.add) {
      if (!isVideoId(fields?.videoId)) throw new Error('Invalid YouTube video');
      body.videoId = fields.videoId;
    } else if (action === config.queue.remove && fields?.current !== undefined) {
      // The now-playing video has no queue key; the receiver matches its id.
      if (!isVideoId(fields.current)) throw new Error('Invalid YouTube video');
      body.current = fields.current;
    } else if (action !== config.queue.clear) {
      if (!Number.isSafeInteger(fields?.key)) throw new Error('Invalid queue entry');
      body.key = fields.key;
    }
    if (action === config.queue.move) {
      if (!Number.isSafeInteger(fields.index) || fields.index < 0) throw new Error('Invalid queue index');
      body.index = fields.index;
    }
    const result = await post('/api/queue', body);
    if (result?.action !== action || typeof result.done !== 'boolean') {
      throw new Error('Invalid Van TV queue response; check the queue before retrying');
    }
    return result;
  }

  return { status, cast, control, queue };
}
