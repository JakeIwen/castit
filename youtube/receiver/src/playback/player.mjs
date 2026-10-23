import { Player, Constants } from 'yt-cast-receiver';
import { MpvProcess } from './mpv/process.mjs';
import { fetchSegments, SponsorSkipper } from './sponsor-block.mjs';
import { RoomPreparation } from '../host/room-preparation.mjs';
import { stopVideoLibrary } from '../host/vlc-handoff.mjs';
import { isVideoId } from '../youtube/video-id.mjs';
import { CastQueue } from '../queue/cast-queue.mjs';
import { LoadTiming } from './load-timing.mjs';
import { StreamResolver } from './stream-resolver.mjs';
import { SubtitlePlayback } from './subtitle-playback.mjs';
import { savedSubtitles, subtitleArguments } from './subtitles.mjs';
import { QueuePrefetch } from './queue-prefetch.mjs';

export const PlayerStatus = Constants.PLAYER_STATUSES;

function normalizeAudioDelay(delay) {
  if (!Number.isFinite(delay)) return 0;
  return Math.round(Math.max(-1, Math.min(1, delay)) * 100) / 100 || 0;
}

// mpv keeps pitch at any speed (scaletempo2); past 3x speech stops being useful.
export const SPEED_LIMITS = Object.freeze({ min: 0.25, max: 3 });

function normalizeSpeed(speed) {
  if (!Number.isFinite(speed)) return 1;
  return Math.round(Math.max(SPEED_LIMITS.min, Math.min(SPEED_LIMITS.max, speed)) * 100) / 100;
}

// Saved playback settings and the mpv property each one drives.
const MPV_SETTINGS = Object.freeze({ audioDelay: 'audio-delay', speed: 'speed' });

export class MpvPlayer extends Player {
  constructor({ createMpv = () => new MpvProcess(), room = new RoomPreparation(),
    handoff = stopVideoLibrary, segments = fetchSegments, store, log = console,
    castQueue = new CastQueue(), resolver = new StreamResolver() } = {}) {
    super();
    Object.assign(this, { createMpv, room, handoff, segments, store, log, castQueue, resolver });
    this.subtitlePlayback = new SubtitlePlayback(resolver, log);
    this.prefetch = new QueuePrefetch(resolver, () => this.castQueue.snapshot(), () => this.subtitleLanguage);
    this.volume = { level: 70, muted: false };
    this.audioDelay = 0;
    this.speed = 1;
    this.position = 0;
    this.duration = 0;
    this.video = null;
    this.playTail = Promise.resolve();
    this.request = 0;
  }

  async initialize() {
    const settings = await this.store?.get('settings');
    this.audioDelay = normalizeAudioDelay(settings?.audioDelay);
    this.speed = normalizeSpeed(settings?.speed);
    this.subtitlePlayback.configure(savedSubtitles(settings?.subtitles));
    if (Number.isFinite(settings?.volume?.level) && typeof settings.volume.muted === 'boolean') {
      this.volume = { level: Math.min(100, Math.max(0, settings.volume.level)), muted: settings.volume.muted };
    }
    await this.castQueue.load();
  }

  play(video, position = 0, aid, queuedEntry) {
    if (!isVideoId(video?.id) || !Number.isFinite(position) || position < 0) return Promise.resolve(false);
    const request = ++this.request;
    this.abort?.abort();
    const operation = this.playTail.catch(() => {}).then(async () => {
      if (request !== this.request) return false;
      // The base play() stops an already playing track; do it without invalidating this request.
      if (this.status === PlayerStatus.PLAYING) await super.stop();
      this.activeRequest = request;
      const started = await super.play(video, position, aid);
      if (started) {
        this.castQueue.recordPlayed(this.video || video, queuedEntry);
        if (request === this.request && !this.abort?.signal.aborted) this.room.afterPlayback();
      }
      return started;
    });
    this.playTail = operation;
    return operation;
  }

  stop(aid) {
    ++this.request;
    this.abort?.abort();
    this.room.cancelPending();
    return super.stop(aid);
  }

