import '../config.js';
import {
  createScrubState, formatTime, isWorking, loadingActions, popupState, queueListModel, subtitleLabel, transitionScrub, watchHistoryNotice,
} from './state.mjs';
import { QualitySelector } from './quality-selector.mjs';
import { QueueList } from './queue-list.mjs';
import { PlaybackMessages } from './playback-messages.mjs';
import { LoadProgress } from './load-progress.mjs';
import { DownloadControl } from './download-control.mjs';
import { SavedVideos } from './saved-videos.mjs';
import { KeyboardHelp } from './keyboard-help.mjs';
import { shortcutFor, shortcutKind } from './keyboard-shortcuts.mjs';
import { watchUrl } from '../youtube/video-url.mjs';
import { setAttribute, setBooleanAttribute, setClass, setProperty, setText } from './dom-state.mjs';

const config = globalThis.VAN_TV_CONFIG;
const ids = [
  'quality', 'quality-status', 'quality-retry', 'subtitles', 'subtitle-status', 'state', 'video', 'elapsed', 'duration', 'scrub', 'notice', 'cast-tab',
  'previous', 'back-twenty', 'toggle', 'forward-twenty', 'next', 'stop', 'play-icon', 'pause-icon',
  'sound-earlier', 'sound-later', 'reset-delay', 'audio-delay-value',
  'volume-down', 'volume-up', 'volume-value', 'mute', 'speed-down', 'speed-up', 'speed-reset',
  'speed-value', 'queue-section', 'queue', 'queue-end', 'queue-clear', 'queue-tab', 'history-notice',
  'channel', 'channel-avatar', 'channel-name', 'channel-verified', 'channel-subscribers',
  'playback-time', 'load-progress', 'load-progress-label', 'load-progress-bar', 'load-progress-fill',
  'download', 'download-progress', 'save-tab', 'keyboard-help',
];
const element = Object.fromEntries(ids.map(id => [id, document.getElementById(id)]));
const loadProgress = new LoadProgress({ root: element['load-progress'], playback: element['playback-time'],
  label: element['load-progress-label'], bar: element['load-progress-bar'], fill: element['load-progress-fill'] });
const messages = new PlaybackMessages({ before: element['queue-section'],
  notice: element.notice, historyNotice: element['history-notice'] });
const transportControls = [
  { button: element.previous, action: config.control.previous },
  { button: element['back-twenty'], action: config.control.seek,
    fields: { offset: config.skipOffsets.backwardTwentySeconds } },
  { button: element.toggle, action: config.control.toggle },
  { button: element['forward-twenty'], action: config.control.seek,
    fields: { offset: config.skipOffsets.forwardTwentySeconds } },
  { button: element.next, action: config.control.next },
  { button: element.stop, action: config.control.stop },
];
const audioDelayControls = [
  { button: element['sound-earlier'], fields: { offset: -config.audioDelayStep } },
  { button: element['sound-later'], fields: { offset: config.audioDelayStep } },
  { button: element['reset-delay'], fields: { delay: 0 } },
];
// Each settings row: its buttons, the action they send, and when they apply.
const settingControls = [
  ...audioDelayControls.map(item => ({ ...item, action: config.control.audioDelay, enabled: 'audioDelayEnabled' })),
  { button: element['volume-down'], action: config.control.volume, fields: { offset: -config.volumeStep }, enabled: 'volumeEnabled' },
  { button: element['volume-up'], action: config.control.volume, fields: { offset: config.volumeStep }, enabled: 'volumeEnabled' },
  { button: element.mute, action: config.control.mute, fields: {}, enabled: 'volumeEnabled' },
  { button: element['speed-down'], action: config.control.speed, fields: { offset: -config.speedStep }, enabled: 'speedEnabled' },
  { button: element['speed-up'], action: config.control.speed, fields: { offset: config.speedStep }, enabled: 'speedEnabled' },
  { button: element['speed-reset'], action: config.control.speed, fields: { speed: 1 }, enabled: 'speedEnabled' },
];

let latestStatus;
let scrub = createScrubState();
let busy = false;
let pendingOperations = 0;
let latestOperation = 0;
let polling = false;
let tabAvailable = false;
let pollTimer;
let progressTimer;
let progressTime = performance.now();
let closed = false;
let showRemaining = false;
let detailsVideoId = null;
let requestsInFlight = 0;
let statusRequest = 0;
const qualitySelector = new QualitySelector(element.quality, element['quality-status'], element['quality-retry'], quality =>
  void perform(config.message.control, { action: config.control.quality, quality }, '', 'Cannot save quality'));
