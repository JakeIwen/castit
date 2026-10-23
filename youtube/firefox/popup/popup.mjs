import '../config.js';
import {
  createScrubState, formatTime, isWorking, popupState, queueListModel, transitionScrub, watchHistoryNotice,
} from './state.mjs';
import { QualitySelector } from './quality-selector.mjs';
import { QueueList } from './queue-list.mjs';
import { watchUrl } from '../youtube/video-url.mjs';

const config = globalThis.VAN_TV_CONFIG;
const ids = [
  'quality', 'quality-status', 'quality-retry', 'subtitles', 'subtitle-status', 'state', 'video', 'elapsed', 'duration', 'scrub', 'notice', 'cast-tab',
  'previous', 'back-twenty', 'toggle', 'forward-twenty', 'next', 'stop', 'play-icon', 'pause-icon',
  'sound-earlier', 'sound-later', 'reset-delay', 'audio-delay-value',
  'volume-down', 'volume-up', 'volume-value', 'mute', 'speed-down', 'speed-up', 'speed-reset',
  'speed-value', 'queue-section', 'queue', 'queue-end', 'queue-clear', 'queue-tab', 'history-notice',
  'channel', 'channel-avatar', 'channel-name', 'channel-verified', 'channel-subscribers',
];
const element = Object.fromEntries(ids.map(id => [id, document.getElementById(id)]));
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

async function withRequest(operation) {
  requestsInFlight += 1;
  renderActivity();
  try { return await operation(); }
  finally { requestsInFlight -= 1; renderActivity(); }
}

async function send(type, fields = {}) {
  return withRequest(async () => {
    const response = await browser.runtime.sendMessage({ type, ...fields });
    if (!response?.ok) throw new Error(response?.error || 'Van TV request failed');
    return response.data;
  });
}

function renderActivity() {
  const working = isWorking(latestStatus, requestsInFlight);
  const state = latestStatus ? popupState(latestStatus).state
    : (latestStatus === undefined ? 'Connecting…' : 'Van TV unreachable');
  const label = state === latestStatus?.player ? state[0] + state.slice(1).toLowerCase() : state;
  element.state.textContent = working ? 'Working' : label;
  element.state.classList.toggle('working', working);
  element.state.setAttribute('aria-label', working ? 'Working…' : label);
  element.state.title = working ? label : '';
}

async function openYouTube(url, background = false) {
  try {
    await withRequest(() => browser.tabs.create(background ? { url, active: false } : { url }));
    if (!background) window.close();
  } catch (error) { element.notice.textContent = error.message; }
}

function renderPlayback() {
  const duration = latestStatus?.duration ?? 0;
  if (!scrub.dragging) {
    element.scrub.max = String(duration);
    element.scrub.value = String(scrub.position);
  }
  element.elapsed.textContent = formatTime(scrub.position);
  element.duration.textContent = latestStatus
    ? (showRemaining ? `−${formatTime(Math.max(0, duration - scrub.position))}` : formatTime(duration))
    : '—';
  element.scrub.setAttribute('aria-valuetext', `${formatTime(scrub.position)} of ${formatTime(duration)}`);
}

function updateControls() {
  const view = latestStatus ? popupState(latestStatus) : null;
  for (const item of transportControls) {
    item.button.disabled = busy || !view?.actions.includes(item.action);
  }
  const toggleLabel = view?.toggleLabel ?? 'Play';
  element['play-icon'].toggleAttribute('hidden', toggleLabel === 'Pause');
  element['pause-icon'].toggleAttribute('hidden', toggleLabel !== 'Pause');
  element.toggle.title = toggleLabel;
  element.toggle.setAttribute('aria-label', toggleLabel);
  if (!scrub.dragging) element.scrub.disabled = busy || !view?.scrubEnabled;
  for (const { button, enabled } of settingControls) button.disabled = busy || !view?.[enabled];
  if (latestStatus?.audioDelay === 0) element['reset-delay'].disabled = true;
  if (latestStatus?.speed === 1) element['speed-reset'].disabled = true;
  element['audio-delay-value'].textContent = view?.audioDelayLabel ?? '—';
  element['volume-value'].textContent = view?.volumeLabel ?? '—';
  element['speed-value'].textContent = view?.speedLabel ?? '—';
  element.mute.textContent = view?.muted ? 'Unmute' : 'Mute';
  element.mute.title = view?.muted ? 'Unmute Van TV' : 'Mute Van TV';
  element.mute.setAttribute('aria-pressed', String(Boolean(view?.muted)));
  element.subtitles.disabled = busy || !view?.subtitlesEnabled;
  element.subtitles.setAttribute('aria-pressed', String(Boolean(view?.subtitlesOn)));
  element.subtitles.title = view?.subtitlesOn ? 'Turn subtitles off' : 'Turn subtitles on';
  element['subtitle-status'].textContent = view?.subtitlesLabel ?? 'Subtitles unavailable';
  qualitySelector.render(latestStatus?.quality, latestStatus?.ok, busy);
  queueList.setBusy(busy);
  element['queue-clear'].disabled = busy || !view?.queueList.upcomingCount;
  element['cast-tab'].disabled = busy || !tabAvailable;
  element['queue-tab'].disabled = busy || !tabAvailable || !view?.queueEnabled;
  element.duration.disabled = !view?.scrubEnabled;
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
  element.video.textContent = title;
  if (video) element.video.href = watchUrl(video.id);
  else element.video.removeAttribute('href');
  const videoId = video?.id ?? null;
  if (videoId !== detailsVideoId) void loadDetails(videoId);
}

function renderStatus() {
  renderActivity();
  element['history-notice'].textContent = watchHistoryNotice(latestStatus);
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
  if (busy) return;
  busy = true;
  element.notice.textContent = '';
  updateControls();
  try {
    const data = await send(type, fields);
    element.notice.textContent = data.done === false ? unchanged : success;
  } catch (error) { element.notice.textContent = error.message; }
  finally {
    await refreshStatus();
    busy = false;
    updateControls();
  }
}

function updateProgress() {
  const now = performance.now();
  const seconds = (now - progressTime) / 1000;
  progressTime = now;
  if (!latestStatus?.ok || latestStatus.player !== config.player.playing) return;
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

element.scrub.addEventListener('change', event => {
  const result = transitionScrub(scrub, {
    type: 'change', position: Number(event.currentTarget.value),
    duration: latestStatus?.duration,
  });
  scrub = result.state;
  if (latestStatus) latestStatus = { ...latestStatus, position: scrub.position };
  progressTime = performance.now();
  renderStatus();
  void perform(config.message.control, { action: config.control.seek, ...result.seek }, '');
});

// Popup links open in a normal tab, and the popup closes like a menu would.
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
});
void browser.browserAction.setBadgeText({ text: '' });
void browser.browserAction.setTitle({ title: 'Van TV' });
progressTimer = setInterval(updateProgress, config.progressIntervalMs);
void poll();