  async doPlay(video, position) {
    const timing = new LoadTiming();
    await this.release();
    if (this.activeRequest !== this.request) return false;
    const abort = this.abort = new AbortController();
    const signal = abort.signal;
    const mpv = this.mpv = this.createMpv();
    this.video = { id: video.id, title: video.title || video.id };
    this.position = position;
    this.skipper = new SponsorSkipper();
    void this.segments(video.id, { signal }).then(segments => {
      if (this.mpv === mpv && !signal.aborted) this.skipper = new SponsorSkipper(segments);
    }).catch(() => {});
    let outcome = 'failed';
    try {
      const resolving = timing.measure('resolve', () => this.resolver.resolve(video.id, { signal, language: this.subtitleLanguage }))
        .catch(() => { signal.throwIfAborted(); return null; });
      const wake = timing.measure('wake', () => this.room.beforeVideo(signal));
      const starting = timing.measure('handoff', () => this.handoff({ signal })).then(() =>
        timing.measure('mpv_start', async () => {
          signal.throwIfAborted();
          await mpv.start(signal);
          signal.throwIfAborted();
          mpv.on('event', event => {
            if (this.mpv === mpv && !signal.aborted) {
              void this.onMpvEvent(event, mpv).catch(() => this.log.warn('mpv state update failed'));
            }
          });
          mpv.on('disconnect', () => {
            if (this.mpv === mpv && !signal.aborted) void this.failedPlayback();
          });
          for (const [index, property] of ['time-pos', 'duration', 'pause', 'volume', 'mute', 'media-title'].entries()) {
            await mpv.command(['observe_property', index + 1, property]);
          }
          await this.applyVolume();
          for (const [name, property] of Object.entries(MPV_SETTINGS)) {
            await mpv.command(['set_property', property, this[name]]);
          }
        }));
      const preparing = [resolving, wake, starting];
      this.pendingPreparation = Promise.allSettled(preparing);
      const [stream] = await Promise.all(preparing);
      signal.throwIfAborted();
      timing.path = stream ? 'direct' : 'hook';
      if (stream?.title) this.video.title = stream.title;
      await timing.measure('load', () => mpv.load(video.id, position, signal, stream));
      signal.throwIfAborted();
      this.subtitlePlayback.loaded(mpv, video.id, signal, stream);
      this.prefetch.start(signal);
      outcome = 'loaded';
      return true;
    } catch {
      outcome = signal.aborted ? 'cancelled' : 'failed';
      // Neither extractor output nor sender metadata belongs in the journal.
      if (!signal.aborted) this.log.warn('Video playback failed');
      if (this.mpv === mpv) await this.release();
      else await this.pendingPreparation;
      return false;
    } finally { timing.report(this.log, outcome); }
  }

  async release() {
    this.subtitlePlayback.reset();
    this.abort?.abort();
    this.room.cancelPending();
    const mpv = this.mpv;
    const preparing = this.pendingPreparation;
    this.mpv = null;
    this.video = null;
    this.position = this.duration = 0;
    this.releasing = Promise.all([this.releasing, mpv?.close(), preparing, this.prefetch.stop()]);
    await this.releasing;
  }

  async doStop() {
    await this.release();
    this.room.endSession();
    return true;
  }
  async doPause() { return this.send(['set_property', 'pause', true]); }
  async doResume() {
    const mpv = this.mpv;
    const request = this.request;
    const resumed = await this.send(['set_property', 'pause', false]);
    if (resumed && this.mpv === mpv && request === this.request) this.room.afterPlayback();
    return resumed;
  }
  async doSeek(position) {
    if (!Number.isFinite(position) || position < 0) return false;
    const result = await this.send(['seek', position, 'absolute+exact']);
    if (result) this.position = position;
    return result;
  }

  async send(command) {
    try {
      if (!this.mpv) return false;
      await this.mpv.command(command);
      return true;
    } catch { return false; }
  }

  async applyVolume() {
    await this.mpv.command(['set_property', 'volume', this.volume.level]);
    await this.mpv.command(['set_property', 'mute', this.volume.muted]);
  }

  async doSetVolume(volume) {
    if (!Number.isFinite(volume.level) || typeof volume.muted !== 'boolean') return false;
    this.volume = { level: Math.max(0, Math.min(100, volume.level)), muted: volume.muted };
    try {
      if (this.mpv) await this.applyVolume();
      await this.saveSettings();
      return true;
    } catch { this.log.warn('Volume update failed'); return false; }
  }

