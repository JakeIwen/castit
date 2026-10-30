import { isVideoId } from '../youtube/video-id.mjs';
import { DEFAULT_QUALITY } from '../playback/quality.mjs';
import { StoreDisk } from './store-disk.mjs';
import { CacheEntries } from './cache-entries.mjs';
import { CacheRetention } from './cache-retention.mjs';
import { RangeTransfer } from './range-transfer.mjs';
import { CachingProxy } from './caching-proxy.mjs';
import { SavedLibrary } from './saved-library.mjs';
import { VideoDownloads } from './video-downloads.mjs';
import { SOURCES, DOWNLOAD_STATES, VideoStoreError, downloadStatus } from './contracts.mjs';

/** Public boundary for playback, controls and HTTP. No drive handles survive a request. */
export class VideoStore {
  constructor({ root, resolver, disk = new StoreDisk(root), now = Date.now,
    setTimer, clearTimer, fetcher, run, ffmpeg } = {}) {
    Object.assign(this, { disk, resolver });
    this.entries = new CacheEntries(disk, now);
    this.retention = new CacheRetention(this.entries, { now, setTimer, clearTimer });
    this.transfer = new RangeTransfer(this.entries, resolver, { fetcher });
    this.proxy = new CachingProxy(this.entries, this.transfer);
    this.library = new SavedLibrary(disk, { now, run, ffmpeg });
    this.downloads = new VideoDownloads(this);
    this.available = false;
    this.source = null;
  }

  async initialize() { await this.refresh(); }

  async refresh() {
    const state = await this.disk.inspect();
    const mounted = !this.available && state.available;
    this.available = state.available;
    if (mounted) {
      try {
        await this.library.scan();
        await this.retention.sweep();
        for (const entry of await this.entries.all()) {
          if (entry.keep && !entry.promoted && !this.downloads.jobs.has(entry.id)) {
            this.downloads.jobs.set(entry.id, { id: entry.id, title: entry.title,
              ...downloadStatus(DOWNLOAD_STATES.ERROR, null, 'Download interrupted; retry to resume cached bytes') });
          }
        }
      } catch { this.available = false; }
    }
    return { ...state, available: this.available };
  }

  snapshot(id) {
    return { source: id ? this.source : null, download: id ? this.downloads.status(id) : null,
      library: { available: this.available } };
  }

  async list() {
    let state = await this.refresh();
    if (state.available) {
      try { await this.library.scan(); }
      catch { this.available = false; state = { available: false, freeBytes: null }; }
    }
    return { ...state, channels: state.available ? this.library.channels() : [], downloads: this.downloads.snapshot() };
  }

  async local(id, quality = DEFAULT_QUALITY) {
    if (!(await this.disk.inspect()).available) return null;
    try {
      const saved = await this.library.find(id);
      if (saved) return { videoUrl: saved.path, audioUrl: null, title: saved.title, duration: saved.duration,
        httpOptions: {}, local: true, source: SOURCES.SAVED };
      const cached = await this.entries.local(id, quality);
      if (!cached) return null;
      return { videoUrl: this.disk.trackPath(cached.entry, cached.tracks[0].formatId),
        audioUrl: cached.tracks[1] ? this.disk.trackPath(cached.entry, cached.tracks[1].formatId) : null,
        title: cached.entry.title, duration: cached.entry.duration, httpOptions: {}, local: true, source: SOURCES.CACHE };
    } catch { return null; }
  }

  async resolve(id, options) {
    await this.refresh();
    await this.retention.activate(id);
    const local = await this.local(id, options.quality);
    options.signal?.throwIfAborted();
    if (local) { this.source = local.source; return local; }
    this.source = SOURCES.WEB;
    const stream = await this.resolver.resolve(id, options);
    options.signal?.throwIfAborted();
    if (!stream) return null;
    try {
      await this.disk.require(true);
      const entry = await this.entries.attach(id, stream, options.quality);
      if (!entry) return stream;
      this.session = { entry, stream, quality: options.quality };
      return await this.proxy.stream(this.session, options.signal);
    } catch { options.signal?.throwIfAborted(); return stream; }
  }

  async prefetch(id, options) {
    if (await this.local(id, options.quality)) return;
    return this.resolver.resolve(id, options);
  }

  async downloadSession(id, quality, signal) {
    if (this.session?.entry.id === id) return this.session;
    const cached = await this.entries.local(id, quality);
    if (cached) return { entry: cached.entry, quality, stream: { tracks: [] } };
    const stream = await this.resolver.resolve(id, { quality, signal });
    const entry = stream && await this.entries.attach(id, stream, quality);
    return entry ? { entry, stream, quality } : null;
  }

  async download(id, quality = DEFAULT_QUALITY) {
    if (!isVideoId(id)) throw new VideoStoreError('No video selected for download');
    return this.downloads.request(id, quality);
  }

  async deleteSaved(id) {
    if (!isVideoId(id)) throw new VideoStoreError('Invalid video id');
    if (this.downloads.jobs.get(id)?.pending) throw new VideoStoreError('Wait for this download to finish before deleting');
    const removed = await this.library.delete(id);
    if (removed) this.downloads.jobs.delete(id);
    return removed;
  }

  async release() {
    this.source = null;
    this.session = null;
    await this.proxy.drain();
    await this.retention.depart();
  }

  async close() {
    await this.proxy.close();
    await this.downloads.close();
    await this.release();
    await this.retention.close();
  }
}
