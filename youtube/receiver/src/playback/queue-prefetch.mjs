import { playback } from '../config/receiver-config.mjs';

// Queue ownership stays with CastQueue. Polling also sees entries added mid-video.
export class QueuePrefetch {
  constructor(resolver, snapshot) {
    Object.assign(this, { resolver, snapshot });
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
    if (this.signal.aborted || this.pending) return;
    const next = this.snapshot()[0];
    if (!next || next.id === this.attempted) return;
    this.attempted = next.id;
    this.pending = this.resolver.resolve(next.id, { signal: this.signal, prefetch: true })
      .catch(() => {}).finally(() => { this.pending = null; });
  }

  async stop() {
    this.abort?.abort();
    clearInterval(this.timer);
    await this.pending;
  }
}
