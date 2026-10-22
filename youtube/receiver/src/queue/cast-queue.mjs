import { config } from '../config/receiver-config.mjs';
import { isVideoId } from '../youtube/video-id.mjs';

const MAX_TITLE_LENGTH = 200;
const PLAYED_LIMIT = 20;

// Best-effort title for a queued video; null when YouTube doesn't answer.
export async function fetchTitle(id, { fetcher = globalThis.fetch } = {}) {
  const url = new URL(config.titleLookupUrl);
  url.searchParams.set('url', `https://www.youtube.com/watch?v=${id}`);
  url.searchParams.set('format', 'json');
  const response = await fetcher(url, { signal: AbortSignal.timeout(config.titleLookupTimeoutMs) });
  if (!response.ok) return null;
  const { title } = await response.json();
  return typeof title === 'string' && title ? title.slice(0, MAX_TITLE_LENGTH) : null;
}

// Videos queued by senders without a lounge session (the extension, vantv).
// The phone keeps its own queue in the library; these play once that runs out.
// Entries carry a key so a remove or play-now names the entry the sender saw,
// even after the list has moved on.
export class CastQueue {
  constructor({ lookupTitle = fetchTitle, limit = config.queueLimit } = {}) {
    Object.assign(this, { lookupTitle, limit });
    this.entries = [];
    this.played = [];
    this.lastKey = 0;
  }

  get length() { return this.entries.length; }

  add(id) {
    if (!isVideoId(id) || this.entries.length >= this.limit) return null;
    const entry = { key: ++this.lastKey, id, title: null };
    this.entries.push(entry);
    void Promise.resolve().then(() => this.lookupTitle(id))
      .then(title => { entry.title = title ?? null; }, () => {});
    return entry;
  }

  // Removes and returns the first entry, or the one with `key`.
  take(key) {
    const index = key === undefined ? 0 : this.entries.findIndex(entry => entry.key === key);
    return index < 0 ? null : this.entries.splice(index, 1)[0] ?? null;
  }

  move(key, index) {
    if (!Number.isSafeInteger(key) || !Number.isSafeInteger(index) || index < 0) return false;
    const entry = this.take(key);
    if (!entry) return false;
    this.entries.splice(Math.min(index, this.entries.length), 0, entry);
    return true;
  }

  recordPlayed(video, queuedEntry) {
    if (!isVideoId(video?.id)) return null;
    const entry = { key: ++this.lastKey, id: video.id,
      // Keep the loaded object and pending oEmbed lookup live, not their initial titles.
      get title() { return (video.title && video.title !== video.id ? video.title : queuedEntry?.title) || null; },
    };
    this.played = this.played.filter(previous => previous.id !== video.id);
    this.played.push(entry);
    // Keep room for the current video as well as the 20 visible previous videos.
    this.played = this.played.slice(-(PLAYED_LIMIT + 1));
    return { ...entry };
  }

  playedSnapshot(currentVideo) {
    return this.played.filter(entry => entry.id !== currentVideo?.id)
      .slice(-PLAYED_LIMIT).map(entry => ({ ...entry }));
  }

  findPlayed(key, currentVideo) {
    return this.playedSnapshot(currentVideo).find(entry => entry.key === key) ?? null;
  }

  clear() { this.entries = []; }

  snapshot() { return this.entries.map(({ key, id, title }) => ({ key, id, title })); }
}
