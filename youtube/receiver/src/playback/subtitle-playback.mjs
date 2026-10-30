import { playback } from '../config/receiver-config.mjs';
import { DEFAULT_SUBTITLES } from './subtitles.mjs';

/**
 * @typedef {import('./subtitles.mjs').SubtitleSetting & {
 * available: boolean|null, loading: boolean, error: boolean
 * }} SubtitleStatus
 */

// Subtitle work never holds up playback or an HTTP setting response. Each loaded
// mpv has its own track IDs; cancelled work must never select a track on its successor.
export class SubtitlePlayback {
  constructor(resolver, log) {
    Object.assign(this, { resolver, log });
    this.setting = { ...DEFAULT_SUBTITLES };
    this.reset();
  }

  reset() {
    this.abort?.abort();
    this.session = null;
    this.available = null;
    this.loading = this.error = false;
  }

  /** @returns {SubtitleStatus} */
  snapshot() {
    return { ...this.setting, available: this.available, loading: this.loading, error: this.error };
  }

  configure(setting) {
    this.setting = { ...setting };
    this.refresh();
  }

  loaded(mpv, videoId, signal, stream, quality) {
    this.session = { mpv, videoId, signal, quality, tracks: new Map(), stream, local: Boolean(stream?.local), tail: Promise.resolve() };
    this.refresh();
  }

  refresh() {
    this.abort?.abort();
    this.abort = new AbortController();
    this.available = null;
    this.loading = this.error = false;
    const session = this.session;
    if (!session || session.signal.aborted) return;
    const signal = AbortSignal.any([session.signal, this.abort.signal]);
    const setting = this.setting;
    this.loading = setting.enabled;
    if (!setting.enabled) session.stream = null;
    // Hide immediately, even while a slow extraction or sub-add is finishing.
    void session.mpv.command(['set_property', 'sid', 'no']).catch(() => {});
    this.pending = session.tail = session.tail.catch(() => {}).then(async () => {
      if (signal.aborted || !setting.enabled) return;
      try {
        await this.apply(session, setting.language, signal);
      } catch {
        if (!signal.aborted) {
          this.error = true;
          this.log.warn('Subtitle load failed');
        }
      } finally { if (!signal.aborted) this.loading = false; }
    });
  }

  async loadTrack(mpv, track, signal) {
    const find = async () => {
      const list = await mpv.command(['get_property', 'track-list']);
      signal.throwIfAborted();
      return list?.find(item => item.type === 'sub' && item['external-filename'] === track.url)?.id;
    };
    // A cancelled request may already have added the track. Reuse it.
    const existing = await find();
    if (Number.isInteger(existing)) return existing;
    await mpv.command(['sub-add', track.url, 'auto', track.language, track.language],
      { asynchronous: true, timeoutMs: playback.subtitleLoadTimeoutMs });
    signal.throwIfAborted();
    return find();
  }

  async apply(session, language, signal) {
    const { mpv, videoId, tracks, stream } = session;
    // Local playback must not start yt-dlp for a caption URL while offline.
    if (session.local) { this.available = false; return; }
    let id = tracks.get(language);
    if (id === undefined) {
      session.stream = null;
      const track = stream?.subtitleLanguage === language ? stream.subtitle
        : await this.resolver.resolveSubtitle(videoId, { language, signal, quality: session.quality });
      signal.throwIfAborted();
      if (track === undefined) throw new Error('Subtitle extraction failed');
      this.available = Boolean(track);
      if (!track) return;
      // Leave selection disabled until the download finishes and this request
      // is still current. Off or a different language may arrive in the meantime.
      id = await this.loadTrack(mpv, track, signal);
      if (!Number.isInteger(id)) throw new Error('Subtitle track not loaded');
      tracks.set(language, id);
    }
    this.available = true;
    await mpv.command(['set_property', 'sid', id]);
  }
}
