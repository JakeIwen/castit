import { DEFAULT_QUALITY } from './quality.mjs';
import { playback } from '../config/receiver-config.mjs';

// Queue ownership stays with CastQueue. Polling also sees entries added mid-video.
export class QueuePrefetch {
  constructor(resolver, snapshot, language = () => null, quality = () => DEFAULT_QUALITY) {
    Object.assign(this, { resolver, snapshot, language, quality });
  }

  start(signal) {
    this.abort = new AbortController();
    this.signal = AbortSignal.any([signal, this.abort.signal]);
    this.signal.addEventListener('abort', () => clearInterval(this.timer), { once: true });
    this.attempted = null;
    this.timer = setInterval(() => this.tick(), playback.prefetchIntervalMs);
    this.timer.unref?.();
    this.tick();
  }

  tick() {
    if (!this.signal || this.signal.aborted || this.pending) return;
    const next = this.snapshot()[0];
    const language = this.language();
    const quality = this.quality();
    const key = `${next?.id}:${language || ''}:${quality}`;
    if (!next || key === this.attempted) return;
    this.attempted = key;
    this.pending = this.resolver.resolve(next.id, { signal: this.signal, prefetch: true, language, quality })
      .catch(() => {}).finally(() => { this.pending = null; });
  }

  async stop() {
    this.abort?.abort();
    clearInterval(this.timer);
    await this.pending;
  }
}