const queueList = new QueueList({ list: element.queue, section: element['queue-section'],
  jumpButton: element['queue-end'],
  onAction: fields => perform(config.message.queue, fields, '', 'This video is no longer in the list'),
  onOpen: openYouTube });
const savedVideos = new SavedVideos({ before: element['queue-section'],
  load: () => send(config.message.library),
  act: (type, fields) => send(type, fields, true), onChanged: refreshStatus });
const downloadControl = new DownloadControl(element.download, element['download-progress'], () => {
  const id = latestStatus?.video?.id;
  if (id) void perform(config.message.control, { action: config.control.download, id }, 'Download accepted');
});
const keyboardHelp = new KeyboardHelp(element['keyboard-help']);
// Seeks act only when the matching controls would: the ±20 buttons for skips,
// the scrubber for jumps.
const shortcutHandlers = {
  [shortcutKind.click]: ({ button }) => element[button].click(),
  [shortcutKind.seek]: ({ offset }) => {
    if (latestStatus && popupState(latestStatus).actions.includes(config.control.seek)) {
      void perform(config.message.control, { action: config.control.seek, offset }, '');
    }
  },
  [shortcutKind.seekFraction]: ({ fraction }) => {
    if (!element.scrub.disabled) seekTo(latestStatus.duration * fraction);
  },
  [shortcutKind.help]: () => keyboardHelp.toggle(),
};

async function withRequest(operation) {
  requestsInFlight += 1;
  renderActivity();
  try { return await operation(); }
  finally { requestsInFlight -= 1; renderActivity(); }
}

async function send(type, fields = {}, foreground = false) {
  const request = async () => {
    const response = await browser.runtime.sendMessage({ type, ...fields });
    if (!response?.ok) throw new Error(response?.error || 'Van TV request failed');
    return response.data;
  };
  return foreground ? withRequest(request) : request();
}

function renderActivity() {
  const working = isWorking(latestStatus, requestsInFlight);
  const state = latestStatus ? (latestStatus.ok ? latestStatus.player : 'Receiver not running')
    : (latestStatus === undefined ? 'Connecting…' : 'Van TV unreachable');
  const label = latestStatus?.diagnostics?.buffering ? 'Buffering'
    : state === latestStatus?.player ? state[0] + state.slice(1).toLowerCase() : state;
  const activity = latestStatus?.loading || latestStatus?.player === config.player.loading ? 'Loading' : 'Working';
  setText(element.state, working ? activity : label);
  setClass(element.state, 'working', working);
  setAttribute(element.state, 'aria-label', working ? `${activity}…` : label);
  setProperty(element.state, 'title', working ? label : '');
}

async function openYouTube(url, background = false) {
  try {
    await withRequest(() => browser.tabs.create(background ? { url, active: false } : { url }));
  } catch (error) { messages.setNotice(error.message, true); }
}

function renderPlayback() {
  if (loadProgress.render()) return;
  const duration = latestStatus?.duration ?? 0;
  if (!scrub.dragging) {
    setProperty(element.scrub, 'max', String(duration));
    setProperty(element.scrub, 'value', String(scrub.position));
  }
  setText(element.elapsed, formatTime(scrub.position));
  setText(element.duration, latestStatus
    ? (showRemaining ? `−${formatTime(Math.max(0, duration - scrub.position))}` : formatTime(duration))
    : '—');
  setAttribute(element.scrub, 'aria-valuetext', `${formatTime(scrub.position)} of ${formatTime(duration)}`);
}

