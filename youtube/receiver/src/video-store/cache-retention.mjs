import { STORE_LIMITS } from './contracts.mjs';

export class CacheRetention {
  constructor(entries, { now = Date.now, setTimer = setTimeout, clearTimer = clearTimeout } = {}) {
    Object.assign(this, { entries, now, setTimer, clearTimer });
    this.timers = new Map();
    this.expiring = new Map();
    this.held = new Set();
    this.active = null;
  }

  cancel(id) {
    this.clearTimer(this.timers.get(id));
    this.timers.delete(id);
  }

  async activate(id) {
    this.active = id;
    this.cancel(id);
    await this.expiring.get(id);
    const entry = await this.entries.get(id);
    if (!entry) return;
    entry.departedAt = null;
    entry.touchedAt = this.now();
    await this.entries.save(entry).catch(() => {});
  }

  async depart() {
    const id = this.active;
    this.active = null;
    if (!id) return;
    const entry = await this.entries.get(id);
    if (!entry) return;
    entry.departedAt = this.now();
    await this.entries.save(entry).catch(() => {});
    if (entry.promoted && !this.held.has(id)) await this.entries.remove(id).catch(() => {});
    else this.schedule(entry);
  }

  schedule(entry) {
    this.cancel(entry.id);
    if (entry.keep || entry.id === this.active || this.held.has(entry.id)) return;
    const deadline = (entry.departedAt ?? entry.touchedAt) + STORE_LIMITS.retentionMs;
    const timer = this.setTimer(() => this.expire(entry), Math.max(0, deadline - this.now()));
    timer?.unref?.();
    this.timers.set(entry.id, timer);
  }

  async expire(entry) {
    this.timers.delete(entry.id);
    if (entry.keep || entry.id === this.active || this.held.has(entry.id)) return;
    const removing = this.entries.remove(entry.id).catch(() => {});
    this.expiring.set(entry.id, removing);
    try { await removing; }
    finally { this.expiring.delete(entry.id); }
  }

  async sweep() {
    for (const entry of await this.entries.all()) {
      if (entry.promoted && entry.id !== this.active) await this.entries.remove(entry.id);
      else if (!entry.keep && (entry.departedAt ?? entry.touchedAt) + STORE_LIMITS.retentionMs <= this.now()) {
        await this.expire(entry);
      } else this.schedule(entry);
    }
  }

  async keep(id) {
    this.held.add(id);
    this.cancel(id);
    await this.expiring.get(id);
    const entry = await this.entries.get(id);
    if (entry) { entry.keep = true; await this.entries.save(entry); }
  }

  async close() {
    for (const id of this.timers.keys()) this.cancel(id);
    await Promise.allSettled([...this.expiring.values()]);
  }
}
