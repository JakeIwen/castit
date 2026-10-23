import '../config.js';

const { player, control, historyReason } = globalThis.VAN_TV_CONFIG;
const playbackActions = Object.freeze([
  control.previous, control.seek, control.toggle, control.next, control.stop,
]);
const loadingActions = Object.freeze([control.stop]);
const availableActions = Object.freeze({
  [player.idle]: Object.freeze([]),
  [player.loading]: loadingActions,
  [player.playing]: playbackActions,
  [player.paused]: playbackActions,
  [player.stopped]: Object.freeze([]),
});

export function formatTime(value) {
  if (!Number.isFinite(value) || value < 0) return '—';
  const seconds = Math.floor(value);
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor(seconds % 3600 / 60);
  const remainder = String(seconds % 60).padStart(2, '0');
  return hours ? `${hours}:${String(minutes).padStart(2, '0')}:${remainder}` : `${minutes}:${remainder}`;
}

function boundedPosition(value, duration) {
  const position = Number.isFinite(value) && value >= 0 ? value : 0;
  return Number.isFinite(duration) && duration >= 0 ? Math.min(position, duration) : position;
}

export function createScrubState(position = 0, duration = Infinity) {
  return { dragging: false, position: boundedPosition(position, duration) };
}

export function transitionScrub(state, event) {
  if (event.type === 'poll') {
    if (state.dragging) return { state, seek: null };
    return { state: createScrubState(event.position, event.duration), seek: null };
  }
  if (event.type === 'input') {
    return {
      state: { dragging: true, position: boundedPosition(event.position, event.duration) },
      seek: null,
    };
  }
  if (event.type === 'change') {
    const position = boundedPosition(event.position, event.duration);
    return { state: { dragging: false, position }, seek: { position } };
  }
  if (event.type === 'advance') {
    if (state.dragging || !Number.isFinite(event.seconds) || event.seconds <= 0) {
      return { state, seek: null };
    }
    return {
      state: { dragging: false,
        position: boundedPosition(state.position + event.seconds, event.duration) },
      seek: null,
    };
  }
  throw new Error('Unknown scrub transition');
}

// Signed whole milliseconds, e.g. "+120 ms" or "0 ms".
export function formatAudioDelay(seconds) {
  if (!Number.isFinite(seconds)) return '—';
  const ms = Math.round(seconds * 1000) || 0;
  return `${ms > 0 ? '+' : ''}${ms} ms`;
}

// e.g. "1.25×"; the receiver rounds speeds to hundredths.
export function formatSpeed(speed) {
  return Number.isFinite(speed) ? `${Number(speed.toFixed(2))}×` : '—';
}

export function formatVolume(volume) {
  if (!volume) return '—';
  return volume.muted ? 'Muted' : `${Math.round(volume.level)}%`;
}

export const queueRowKind = Object.freeze({ played: 'played', current: 'current', upcoming: 'upcoming' });

/** @typedef {{kind: string, key: number|null, id: string, title: string}} QueueRow */
/** @typedef {{rows: QueueRow[], currentId: string|null, anchorIndex: number, upcomingCount: number}} QueueListModel */

/** @returns {QueueListModel} */
export function queueListModel(status) {
  const entries = (list, kind) => (list ?? []).map(({ key, id, title }) => ({
    kind, key, id, title: title || id,
  }));
  const rows = entries(status?.played, queueRowKind.played);
  if (status?.video) rows.push({ kind: queueRowKind.current, key: null,
    id: status.video.id, title: status.video.title || status.video.id });
  rows.push(...entries(status?.queue, queueRowKind.upcoming));
  return { rows, currentId: status?.video?.id ?? null,
    anchorIndex: rows.findIndex(row => row.kind !== queueRowKind.played),
    upcomingCount: status?.queue?.length ?? 0 };
}

export function isWorking(status, requestsInFlight = 0) {
  return status?.player === player.loading || Boolean(status?.quality?.loading) || requestsInFlight > 0;
}

// Centers belong to the remaining upcoming rows, with the dragged row excluded.
export function queueDropIndex(centers, pointerY) {
  const index = centers.findIndex(center => pointerY < center);
  return index < 0 ? centers.length : index;
}

export function reorderUpcoming(model, key, index) {
  const upcoming = model.rows.filter(row => row.kind === queueRowKind.upcoming);
  const from = upcoming.findIndex(row => row.key === key);
  if (from < 0 || !Number.isSafeInteger(index)) return model;
  const to = Math.max(0, Math.min(index, upcoming.length - 1));
  if (from === to) return model;
  upcoming.splice(to, 0, ...upcoming.splice(from, 1));
  return { ...model, rows: [
    ...model.rows.filter(row => row.kind !== queueRowKind.upcoming), ...upcoming,
  ] };
}

const historyNotices = Object.freeze({
  [historyReason.signedOut]:
    'YouTube history paused: the account cookies expired. Re-run push-youtube-cookies.zsh.',
  [historyReason.rejectedFile]:
    'YouTube history off: the receiver rejected its cookie file (owner or mode 600).',
});

// Transient errors retry on the next video, so only lasting problems are shown.
export function watchHistoryNotice(status) {
  return historyNotices[status?.watchHistory?.reason] ?? '';
}

export function subtitleLabel(subtitles) {
  if (!subtitles) return 'Subtitles unavailable';
  let language = subtitles.language;
  try { language = new Intl.DisplayNames(['en'], { type: 'language' }).of(language); }
  catch { /* YouTube language codes can be more specific than Intl supports. */ }
  if (!subtitles.enabled) return `Subtitles off (${language})`;
  if (subtitles.loading) return `Loading ${language} subtitles…`;
  if (subtitles.error) return 'Subtitles failed to load; toggle CC to retry';
  if (subtitles.available === false) return `No ${language} subtitles`;
  return `${language} subtitles on`;
}

export function popupState(status) {
  const actions = status.ok ? (availableActions[status.player] ?? []) : [];
  const elapsed = formatTime(status.position);
  const total = formatTime(status.duration);
  return {
    state: status.ok ? status.player : 'Receiver not running',
    title: status.video?.title || (status.video ? status.video.id : 'No video'),
    elapsed,
    total,
    time: `${elapsed} / ${total}`,
    actions,
    scrubEnabled: Boolean(status.ok && status.video && status.duration > 0
      && actions.includes(control.seek)),
    toggleLabel: status.player === player.playing ? 'Pause' : 'Play',
    // The offset is saved on the receiver, so it can be set before a cast too.
    audioDelayEnabled: Boolean(status.ok && Number.isFinite(status.audioDelay)),
    audioDelayLabel: formatAudioDelay(status.audioDelay),
    speedEnabled: Boolean(status.ok && Number.isFinite(status.speed)),
    speedLabel: formatSpeed(status.speed),
    subtitlesEnabled: Boolean(status.ok && status.subtitles),
    subtitlesLabel: subtitleLabel(status.subtitles),
    subtitlesOn: Boolean(status.subtitles?.enabled),
    volumeEnabled: Boolean(status.ok && status.volume),
    volumeLabel: formatVolume(status.volume),
    muted: Boolean(status.volume?.muted),
    queueEnabled: Boolean(status.ok && status.queue),
    queueList: queueListModel(status),
  };
}
