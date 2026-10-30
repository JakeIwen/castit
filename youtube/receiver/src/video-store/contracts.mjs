export const UNKNOWN_CHANNEL = 'Unknown channel';
export const TRACK_ROLES = Object.freeze({ VIDEO: 'video', AUDIO: 'audio' });
export const SOURCES = Object.freeze({ WEB: 'web', CACHE: 'cache', SAVED: 'saved' });
export const DOWNLOAD_STATES = Object.freeze({
  DOWNLOADING: 'downloading', FINALIZING: 'finalizing', SAVED: 'saved', ERROR: 'error',
});
export const STORE_LIMITS = Object.freeze({
  chunkBytes: 10 * 1024 * 1024, readBytes: 1024 * 1024,
  freeBytes: 2 * 1024 ** 3, retentionMs: 10 * 60 * 1000,
  upstreamTimeoutMs: 60_000, muxTimeoutMs: 30 * 60 * 1000,
});

export class VideoStoreError extends Error {
  constructor(message, statusCode = 409) {
    super(message);
    this.name = 'VideoStoreError';
    this.statusCode = statusCode;
  }
}

/**
 * @typedef {{formatId: string, role: 'video'|'audio', size: number|null,
 * ext: string|null, vcodec: string, acodec: string}} TrackMetadata
 * @typedef {TrackMetadata & {url: string, headers: Record<string, string>}} ResolvedTrack
 * @typedef {TrackMetadata & {ranges: [number, number][]}} CacheTrack
 * @typedef {{id: string, title: string, channel: string, duration: number|null,
 * keep: boolean, touchedAt: number, departedAt: number|null, promoted?: boolean,
 * selections: Record<string, string[]>, tracks: Record<string, CacheTrack>}} CacheEntry
 * @typedef {{id: string, title: string, channel: string, duration: number|null,
 * bytes: number, savedAt: string, quality: string, codecs: object[], file: string}} SavedVideo
 *
 * Ranges are half-open byte intervals; URLs/credentials stay in memory, not metadata.
 */
export function downloadStatus(state, progress = null, error = null) {
  return { state, progress, error };
}
