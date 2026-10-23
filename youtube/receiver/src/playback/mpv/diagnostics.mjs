import { performance } from 'node:perf_hooks';
import { DiagnosticsHistory } from '../diagnostics.mjs';

const POLL_INTERVAL_MS = 2000;
const COMMAND_TIMEOUT_MS = 1000;
const PROPERTIES = Object.freeze({
  buffering: 'paused-for-cache', paused: 'pause', cache: 'demuxer-cache-state',
  videoBitrate: 'video-bitrate', audioBitrate: 'audio-bitrate', speed: 'speed',
  totalFrameDrops: 'frame-drop-count', totalDecoderDrops: 'decoder-frame-drop-count', position: 'time-pos',
});

export async function readMpvDiagnostics(mpv) {
  const entries = await Promise.all(Object.entries(PROPERTIES).map(async ([name, property]) => {
    try { return [name, await mpv.command(['get_property', property], { timeoutMs: COMMAND_TIMEOUT_MS })]; }
    catch { return [name, null]; }
  }));
  return Object.fromEntries(entries);
}

export class MpvDiagnostics {
  constructor({ intervalMs = POLL_INTERVAL_MS, now = () => performance.now() } = {}) {
    Object.assign(this, { intervalMs, now });
    this.history = new DiagnosticsHistory();
    this.generation = 0;
  }

  start(mpv, signal) {
    this.stop();
    const generation = this.generation;
    const stop = () => this.stop();
    if (signal?.aborted) return;
    signal?.addEventListener('abort', stop, { once: true });
    mpv.once('disconnect', stop);
    this.detach = () => {
      signal?.removeEventListener('abort', stop);
      mpv.removeListener('disconnect', stop);
    };
    const poll = async () => {
      const sample = await readMpvDiagnostics(mpv);
      if (generation !== this.generation) return;
      this.history.record(sample, this.now());
      // Schedule after completion so a slow IPC round cannot build a backlog.
      this.timer = setTimeout(poll, this.intervalMs);
      this.timer.unref?.();
    };
    void poll();
  }

  stop() {
    this.generation++;
    clearTimeout(this.timer);
    this.detach?.();
    this.detach = null;
    this.history.reset();
  }

  snapshot() { return this.history.snapshot(); }
}
