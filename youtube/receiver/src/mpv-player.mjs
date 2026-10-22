import { Player, Constants } from 'yt-cast-receiver';
import { MpvProcess } from './mpv-process.mjs';
import { fetchSegments, SponsorSkipper } from './sponsor-block.mjs';
import { RoomPreparation } from './room-preparation.mjs';
import { stopVideoLibrary } from './vlc-handoff.mjs';
import { isVideoId } from './video-id.mjs';
import { CastQueue } from './cast-queue.mjs';

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
    castQueue = new CastQueue() } = {}) {
    super();
    Object.assign(this, { createMpv, room, handoff, segments, store, log, castQueue });
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
    if (Number.isFinite(settings?.volume?.level) && typeof settings.volume.muted === 'boolean') {
      this.volume = { level: Math.min(100, Math.max(0, settings.volume.level)), muted: settings.volume.muted };
    }
  }

  play(video, position = 0, aid) {
    if (!isVideoId(video?.id) || !Number.isFinite(position) || position < 0) return Promise.resolve(false);
    const request = ++this.request;
    this.abort?.abort();
    const operation = this.playTail.catch(() => {}).then(async () => {
      if (request !== this.request) return false;
      // The base play() stops an already playing track; do it without invalidating this request.
      if (this.status === PlayerStatus.PLAYING) await super.stop();
      this.activeRequest = request;
      return super.play(video, position, aid);
    });
    this.playTail = operation;
    return operation;
  }

  stop(aid) {
    ++this.request;
    this.abort?.abort();
    return super.stop(aid);
  }

  async doPlay(video, position) {
    await this.release();
    if (this.activeRequest !== this.request) return false;
    const abort = this.abort = new AbortController();
    const signal = abort.signal;
    const mpv = this.mpv = this.createMpv();
    this.video = { id: video.id, title: video.title || video.id };
    this.position = position;
    this.skipper = new SponsorSkipper();
    void this.segments(video.id, { signal }).then(segments => {
      if (this.mpv === mpv) this.skipper = new SponsorSkipper(segments);
    }).catch(() => {});
    try {
      await this.handoff({ signal });
      await this.room.beforeVideo(signal);
      signal.throwIfAborted();
      await mpv.start(signal);
      signal.throwIfAborted();
      mpv.on('event', event => {
        if (this.mpv === mpv) void this.onMpvEvent(event, mpv).catch(() => this.log.warn('mpv state update failed'));
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
      await mpv.load(video.id, position, signal);
      signal.throwIfAborted();
      return true;
    } catch (error) {
      // These messages come from this receiver's own steps, never from lounge data.
      if (!signal.aborted) this.log.warn(`Video playback failed: ${error?.message || error}`);
      if (this.mpv === mpv) await this.release();
      return false;
    }
  }

  async release() {
    this.abort?.abort();
    const mpv = this.mpv;
    this.mpv = null;
    this.video = null;
    this.position = this.duration = 0;
    if (mpv) await mpv.close();
  }

  async doStop() {
    await this.release();
    // Other playback may change the room setup between cast sessions.
    this.room.endSession();
    return true;
  }
  async doPause() { return this.send(['set_property', 'pause', true]); }
  async doResume() { return this.send(['set_property', 'pause', false]); }
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
    await this.store?.set('settings', { volume: this.volume, audioDelay: this.audioDelay, speed: this.speed });
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

  // The phone's queue, or its autoplay pick, goes before the cast queue.
  get phoneHasNext() {
    return this.queue.hasNext
      || (this.autoplayMode === Constants.AUTOPLAY_MODES.ENABLED && Boolean(this.queue.autoplay));
  }

  // Resolves false, leaving playback alone, when there is nothing to play.
  playNext() { return this.phoneHasNext ? this.next() : this.playQueued(); }

  // Plays the first cast-queue entry, or the one with `key`.
  playQueued(key) {
    const entry = this.castQueue.take(key);
    if (!entry) return Promise.resolve(false);
    return this.play({ id: entry.id, title: entry.title, client: Constants.CLIENTS.YT }, 0);
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
    this.castQueue.clear();
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
