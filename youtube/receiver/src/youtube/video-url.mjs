import { isVideoId } from './video-id.mjs';

const MAX_URL_LENGTH = 2048;
const VIDEO_HOSTS = ['www.youtube.com', 'youtube.com', 'm.youtube.com', 'music.youtube.com'];
const SHORT_HOSTS = ['youtu.be', 'www.youtu.be'];
const VIDEO_PATHS = ['/shorts/', '/live/', '/embed/'];

export function parseStartTime(value) {
  if (typeof value !== 'string' || !value) return 0;
  if (/^\d+(?:\.\d+)?$/.test(value)) {
    const seconds = Number(value);
    return Number.isFinite(seconds) && seconds >= 0 ? seconds : 0;
  }
  const units = /^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+(?:\.\d+)?)s)?$/i.exec(value);
  if (!units) return 0;
  const seconds = Number(units[1] || 0) * 3600
    + Number(units[2] || 0) * 60 + Number(units[3] || 0);
  return Number.isFinite(seconds) && seconds >= 0 ? seconds : 0;
}

// Mirrors the extension parser; the receiver is deployed without extension files.
export function parseYouTubeVideo(value) {
  if (typeof value !== 'string' || value.length > MAX_URL_LENGTH) return null;
  const input = value.trim();
  const authority = /^https?:\/\/([^/?#]+)(?:[/?#]|$)/i.exec(input);
  if (!authority || /\s|\\/.test(input)) return null;
  let url;
  try { url = new URL(input); } catch { return null; }
  // URL normalizes default ports and empty credentials away, so check the raw authority too.
  if (url.username || url.password || url.port || authority[1].toLowerCase() !== url.hostname) return null;
  let videoId;
  if (SHORT_HOSTS.includes(url.hostname)) {
    videoId = url.pathname.replace(/^\//, '').replace(/\/$/, '');
  } else if (VIDEO_HOSTS.includes(url.hostname)) {
    if (url.pathname === '/watch') videoId = url.searchParams.get('v');
    else {
      const prefix = VIDEO_PATHS.find(path => url.pathname.startsWith(path));
      if (prefix) videoId = url.pathname.slice(prefix.length).replace(/\/$/, '');
    }
  }
  if (!isVideoId(videoId)) return null;
  const fragment = new URLSearchParams(url.hash.slice(1));
  const start = url.searchParams.get('t') ?? url.searchParams.get('start') ?? fragment.get('t');
  return { videoId, position: parseStartTime(start) };
}
