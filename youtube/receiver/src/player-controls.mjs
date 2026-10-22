import { PlayerStatus } from './mpv-player.mjs';
import { isVideoId } from './video-id.mjs';

// Every action senders without a lounge session can send (the vantv command,
// the Firefox popup, the Pi's vlcmd/pp shell functions behind the BTT buttons).
export const CONTROL_ACTIONS = Object.freeze(['pause', 'resume', 'toggle', 'stop', 'next', 'previous',
  'seek', 'audio_delay', 'speed', 'volume', 'mute']);
export const QUEUE_ACTIONS = Object.freeze(['add', 'remove', 'play', 'clear']);

// Returns `seek` arguments from a request body, or null when they are invalid:
// exactly one of an absolute `position` (>= 0) or a relative `offset`.
export function seekArguments({ position, offset }) {
  const hasPosition = position !== undefined;
  if (hasPosition === (offset !== undefined)) return null;
  if (hasPosition) return Number.isFinite(position) && position >= 0 ? { position } : null;
  return Number.isFinite(offset) ? { offset } : null;
}

// Settings take exactly one finite absolute value (named `field`) or relative `offset`.
function settingArguments(field) {
  return body => {
    const hasValue = body[field] !== undefined;
    if (hasValue === (body.offset !== undefined)) return null;
    const value = hasValue ? body[field] : body.offset;
    if (!Number.isFinite(value)) return null;
    return { [hasValue ? field : 'offset']: value };
  };
}

export const audioDelayArguments = settingArguments('delay');
export const speedArguments = settingArguments('speed');
export const volumeArguments = settingArguments('level');

// Mute takes an optional boolean; without one it toggles.
export function muteArguments({ muted }) {
  if (muted === undefined) return {};
  return typeof muted === 'boolean' ? { muted } : null;
}

export function queueArguments({ action, videoId, key }) {
  if (action === 'add') return isVideoId(videoId) ? { videoId } : null;
  if (action === 'remove' || action === 'play') return Number.isSafeInteger(key) ? { key } : null;
  return {};
}

export function createPlayerControls(player) {
  return {
    pause: () => player.pause(),
    resume: () => player.resume(),
    toggle: () => {
      if (player.status === PlayerStatus.PLAYING) return player.pause();
      if (player.status === PlayerStatus.PAUSED) return player.resume();
      return false;
    },
    // Stop also clears the queues: the library replays a cast only when its
    // current video changes, so recasting the stopped video would do nothing.
    stop: async () => { player.castQueue.clear(); await player.reset(); return true; },
    // The library stops playback when there's nothing to move to; a stray
    // Next (a direct cast has no queue) should leave the video playing, and
    // Previous restarts the video like a TV remote.
    next: () => player.playNext(),
    previous: () => (player.queue.hasPrevious ? player.previous() : player.seek(0)),
    seek: ({ position, offset }) => {
      if (!player.video) return false;
      const end = player.duration > 0 ? player.duration : Infinity;
      const target = position ?? player.position + offset;
      return player.seek(Math.max(0, Math.min(end, target)));
    },
    audio_delay: ({ delay, offset }) => player.setAudioDelay(delay ?? player.audioDelay + offset),
    speed: ({ speed, offset }) => player.setSpeed(speed ?? player.speed + offset),
    // Changing the level unmutes, like a TV remote.
    volume: ({ level, offset }) => player.setVolume({
      level: Math.round(Math.max(0, Math.min(100, level ?? player.volume.level + offset))), muted: false,
    }),
    mute: ({ muted }) => player.setVolume({ ...player.volume, muted: muted ?? !player.volume.muted }),
  };
}

function isIdle(player) {
  return player.status === PlayerStatus.IDLE || player.status === PlayerStatus.STOPPED;
}

export function createQueueControls(player, { log = console } = {}) {
  // A load can take tens of seconds; senders watch /api/status for the outcome.
  const start = key => {
    void player.playQueued(key).catch(() => log.warn('Queued video failed to start'));
    return true;
  };
  return {
    // With nothing playing, a queued video starts at once.
    add: ({ videoId }) => {
      const entry = player.castQueue.add(videoId);
      if (!entry) return false;
      return isIdle(player) ? start(entry.key) : true;
    },
    remove: ({ key }) => player.castQueue.take(key) !== null,
    play: ({ key }) => player.castQueue.snapshot().some(entry => entry.key === key) && start(key),
    clear: () => { player.castQueue.clear(); return true; },
  };
}
