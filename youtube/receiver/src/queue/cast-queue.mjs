import { config } from '../config/receiver-config.mjs';
import { isVideoId } from '../youtube/video-id.mjs';

const MAX_TITLE_LENGTH = 200;
const PLAYED_LIMIT = 20;
const STORE_KEY = 'queue';

function storedTitle(title) {
  return typeof title === 'string' && title ? title.slice(0, MAX_TITLE_LENGTH) : null;
}

// Saved entries are re-validated: the file outlives any one release.
function storedEntries(value, limit) {
  if (!Array.isArray(value)) return [];
  return value.filter(entry => isVideoId(entry?.id)).slice(-limit)
    .map(entry => ({ id: entry.id, title: storedTitle(entry.title) }));
}

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
// The phone keeps its own queue in the library; explicit additions play first.
// Entries carry a key so a remove or play-now names the entry the sender saw,
// even after the list has moved on. With a store, both lists survive Stop,
// disconnects and restarts; restoring them never starts playback.
export class CastQueue {
  constructor({ lookupTitle = fetchTitle, limit = config.queueLimit, store = null, log = console } = {}) {
    Object.assign(this, { lookupTitle, limit, store, log });
    this.entries = [];
    this.played = [];
    this.lastKey = 0;
    this.writes = Promise.resolve();
  }

  async load() {
    let saved;
    try { saved = await this.store?.get(STORE_KEY); } catch { this.log.warn('Saved queue unreadable; starting empty'); }
    this.entries = storedEntries(saved?.upcoming, this.limit).map(entry => ({ key: ++this.lastKey, ...entry }));
    this.played = storedEntries(saved?.played, PLAYED_LIMIT + 1).map(entry => ({ key: ++this.lastKey, ...entry }));
  }

  // Writes are chained so a slow write never lands after a newer one.
  save() {
    if (!this.store) return this.writes;
    const state = {
      upcoming: this.entries.map(({ id, title }) => ({ id, title })),
      played: this.played.map(({ id, title }) => ({ id, title })),
    };
    this.writes = this.writes.then(() => this.store.set(STORE_KEY, state))
      .catch(() => this.log.warn('Queue save failed'));
    return this.writes;
  }

  get length() { return this.entries.length; }

  add(id) {
    if (!isVideoId(id) || this.entries.length >= this.limit) return null;
    const entry = { key: ++this.lastKey, id, title: null };
    this.entries.push(entry);
    void this.save();
    void Promise.resolve().then(() => this.lookupTitle(id))
      .then(title => { entry.title = title ?? null; void this.save(); }, () => {});
    return entry;
  }

  // Removes and returns the first entry, or the one with `key`.
  take(key) {
    const index = key === undefined ? 0 : this.entries.findIndex(entry => entry.key === key);
    const entry = index < 0 ? null : this.entries.splice(index, 1)[0] ?? null;
    if (entry) void this.save();
    return entry;
  }

  move(key, index) {
    if (!Number.isSafeInteger(key) || !Number.isSafeInteger(index) || index < 0) return false;
    const entry = this.take(key);
    if (!entry) return false;
    this.entries.splice(Math.min(index, this.entries.length), 0, entry);
    void this.save();
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
    void this.save();
    return { ...entry };
  }

  playedSnapshot(currentVideo) {
    return this.played.filter(entry => entry.id !== currentVideo?.id)
      .slice(-PLAYED_LIMIT).map(entry => ({ ...entry }));
  }

  findPlayed(key, currentVideo) {
    return this.playedSnapshot(currentVideo).find(entry => entry.key === key) ?? null;
  }

  previousPlayed(video) {
    const index = this.played.findIndex(entry => entry.id === video?.id);
    return (index < 0 ? this.played : this.played.slice(0, index)).at(-1) ?? null;
  }

  returnNext(video) {
    if (!isVideoId(video?.id) || this.length >= this.limit) return null;
    const entry = { key: ++this.lastKey, id: video.id,
      title: storedTitle(video.title === video.id ? null : video.title) };
    this.entries.unshift(entry);
    void this.save();
    return entry;
  }

  forgetPlayed(ids) {
    this.played = this.played.filter(entry => !ids.includes(entry.id));
    void this.save();
  }

  clear() { this.entries = []; void this.save(); }

  snapshot() { return this.entries.map(({ key, id, title }) => ({ key, id, title })); }
}