function updateControls() {
  const view = latestStatus ? popupState(latestStatus) : null;
  for (const item of transportControls) {
    setProperty(item.button, 'disabled', busy && !loadingActions.includes(item.action)
      || !view?.actions.includes(item.action));
  }
  const toggleLabel = view?.toggleLabel ?? 'Play';
  setBooleanAttribute(element['play-icon'], 'hidden', toggleLabel === 'Pause');
  setBooleanAttribute(element['pause-icon'], 'hidden', toggleLabel !== 'Pause');
  setProperty(element.toggle, 'title', toggleLabel);
  setAttribute(element.toggle, 'aria-label', toggleLabel);
  if (!scrub.dragging) setProperty(element.scrub, 'disabled', busy || Boolean(latestStatus?.loading) || !view?.scrubEnabled);
  for (const { button, enabled } of settingControls) {
    const reset = button === element['reset-delay'] && latestStatus?.audioDelay === 0
      || button === element['speed-reset'] && latestStatus?.speed === 1;
    setProperty(button, 'disabled', busy || !view?.[enabled] || reset);
  }
  setText(element['audio-delay-value'], view?.audioDelayLabel ?? '—');
  setText(element['volume-value'], view?.volumeLabel ?? '—');
  setText(element['speed-value'], view?.speedLabel ?? '—');
  setText(element.mute, view?.muted ? 'Unmute' : 'Mute');
  setProperty(element.mute, 'title', view?.muted ? 'Unmute Van TV' : 'Mute Van TV');
  setAttribute(element.mute, 'aria-pressed', Boolean(view?.muted));
  setProperty(element.subtitles, 'disabled', busy || !view?.subtitlesEnabled);
  setAttribute(element.subtitles, 'aria-pressed', Boolean(view?.subtitlesOn));
  const subtitleStatus = view?.subtitlesLabel ?? subtitleLabel();
  setProperty(element.subtitles, 'title', subtitleStatus);
  setText(element['subtitle-status'], subtitleStatus);
  qualitySelector.render(latestStatus?.quality, latestStatus?.ok, busy);
  queueList.setBusy(busy);
  savedVideos.setBusy(busy);
  downloadControl.render(latestStatus, busy);
  setProperty(element['queue-clear'], 'disabled', busy || !view?.queueList.clearableCount);
  setProperty(element['cast-tab'], 'disabled', busy || !tabAvailable);
  setProperty(element['queue-tab'], 'disabled', busy || !tabAvailable || !view?.queueEnabled);
  setProperty(element['save-tab'], 'disabled', busy || !tabAvailable);
  setProperty(element.duration, 'disabled', Boolean(latestStatus?.loading) || !view?.scrubEnabled);
}

function renderChannel(channel) {
  element.channel.href = channel.url;
  element['channel-name'].textContent = channel.name;
  element['channel-verified'].toggleAttribute('hidden', !channel.verified);
  element['channel-subscribers'].textContent = channel.subscribers ?? '';
  element['channel-avatar'].hidden = !channel.avatarUrl;
  if (channel.avatarUrl) element['channel-avatar'].src = channel.avatarUrl;
  element.channel.hidden = false;
}

async function loadDetails(videoId) {
  detailsVideoId = videoId;
  element.channel.hidden = true;
  if (!videoId) return;
  try {
    const details = await send(config.message.videoDetails, { videoId });
    if (detailsVideoId === videoId) renderChannel(details.channel);
  } catch { /* The title link still works without channel details. */ }
}

function renderVideo(title, video) {
  setText(element.video, title);
  setProperty(element.video, 'title', title);
  if (video) setProperty(element.video, 'href', watchUrl(video.id));
  else if (element.video.hasAttribute('href')) element.video.removeAttribute('href');
  const videoId = video?.id ?? null;
  if (videoId !== detailsVideoId) void loadDetails(videoId);
}

function renderStatus() {
  renderActivity();
  setText(element['history-notice'], watchHistoryNotice(latestStatus));
  messages.render(latestStatus);
  if (latestStatus) {
    const view = popupState(latestStatus);
    renderVideo(view.title, latestStatus.video);
    queueList.render(view.queueList);
  } else {
    renderVideo('', null);
    queueList.render(queueListModel(null));
  }
  renderPlayback();
  updateControls();
}

async function refreshStatus() {
  const request = ++statusRequest;
  try {
    const status = await send(config.message.status);
    if (request !== statusRequest) return;
    scrub = transitionScrub(scrub, {
      type: 'poll', position: status.position, duration: status.duration,
    }).state;
    latestStatus = status;
  } catch {
    if (request !== statusRequest) return;
    latestStatus = null;
    if (!scrub.dragging) scrub = createScrubState();
  }
  progressTime = performance.now();
  loadProgress.update(latestStatus?.loading, progressTime);
  renderStatus();
}

async function refreshTab() {
  try { tabAvailable = Boolean(await send(config.message.tabVideo)); }
  catch { tabAvailable = false; }
  updateControls();
}

async function poll() {
  if (closed || polling) return;
  polling = true;
  try { await Promise.all([refreshStatus(), refreshTab()]); }
  finally {
    polling = false;
    if (!closed) pollTimer = setTimeout(poll, config.pollIntervalMs);
  }
}

