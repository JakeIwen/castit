import { setTimeout as delay } from 'node:timers/promises';
import { DOWNLOAD_STATES, STORE_LIMITS, VideoStoreError, downloadStatus } from './contracts.mjs';
import { MeteredPermissions, METERED_CONSUMERS } from '../host/metered-permissions.mjs';
import { complete, cachedBytes } from './ranges.mjs';

export class VideoDownloads {
  constructor(store, { permissions = new MeteredPermissions(),
    wait = (ms, signal) => delay(ms, undefined, { signal, ref: false }) } = {}) {
    Object.assign(this, { store, permissions, wait });
    this.jobs = new Map();
    this.tail = Promise.resolve();
    this.abort = new AbortController();
  }

  status(id) {
    const job = this.jobs.get(id);
    if (job) return { state: job.state, progress: job.progress, error: job.error };
    return this.store.available && this.store.library.videos.has(id) ? downloadStatus(DOWNLOAD_STATES.SAVED, 1) : null;
  }

  snapshot() {
    return [...this.jobs.values()].map(({ id, title, state, progress, error }) => ({ id, title, state, progress, error }));
  }

  async request(id, quality) {
    const { disk, library, retention } = this.store;
    await disk.require(true);
    const existing = this.jobs.get(id);
    if (existing?.pending) return true;
    if (await library.find(id)) return true;
    if (this.jobs.get(id)?.pending) return true;
    const job = { id, title: id, ...downloadStatus(DOWNLOAD_STATES.WAITING, null, 'Queued to save') };
    this.jobs.set(id, job);
    const keeping = retention.keep(id);
    job.pending = this.tail.catch(() => {}).then(() => keeping).then(() => this.run(job, quality)).catch(error => {
      Object.assign(job, downloadStatus(DOWNLOAD_STATES.ERROR, job.progress,
        error instanceof VideoStoreError ? error.message : 'Download failed; retry to resume cached bytes'));
    }).finally(() => { job.pending = null; retention.held.delete(id); });
    this.tail = job.pending;
    await keeping;
    return true;
  }

  async waitForPermission(job, signal) {
    for (;;) {
      signal.throwIfAborted();
      const permitted = await this.permissions.allows(METERED_CONSUMERS.SAVES);
      signal.throwIfAborted();
      if (permitted) {
        Object.assign(job, downloadStatus(DOWNLOAD_STATES.DOWNLOADING, job.progress));
        return;
      }
      Object.assign(job, downloadStatus(DOWNLOAD_STATES.WAITING, job.progress,
        'Waiting for metered connection permission'));
      // Slower than the permission cache so each retry asks for fresh admission.
      await this.wait(STORE_LIMITS.saveRetryMs, signal);
    }
  }

  async run(job, quality) {
    const { entries, library, retention, transfer } = this.store;
    const signal = this.abort.signal;
    await this.waitForPermission(job, signal);
    const session = await this.store.downloadSession(job.id, quality, signal);
    if (!session) throw new VideoStoreError('This video cannot be downloaded (no direct stream)');
    const { entry } = session;
    entry.keep = true;
    await entries.save(entry);
    job.title = entry.title;
    const tracks = entries.selection(entry, session.quality);
    const progress = () => {
      const total = tracks.every(track => track.size !== null) ? tracks.reduce((n, track) => n + track.size, 0) : 0;
      job.progress = total ? Math.min(1, tracks.reduce((n, track) => n + cachedBytes(track), 0) / total) : null;
    };
    session.onProgress = progress;
    for (const track of tracks) {
      await transfer.size(session, track, signal);
      progress();
      await transfer.ensure(session, track, 0, track.size, signal);
    }
    if (!tracks.every(complete)) throw new Error('Download incomplete');
    Object.assign(job, downloadStatus(DOWNLOAD_STATES.FINALIZING, 1));
    await library.save(entry, tracks, session.quality, signal);
    entry.promoted = true;
    await entries.save(entry);
    // mpv may still be reading either the sparse files or their proxy URLs. The
    // mux has different byte offsets: remove its inputs only after mpv closes.
    if (retention.active !== entry.id) await entries.remove(entry.id);
    Object.assign(job, downloadStatus(DOWNLOAD_STATES.SAVED, 1));
  }

  async close() {
    this.abort.abort();
    await this.tail;
  }
}
