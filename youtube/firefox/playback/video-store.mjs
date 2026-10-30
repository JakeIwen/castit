import '../config.js';
import { isVideoId, isPosition } from '../youtube/video-url.mjs';

const { downloadState, source } = globalThis.VAN_TV_CONFIG;
const downloadStates = Object.values(downloadState);
const sources = Object.values(source);
const nonnegative = value => typeof value === 'number' && Number.isFinite(value) && value >= 0;

/** @typedef {{state: string, progress: number|null, error: string|null}} Download */
/** @typedef {{id: string, title: string, channel: string, duration: number|null, bytes: number, savedAt: string|number}} SavedVideo */
/** @typedef {{available: boolean, freeBytes: number|null, channels: {channel: string, videos: SavedVideo[]}[], downloads: (Download & {id: string, title: string})[]}} VideoLibrary */

export function decodeSource(value) {
  return sources.includes(value) ? value : null;
}

/** @returns {Download|null} */
export function decodeDownload(value) {
  if (!value || !downloadStates.includes(value.state)
      || (value.progress !== null && (!nonnegative(value.progress) || value.progress > 1))
      || (value.error !== null && typeof value.error !== 'string')) return null;
  const { state, progress, error } = value;
  return { state, progress, error };
}

export function decodeLibraryAvailability(value) {
  return value && typeof value.available === 'boolean' ? { available: value.available } : null;
}

function decodeSavedVideo(value) {
  if (!value || !isVideoId(value.id) || typeof value.title !== 'string'
      || typeof value.channel !== 'string' || (value.duration !== null && !isPosition(value.duration))
      || !nonnegative(value.bytes) || !['string', 'number'].includes(typeof value.savedAt)
      || !Number.isFinite(new Date(value.savedAt).getTime())) throw new Error('Invalid Van TV library response');
  const { id, title, channel, duration, bytes, savedAt } = value;
  return { id, title, channel, duration, bytes, savedAt };
}

/** @returns {VideoLibrary} */
export function decodeLibrary(value) {
  const invalid = () => { throw new Error('Invalid Van TV library response'); };
  if (!decodeLibraryAvailability(value) || (value.freeBytes !== null && !nonnegative(value.freeBytes))
      || !Array.isArray(value.channels) || !Array.isArray(value.downloads)) invalid();
  const channels = value.channels.map(group => {
    if (!group || typeof group.channel !== 'string' || !Array.isArray(group.videos)) invalid();
    return { channel: group.channel, videos: group.videos.map(decodeSavedVideo) };
  });
  const downloads = value.downloads.map(item => {
    const download = decodeDownload(item);
    if (!download || !isVideoId(item.id) || typeof item.title !== 'string') invalid();
    return { id: item.id, title: item.title, ...download };
  });
  return { available: value.available, freeBytes: value.freeBytes, channels, downloads };
}
