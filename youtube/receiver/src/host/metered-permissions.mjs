import { config } from '../config/receiver-config.mjs';
import { runCommand } from './process-command.mjs';

export const METERED_CONSUMERS = Object.freeze({ HD: 'pi.castit_hd', SAVES: 'pi.castit_saves' });
const consumers = new Set(Object.values(METERED_CONSUMERS));

// The CLI owns freshness, revisions and leases; raw HostState.permitted is not admission.
export class MeteredPermissions {
  constructor({ command = config.meteredCommand, run = runCommand, now = () => performance.now(),
    cacheMs = config.meteredCacheMs, timeoutMs = config.meteredTimeoutMs } = {}) {
    Object.assign(this, { command, run, now, cacheMs, timeoutMs });
    this.cache = new Map();
    this.pending = new Map();
  }

  async allows(consumer) {
    if (!consumers.has(consumer)) return false;
    const cached = this.cache.get(consumer);
    if (cached && this.now() < cached.expiresAt) return cached.permitted;
    if (this.pending.has(consumer)) return this.pending.get(consumer);
    const pending = Promise.resolve().then(() => this.run([this.command, 'allows', consumer],
      { timeoutMs: this.timeoutMs })).then(() => true, () => false).then(permitted => {
      this.cache.set(consumer, { permitted, expiresAt: this.now() + this.cacheMs });
      return permitted;
    }).finally(() => this.pending.delete(consumer));
    this.pending.set(consumer, pending);
    return pending;
  }
}
