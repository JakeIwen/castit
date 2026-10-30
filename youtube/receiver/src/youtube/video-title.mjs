import { parseYouTubeVideo } from './video-url.mjs';

const MAX_TITLE_LENGTH = 200;

// Line breaks and tabs separate words; invisible format characters (bidi
// overrides) are dropped, except the joiner that builds emoji sequences.
export function normalizeVideoTitle(title) {
  if (typeof title !== 'string') return null;
  const text = title.replace(/\p{Cc}/gu, ' ').replace(/(?!\u200d)\p{Cf}/gu, '')
    .replace(/\s+/gu, ' ').trim();
  return Array.from(text).slice(0, MAX_TITLE_LENGTH).join('') || null;
}

// mpv initially uses the watch URL's filename before metadata is available.
export function isPlaceholderTitle(title, id) {
  if (title === id || title === `watch?v=${id}`) return true;
  return parseYouTubeVideo(title)?.videoId === id && new URL(title).pathname === '/watch';
}
