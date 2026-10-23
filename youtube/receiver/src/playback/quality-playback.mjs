import { DEFAULT_QUALITY, QUALITY_OPTIONS, isQuality } from './quality.mjs';

// A setting response acknowledges persistence; resolution/reload completes in
// the background. Generation and player request checks keep Stop/new casts final.
export class QualityPlayback {
  constructor(player) {
    this.player = player;
    this.selected = this.saved = DEFAULT_QUALITY;
    this.generation = 0;
    this.cancel();
  }

  /** @returns {import('./quality.mjs').QualityStatus} */
  snapshot() {
    return { selected: this.selected, options: QUALITY_OPTIONS, loading: this.loading, error: this.error };
  }

  cancel() {
    ++this.generation;
    this.target = null;
    this.loading = this.error = false;
  }

  async set(value) {
    if (!isQuality(value)) return false;
    if (value === this.selected && !this.error && !this.loading) return true;
    const reloading = Boolean(this.target);
    const generation = ++this.generation;
    const request = this.player.request;
    this.selected = value;
    this.target ||= this.player.qualityTarget();
    this.loading = true;
    this.error = false;
    try { await this.player.saveSettings(); }
    catch {
      if (generation === this.generation) {
        this.selected = this.saved;
        this.loading = false;
        this.error = false;
        this.target = null;
      }
      this.player.log.warn('Quality setting update failed');
      return false;
    }
    this.saved = value;
    if (generation !== this.generation || request !== this.player.request) return true;
    if (!reloading) this.target = this.player.qualityTarget();
    if (!this.target) { this.loading = false; return true; }
    this.pending = this.player.reloadQuality(this.target).catch(() => false).then(started => {
      if (generation !== this.generation) return;
      this.loading = false;
      this.error = !started;
      this.target = null;
    });
    return true;
  }
}