async function perform(type, fields, success, unchanged = 'No playback change') {
  const interruptsLoad = type === config.message.control && loadingActions.includes(fields.action);
  if (busy && !interruptsLoad) return;
  const operation = ++latestOperation;
  pendingOperations += 1;
  busy = true;
  messages.setNotice('');
  updateControls();
  try {
    const data = await send(type, fields, true);
    if (operation === latestOperation) messages.setNotice(data.done === false ? unchanged : success, data.done === false);
  } catch (error) {
    if (operation === latestOperation) messages.setNotice(error.message, true);
  }
  finally {
    await Promise.all([refreshStatus(), savedVideos.refresh()]);
    pendingOperations -= 1;
    busy = pendingOperations > 0;
    updateControls();
  }
}

function updateProgress() {
  const now = performance.now();
  const seconds = (now - progressTime) / 1000;
  progressTime = now;
  if (latestStatus?.loading) { loadProgress.render(now); return; }
  if (!latestStatus?.ok || latestStatus.player !== config.player.playing || latestStatus.diagnostics?.buffering) return;
  scrub = transitionScrub(scrub, {
    type: 'advance', seconds, duration: latestStatus.duration,
  }).state;
  renderPlayback();
}

for (const item of transportControls) {
  item.button.addEventListener('click', () => void perform(config.message.control,
    { action: item.action, ...(item.fields ?? {}) }, ''));
}

for (const item of settingControls) {
  item.button.addEventListener('click', () => void perform(config.message.control,
    { action: item.action, ...item.fields }, ''));
}

element.subtitles.addEventListener('click', () => void perform(config.message.control,
  { action: config.control.subtitles, enabled: !latestStatus?.subtitles?.enabled }, ''));

element.scrub.addEventListener('input', event => {
  scrub = transitionScrub(scrub, {
    type: 'input', position: Number(event.currentTarget.value),
    duration: latestStatus?.duration,
  }).state;
  renderPlayback();
});

function seekTo(position) {
  const result = transitionScrub(scrub, {
    type: 'change', position, duration: latestStatus?.duration,
  });
  scrub = result.state;
  if (latestStatus) latestStatus = { ...latestStatus, position: scrub.position };
  progressTime = performance.now();
  renderStatus();
  void perform(config.message.control, { action: config.control.seek, ...result.seek }, '');
}

element.scrub.addEventListener('change', event => seekTo(Number(event.currentTarget.value)));

// While the help is open only its own key acts; the rest keep their dialog
// meaning (Space presses Close). Firefox presses a focused button on Space's
// keyup, so a shortcut claims both halves and runs on keydown.
function claimShortcut(event) {
  const shortcut = shortcutFor(event);
  if (!shortcut || keyboardHelp.open && shortcut.action?.kind !== shortcutKind.help) return null;
  event.preventDefault();
  return shortcut;
}
document.addEventListener('keydown', event => {
  const action = claimShortcut(event)?.action;
  if (action) shortcutHandlers[action.kind](action);
});
document.addEventListener('keyup', claimShortcut);

// Links open in normal tabs while the sidebar remains available as a remote.
for (const link of [element.video, element.channel]) {
  link.addEventListener('click', event => {
    event.preventDefault();
    if (!link.href) return;
    void openYouTube(link.href);
  });
}

element['cast-tab'].addEventListener('click', () => void perform(
  config.message.castTab, {}, 'Cast accepted'));
element['queue-tab'].addEventListener('click', () => void perform(
  config.message.queueTab, {}, 'Added to the queue', 'The queue is full'));
element['save-tab'].addEventListener('click', () => void perform(
  config.message.saveTab, {}, 'Download accepted'));
element['queue-end'].addEventListener('click', () => queueList.jumpToEnd());
element['queue-clear'].addEventListener('click', () => void perform(
  config.message.queue, { action: config.queue.clear }, ''));
element.duration.addEventListener('click', () => {
  showRemaining = !showRemaining;
  const label = showRemaining ? 'Show total time' : 'Show remaining time';
  element.duration.title = label;
  element.duration.setAttribute('aria-label', label);
  element.duration.setAttribute('aria-pressed', String(showRemaining));
  renderPlayback();
});
window.addEventListener('pagehide', () => {
  closed = true;
  clearTimeout(pollTimer);
  clearInterval(progressTimer);
  queueList.destroy();
  savedVideos.destroy();
});
void browser.browserAction.setBadgeText({ text: '' });
void browser.browserAction.setTitle({ title: 'Van TV' });
progressTimer = setInterval(updateProgress, config.progressIntervalMs);
void poll();
