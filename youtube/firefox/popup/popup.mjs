import '../config.js';
import { createScrubState, formatTime, popupState, transitionScrub } from './state.mjs';
import { watchUrl } from '../youtube/video-url.mjs';

const config = globalThis.VAN_TV_CONFIG;
const ids = [
  'state', 'video', 'elapsed', 'duration', 'scrub', 'notice', 'cast-tab',
  'previous', 'back-five', 'back-twenty', 'toggle', 'forward-twenty',
  'forward-five', 'next', 'stop', 'restart', 'play-icon', 'pause-icon',
  'sound-earlier', 'sound-later', 'reset-delay', 'audio-delay-value',
  'volume-down', 'volume-up', 'volume-value', 'mute', 'speed-down', 'speed-up', 'speed-reset',
  'speed-value', 'queue-section', 'queue', 'queue-clear', 'queue-tab',
  'channel', 'channel-avatar', 'channel-name', 'channel-verified', 'channel-subscribers',
];
const element = Object.fromEntries(ids.map(id => [id, document.getElementById(id)]));
const transportControls = [
  { button: element.previous, action: config.control.previous },
  { button: element['back-five'], action: config.control.seek,
    fields: { offset: config.skipOffsets.backwardFiveMinutes } },
  { button: element['back-twenty'], action: config.control.seek,
    fields: { offset: config.skipOffsets.backwardTwentySeconds } },
  { button: element.toggle, action: config.control.toggle },
  { button: element['forward-twenty'], action: config.control.seek,
    fields: { offset: config.skipOffsets.forwardTwentySeconds } },
  { button: element['forward-five'], action: config.control.seek,
    fields: { offset: config.skipOffsets.forwardFiveMinutes } },
  { button: element.next, action: config.control.next },
  { button: element.stop, action: config.control.stop },
  { button: element.restart, action: config.control.seek, fields: { position: 0 } },
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
const removeIcon = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6 6 18"/></svg>';

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
let renderedQueue = '';
let detailsVideoId = null;

async function send(type, fields = {}) {
  const response = await browser.runtime.sendMessage({ type, ...fields });
  if (!response?.ok) throw new Error(response?.error || 'Van TV request failed');
  return response.data;
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
  for (const button of element.queue.querySelectorAll('button')) button.disabled = busy;
  element['queue-clear'].disabled = busy;
  element['cast-tab'].disabled = busy || !tabAvailable;
  element['queue-tab'].disabled = busy || !tabAvailable || !view?.queueEnabled;
  element.duration.disabled = !view?.scrubEnabled;
}

function queueButton(className, label, fields, content) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = className;
  button.title = label;
  button.setAttribute('aria-label', label);
  button.append(content);
  button.addEventListener('click', () => void perform(config.message.queue, fields, '', 'Already gone from the queue'));
  return button;
}

// Rebuilt only when the queue changes, so polling never steals focus.
function renderQueue(entries) {
  const signature = JSON.stringify(entries);
  if (signature === renderedQueue) return;
  renderedQueue = signature;
  element['queue-section'].hidden = entries.length === 0;
  element.queue.replaceChildren(...entries.map(entry => {
    const item = document.createElement('li');
    const remove = document.createElement('template');
    remove.innerHTML = removeIcon;
    item.append(
      queueButton('queue-play', `Play now: ${entry.title}`,
        { action: config.queue.play, key: entry.key }, entry.title),
      queueButton('icon-button queue-remove', `Remove from queue: ${entry.title}`,
        { action: config.queue.remove, key: entry.key }, remove.content),
    );
    return item;
  }));
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
  if (latestStatus) {
    const view = popupState(latestStatus);
    element.state.textContent = view.state === latestStatus.player
      ? view.state[0] + view.state.slice(1).toLowerCase() : view.state;
    renderVideo(view.title, latestStatus.video);
    renderQueue(view.queue);
  } else {
    element.state.textContent = 'Van TV unreachable';
    renderVideo('', null);
    renderQueue([]);
  }
  renderPlayback();
  updateControls();
}

async function refreshStatus() {
  try {
    const status = await send(config.message.status);
    scrub = transitionScrub(scrub, {
      type: 'poll', position: status.position, duration: status.duration,
    }).state;
    latestStatus = status;
  } catch {
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
    await refreshStatus();
  } catch (error) { element.notice.textContent = error.message; }
  finally { busy = false; updateControls(); }
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
    void browser.tabs.create({ url: link.href }).then(() => window.close());
  });
}

element['cast-tab'].addEventListener('click', () => void perform(
  config.message.castTab, {}, 'Cast accepted'));
element['queue-tab'].addEventListener('click', () => void perform(
  config.message.queueTab, {}, 'Added to the queue', 'The queue is full'));
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
});
void browser.browserAction.setBadgeText({ text: '' });
void browser.browserAction.setTitle({ title: 'Van TV' });
progressTimer = setInterval(updateProgress, config.progressIntervalMs);
void poll();
