import { Constants } from 'yt-cast-receiver';
import { isVideoId } from '../youtube/video-id.mjs';
import { HistoryFailure, YtdlpHistory } from './ytdlp-history.mjs';

export const WATCH_HISTORY_PLAYING_MS = 20_000;
const SAMPLE_MS = 1000;
const Status = Constants.PLAYER_STATUSES;

// Public lifecycle: start(player), snapshot(), stop(). refresh() also permits
// an immediate cookie-file recheck without changing the playback clock.
export class WatchHistory {
  constructor({ marker = new YtdlpHistory(), now = () => performance.now(),
    wallNow = () => new Date(), every = setInterval, cancel = clearInterval, log = console } = {}) {
    Object.assign(this, { marker, now, wallNow, every, cancel, log });
    this.status = { enabled: false, state: 'off', reason: null, lastMarkedAt: null };
    this.closed = false;
  }

  start(player) {
    if (this.player || this.closed) return;
    this.player = player;
    this.lastSample = this.now();
    this.onState = () => this.sample();
    player.on('state', this.onState);
    this.timer = this.every(this.onState, SAMPLE_MS);
    this.timer?.unref?.();
    this.sample();
  }

  sample() {
    if (this.closed) return;
    const now = this.now();
    if (this.play && this.previousStatus === Status.PLAYING) {
      this.play.elapsed += Math.max(0, now - this.lastSample);
      if (!this.play.attempted && this.play.elapsed >= WATCH_HISTORY_PLAYING_MS) this.pending = this.play;
    }
    const { status, video } = this.player;
    // LOADING delimits a new play, even when replaying the very same video.
    if (status !== Status.PLAYING && status !== Status.PAUSED) this.play = null;
    else if (isVideoId(video?.id) && (!this.play || this.play.id !== video.id)) {
      this.play = { id: video.id, elapsed: 0, attempted: false };
    } else if (!isVideoId(video?.id)) this.play = null;
    this.previousStatus = status;
    this.lastSample = now;
    void this.refresh();
  }

  snapshot() { return { ...this.status }; }

  updateStatus({ enabled, reason }) {
    const state = reason ? 'failed' : enabled ? 'ok' : 'off';
    if (reason && (reason !== this.status.reason || state !== this.status.state)) {
      this.log.warn(`Watch history: ${reason}`);
    }
    Object.assign(this.status, { enabled, state, reason });
  }

  refresh() {
    if (this.closed) return Promise.resolve();
    if (this.refreshing) return this.refreshing;
    this.refreshing = this.check().catch(() => {
      if (!this.closed) this.updateStatus({ enabled: false, reason: HistoryFailure.ERROR });
    }).finally(() => { this.refreshing = null; });
    return this.refreshing;
  }

  async check() {
    const file = await this.marker.inspect();
    if (this.closed) return;
    if (!file.enabled) {
      this.running?.abort.abort();
      this.pending = null;
      this.version = null;
      this.updateStatus(file);
      return;
    }
    if (!this.running && file.version !== this.version) {
      this.version = file.version;
      this.updateStatus(file);
    }
    if (!this.running && this.pending && this.status.reason !== HistoryFailure.SIGNED_OUT) {
      const play = this.pending;
      this.pending = null;
      play.attempted = true;
      const run = this.running = { abort: new AbortController() };
      void this.mark(play.id, run);
    }
  }

  async mark(videoId, run) {
    try {
      const result = await this.marker.mark(videoId, { signal: run.abort.signal });
      if (this.closed || run.abort.signal.aborted) return;
      this.version = result.version ?? this.version;
      this.updateStatus(result);
      if (result.enabled && !result.reason) this.status.lastMarkedAt = this.wallNow().toISOString();
    } catch {
      if (!this.closed && !run.abort.signal.aborted) {
        this.updateStatus({ enabled: true, reason: HistoryFailure.ERROR });
      }
    } finally {
      this.running = null;
      // Keep the active mark; only the newest qualified pending play survives.
      if (!this.closed) void this.refresh();
    }
  }

  stop() {
    this.closed = true;
    this.cancel(this.timer);
    this.player?.off('state', this.onState);
    this.running?.abort.abort();
    this.pending = null;
  }
}
