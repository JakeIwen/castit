import '../config.js';
import '../youtube/video-title.js';
import { activeTab, castTab, queueTab, tabVideo } from './tab-casting.mjs';
import { parseYouTubeVideo, youtubeMenuPatterns } from '../youtube/video-url.mjs';

const config = globalThis.VAN_TV_CONFIG;
const cleanVideoTitle = globalThis.VAN_TV_CLEAN_VIDEO_TITLE;
// Firefox groups multiple extension items into a submenu; Save is separate
// because Shift-click already queues the video.
const menu = Object.freeze({ link: 'cast-link', page: 'cast-page', saveLink: 'save-link', savePage: 'save-page' });
const menuTitle = 'Van TV: Cast Now (Shift: Add to Queue)';

function controlFields(message) {
  const fields = {};
  for (const name of ['id', 'position', 'delay', 'offset', 'speed', 'level', 'muted', 'videoId', 'title', 'key', 'current', 'index', 'quality', 'enabled', 'language']) {
    if (Object.hasOwn(message, name)) fields[name] = message[name];
  }
  return fields;
}

export function createMessageHandler(browserApi, receiver, videoDetails) {
  const routes = {
    [config.message.status]: () => receiver.status(),
    [config.message.library]: () => receiver.library(),
    [config.message.control]: message => receiver.control(message.action, controlFields(message)),
    [config.message.cast]: message => receiver.cast(message.videoId, message.position, message.title),
    [config.message.tabVideo]: async () => tabVideo(browserApi, await activeTab(browserApi)),
    [config.message.castTab]: async () => castTab(browserApi, receiver, await activeTab(browserApi)),
    [config.message.queue]: message => receiver.queue(message.action, controlFields(message)),
    [config.message.queueTab]: async () => queueTab(browserApi, receiver, await activeTab(browserApi)),
    [config.message.videoDetails]: message => videoDetails.details(message.videoId),
  };
  return (message, sender) => {
    const route = message && Object.hasOwn(routes, message.type) && routes[message.type];
    if (!route) return undefined;
    // Only the player cast message belongs to a content script; receiver
    // controls and status are private to extension pages, not the website.
    if (sender?.tab && message.type !== config.message.cast) return undefined;
    return Promise.resolve().then(() => route(message)).then(
      data => ({ ok: true, data }),
      error => ({ ok: false, error: error.message || 'Van TV request failed' }),
    );
  };
}

export async function showCastResult(browserApi, operation, success = 'Van TV — cast accepted') {
  try {
    await operation();
    await browserApi.browserAction.setBadgeText({ text: '' });
    await browserApi.browserAction.setTitle({ title: success });
  } catch (error) {
    await browserApi.browserAction.setBadgeText({ text: '!' });
    await browserApi.browserAction.setTitle({ title: error.message || 'Van TV request failed' });
  }
}

export async function installContextMenus(browserApi, receiver) {
  const patterns = youtubeMenuPatterns();
  await browserApi.contextMenus.removeAll();
  browserApi.contextMenus.create({ id: menu.link, title: menuTitle,
    contexts: ['link'], targetUrlPatterns: patterns.link });
  browserApi.contextMenus.create({ id: menu.page, title: menuTitle,
    contexts: ['page'], documentUrlPatterns: patterns.page });
  browserApi.contextMenus.create({ id: menu.saveLink, title: 'Save on Van TV',
    contexts: ['link'], targetUrlPatterns: patterns.link });
  browserApi.contextMenus.create({ id: menu.savePage, title: 'Save on Van TV',
    contexts: ['page'], documentUrlPatterns: patterns.page });
  const linkVideo = info => {
    const video = parseYouTubeVideo(info.linkUrl);
    if (!video) throw new Error('This link is not a YouTube video');
    return { ...video, title: cleanVideoTitle(info.linkText, { link: true }) };
  };
  const queued = result => {
    if (!result.done) throw new Error('The Van TV queue is full');
  };
  const actions = {
    [menu.link]: {
      cast: async info => {
        const video = linkVideo(info);
        await receiver.cast(video.videoId, video.position, video.title);
      },
      queue: async info => {
        const video = linkVideo(info);
        queued(await receiver.queue(config.queue.add, { videoId: video.videoId, title: video.title }));
      },
    },
    [menu.saveLink]: { save: info => saveVideo(receiver, info.linkUrl) },
    [menu.savePage]: { save: (_info, tab) => saveVideo(receiver, tab?.url) },
    [menu.page]: {
      cast: async (_info, tab) => castTab(browserApi, receiver, tab),
      queue: async (_info, tab) => queued(await queueTab(browserApi, receiver, tab)),
    },
  };
  browserApi.contextMenus.onClicked.addListener((info, tab) => {
    const item = actions[info.menuItemId];
    if (!item) return;
    // Opening a sidebar requires the menu gesture, before the request yields.
    // A sidebar failure must not prevent the cast or queue operation.
    void browserApi.sidebarAction.open().catch(error => {
      console.warn('Van TV sidebar could not open', error);
    });
    const queue = info.modifiers?.includes('Shift');
    const operation = item.save ?? (queue ? item.queue : item.cast);
    const success = item.save ? 'Van TV — download accepted'
      : queue ? 'Van TV — added to the queue' : 'Van TV — cast accepted';
    void showCastResult(browserApi, () => operation(info, tab), success);
  });
}

async function saveVideo(receiver, url) {
  const video = parseYouTubeVideo(url);
  if (!video) throw new Error('This is not a YouTube video');
  const result = await receiver.control(config.control.download, { id: video.videoId });
  if (!result.done) throw new Error('Van TV could not start the download');
}

export function installRemoteAction(browserApi) {
  browserApi.browserAction.onClicked.addListener(() => {
    void browserApi.sidebarAction.toggle().catch(error => {
      console.warn('Van TV sidebar could not toggle', error);
    });
  });
}

function versionBefore(version, other) {
  const [left, right] = [version, other].map(value => value.split('.').map(Number));
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    const difference = (left[index] ?? 0) - (right[index] ?? 0);
    if (difference) return difference < 0;
  }
  return false;
}

// The pane toggle gets its default key once: on install, or on the update that
// added it. Later updates keep what the user set or cleared in Manage Extension
// Shortcuts. Firefox runs the toggle itself, so it counts as a user action.
export function installSidebarShortcut(browserApi) {
  const { command, key, since } = config.sidebarShortcut;
  browserApi.runtime.onInstalled.addListener(({ reason, previousVersion }) => {
    const added = reason === 'install' || (reason === 'update' && versionBefore(previousVersion, since));
    if (!added) return;
    void browserApi.commands.update({ name: command, shortcut: key }).catch(error => {
      console.warn('Van TV sidebar shortcut could not be set', error);
    });
  });
}

export function installCommands(browserApi, receiver) {
  browserApi.commands.onCommand.addListener(command => {
    if (command !== config.command) return;
    void showCastResult(browserApi, async () => castTab(browserApi, receiver, await activeTab(browserApi)));
  });
}