  async saveSettings() {
    await this.store?.set('settings', { volume: this.volume, audioDelay: this.audioDelay,
      speed: this.speed, subtitles: this.subtitlePlayback.setting });
  }

  async updateSetting(name, value) {
    this[name] = value;
    try {
      await this.saveSettings();
      if (this.mpv) await this.mpv.command(['set_property', MPV_SETTINGS[name], value]);
      return true;
    } catch { this.log.warn(`Setting ${name} update failed`); return false; }
  }

  setAudioDelay(delay) {
    return Number.isFinite(delay) ? this.updateSetting('audioDelay', normalizeAudioDelay(delay)) : Promise.resolve(false);
  }

  setSpeed(speed) {
    return Number.isFinite(speed) ? this.updateSetting('speed', normalizeSpeed(speed)) : Promise.resolve(false);
  }

  get subtitles() { return this.subtitlePlayback.snapshot(); }
  get subtitleLanguage() { return this.subtitles.enabled ? this.subtitles.language : null; }

  async setSubtitles(fields) {
    const parsed = subtitleArguments(fields);
    if (!parsed) return false;
    this.subtitlePlayback.configure({ ...this.subtitlePlayback.setting, ...parsed });
    this.prefetch.tick();
    try { await this.saveSettings(); return true; }
    catch { this.log.warn('Subtitle setting update failed'); return false; }
  }

  // The phone's queue, or its autoplay pick, goes before the cast queue.
  get phoneHasNext() {
    return this.queue.hasNext
      || (this.autoplayMode === Constants.AUTOPLAY_MODES.ENABLED && Boolean(this.queue.autoplay));
  }

  // Resolves false, leaving playback alone, when there is nothing to play.
  playNext() { return this.phoneHasNext ? this.next() : this.playQueued(); }

  // Plays the first cast-queue entry, or an upcoming/played entry with `key`.
  playQueued(key) {
    const entry = this.castQueue.take(key)
      ?? (key === undefined ? null : this.castQueue.findPlayed(key, this.video));
    if (!entry) return Promise.resolve(false);
    return this.play({ id: entry.id, title: entry.title, client: Constants.CLIENTS.YT }, 0, undefined, entry);
  }

  async doGetVolume() { return { ...this.volume }; }
  async doGetPosition() { return this.position; }
  async doGetDuration() { return this.duration; }

  async onMpvEvent(event, source) {
    if (event.event === 'end-file') {
      if (event.reason === 'eof') {
        await this.notifyExternalStateChange(PlayerStatus.PAUSED);
        if (this.mpv !== source) return;
        if (!await this.playNext()) await this.stop();
      } else if (event.reason === 'error') await this.failedPlayback();
      return;
    }
    if (event.event !== 'property-change' || event.data == null) return;
    const handlers = {
      'time-pos': async value => {
        if (!Number.isFinite(value)) return;
        this.position = value;
        if (this.status === PlayerStatus.PLAYING) await this.skipper?.tick(value, target => this.seek(target));
      },
      duration: value => { if (Number.isFinite(value)) this.duration = value; },
      'media-title': value => { if (this.video) this.video.title = String(value); },
      pause: async value => {
        if (this.status === PlayerStatus.PLAYING || this.status === PlayerStatus.PAUSED) {
          await this.notifyExternalStateChange(value ? PlayerStatus.PAUSED : PlayerStatus.PLAYING);
        }
      },
      volume: value => {
        if (this.status !== PlayerStatus.LOADING && Number.isFinite(value)) this.volume.level = Math.max(0, Math.min(100, value));
      },
      mute: value => { if (this.status !== PlayerStatus.LOADING) this.volume.muted = Boolean(value); },
    };
    await handlers[event.name]?.(event.data);
    if (event.name === 'volume' || event.name === 'mute') await this.notifyExternalStateChange();
  }

  async failedPlayback() {
    this.log.warn('mpv playback ended unexpectedly');
    await this.stop();
  }

  async endSession() {
    const stopping = this.stop();
    const request = this.request;
    const pendingPlay = this.playTail;
    await stopping;
    await pendingPlay.catch(() => {});
    // A newly connected sender may already have started another session.
    if (request !== this.request) return;
    await this.release();
    this.room.endSession();
  }
}
