const element = id => document.getElementById(id);
const refresh = element('refresh');
const linkForm = element('link-form');
const linkInput = element('youtube-link');
let linkMessage = '';
let renderedQueue = '';
let renderedPlayed = '';
let subtitles;
let subtitleBusy = false;

async function post(path, body) {
  const response = await fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body) });
  if (!response.ok) {
    const data = await response.json().catch(() => ({}));
    throw new Error(data.error || 'Request failed');
  }
  return response.json();
}

function showLinkMessage(message) {
  linkMessage = message;
  element('message').textContent = message;
}

linkForm.addEventListener('submit', async event => {
  event.preventDefault();
  const queued = event.submitter?.value === 'queue';
  const buttons = [...linkForm.querySelectorAll('button')];
  buttons.forEach(button => { button.disabled = true; });
  showLinkMessage(queued ? 'Adding to the queue…' : 'Casting…');
  try {
    const body = queued ? { action: 'add', url: linkInput.value } : { url: linkInput.value };
    const result = await post(queued ? '/api/queue' : '/api/cast', body);
    if (queued && !result.done) throw new Error('Cannot add to the queue (it may be full)');
    linkInput.value = '';
    showLinkMessage(queued ? 'Added to the queue' : 'Casting…');
    await update();
  } catch (error) { showLinkMessage(error.message); }
  finally { buttons.forEach(button => { button.disabled = false; }); }
});

// `hint` names an icon-only button for tooltips and screen readers.
function queueButton(label, body, disabled = false, hint) {
  const button = document.createElement('button');
  button.type = 'button';
  button.textContent = label;
  if (hint) { button.title = hint; button.setAttribute('aria-label', hint); }
  button.disabled = disabled;
  button.addEventListener('click', async () => {
    try { await post('/api/queue', body); await update(); }
    catch { element('message').textContent = 'Cannot change the queue'; }
  });
  return button;
}

function videoLink(entry) {
  const link = document.createElement('a');
  link.href = `https://www.youtube.com/watch?v=${encodeURIComponent(entry.id)}`;
  link.target = '_blank';
  link.rel = 'noopener noreferrer';
  link.textContent = entry.title || entry.id;
  return link;
}

// Rebuilt only when the queue changes, so a poll never steals focus.
function renderQueue(queue = []) {
  const signature = JSON.stringify(queue);
  if (signature === renderedQueue) return;
  renderedQueue = signature;
  element('queue').replaceChildren(...queue.map((entry, index) => {
    const item = document.createElement('li');
    const actions = document.createElement('div');
    actions.className = 'queue-actions';
    actions.append(queueButton('Play now', { action: 'play', key: entry.key }),
      queueButton('Remove', { action: 'remove', key: entry.key }),
      queueButton('↑', { action: 'move', key: entry.key, index: index - 1 }, index === 0, 'Move up'),
      queueButton('↓', { action: 'move', key: entry.key, index: index + 1 }, index === queue.length - 1, 'Move down'));
    item.append(videoLink(entry), actions);
    return item;
  }));
  element('queue-empty').hidden = queue.length > 0;
}

function renderPlayed(played = []) {
  const signature = JSON.stringify(played);
  if (signature === renderedPlayed) return;
  renderedPlayed = signature;
  element('played').replaceChildren(...played.toReversed().map(entry => {
    const item = document.createElement('li');
    const actions = document.createElement('div');
    actions.className = 'queue-actions';
    actions.append(queueButton('Play again', { action: 'play', key: entry.key }));
    item.append(videoLink(entry), actions);
    return item;
  }));
  element('played-empty').hidden = played.length > 0;
}

async function update() {
  try {
    const response = await fetch('/api/status', { cache: 'no-store' });
    if (!response.ok) throw new Error('Status unavailable');
    const data = await response.json();
    element('receiver').textContent = data.receiver;
    element('player').textContent = data.player;
    element('video').textContent = data.video?.title || 'None';
    element('position').textContent = `${Math.floor(data.position)} / ${Math.floor(data.duration)} seconds`;
    element('senders').textContent = String(data.senders);
    const delayMs = Math.round(data.audioDelay * 1000);
    element('audio-delay').textContent = `${delayMs > 0 ? '+' : ''}${delayMs} ms`;
    element('volume').textContent = data.volume.muted ? `${data.volume.level} (muted)` : String(data.volume.level);
    element('mute').textContent = data.volume.muted ? 'Unmute' : 'Mute';
    element('speed').textContent = `${data.speed}×`;
    renderSubtitles(data.subtitles);
    renderQueue(data.queue);
    renderPlayed(data.played);
    element('code').textContent = data.pairing.code || (data.pairing.error ? 'Unavailable' : 'Requesting code…');
    element('message').textContent = data.pairing.error || linkMessage;
    refresh.disabled = data.pairing.requesting;
  } catch {
    renderSubtitles(null);
    element('receiver').textContent = 'Offline';
    element('code').textContent = 'Unavailable';
    element('message').textContent = 'Cannot reach Van TV. Retrying…';
    refresh.disabled = false;
  }
}

function renderSubtitles(value) {
  subtitles = value;
  const button = element('subtitles');
  button.disabled = subtitleBusy || !value;
  button.setAttribute('aria-pressed', String(Boolean(value?.enabled)));
  button.title = value?.enabled ? 'Turn subtitles off' : 'Turn subtitles on';
  const input = element('subtitle-language');
  if (value && document.activeElement !== input) input.value = value.language;
  element('subtitle-status').textContent = !value ? 'Unavailable'
    : !value.enabled ? `Off (${value.language})`
      : value.loading ? `Loading ${value.language}…`
        : value.error ? 'Failed to load; toggle CC to retry'
          : value.available === false ? `No ${value.language} subtitles` : `On (${value.language})`;
}

async function setSubtitles(fields) {
  subtitleBusy = true;
  renderSubtitles(subtitles);
  try {
    const result = await post('/api/control', { action: 'subtitles', ...fields });
    if (!result.done) throw new Error('Cannot save subtitles');
    await update();
  } catch (error) { element('message').textContent = error.message; }
  finally { subtitleBusy = false; renderSubtitles(subtitles); }
}

element('subtitles').addEventListener('click', () => void setSubtitles({ enabled: !subtitles?.enabled }));
element('subtitle-form').addEventListener('submit', event => {
  event.preventDefault();
  void setSubtitles({ language: element('subtitle-language').value.trim() });
});

refresh.addEventListener('click', async () => {
  refresh.disabled = true;
  try {
    const response = await fetch('/api/pairing', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    if (!response.ok) throw new Error('Refresh failed');
    await update();
  } catch { element('message').textContent = 'Cannot request a new code'; refresh.disabled = false; }
});
for (const button of document.querySelectorAll('button[data-action]')) {
  button.addEventListener('click', async () => {
    try {
      const body = { action: button.dataset.action };
      for (const field of ['delay', 'offset', 'speed']) {
        if (button.dataset[field] !== undefined) body[field] = Number(button.dataset[field]);
      }
      await post('/api/control', body);
      await update();
    } catch {
      element('message').textContent = `Cannot change ${button.closest('[aria-label]')?.getAttribute('aria-label') ?? 'playback'}`;
    }
  });
}
await update();
setInterval(update, 2000);
