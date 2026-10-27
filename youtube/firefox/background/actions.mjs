import '../config.js';
import { activeTab, castTab, queueTab, tabVideo } from './tab-casting.mjs';
import { parseYouTubeVideo, youtubeMenuPatterns } from '../youtube/video-url.mjs';

const config = globalThis.VAN_TV_CONFIG;
// Firefox nests an extension's items in a submenu once there is more than one
// per context, so each context gets one item and Shift-click queues instead.
const menu = Object.freeze({ link: 'cast-link', page: 'cast-page' });
const menuTitle = 'Van TV: Cast Now (Shift: Add to Queue)';

function controlFields(message) {
  const fields = {};
  for (const name of ['position', 'delay', 'offset', 'speed', 'level', 'muted', 'videoId', 'key', 'current', 'index', 'quality', 'enabled', 'language']) {
    if (Object.hasOwn(message, name)) fields[name] = message[name];
  }
  return fields;
}

export function createMessageHandler(browserApi, receiver, videoDetails) {
  const routes = {
    [config.message.status]: () => receiver.status(),
    [config.message.control]: message => receiver.control(message.action, controlFields(message)),
    [config.message.cast]: message => receiver.cast(message.videoId, message.position),
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
  const linkVideo = info => {
    const video = parseYouTubeVideo(info.linkUrl);
    if (!video) throw new Error('This link is not a YouTube video');
    return video;
  };
  const queued = result => {
    if (!result.done) throw new Error('The Van TV queue is full');
  };
  const actions = {
    [menu.link]: {
      cast: async info => {
        const video = linkVideo(info);
        await receiver.cast(video.videoId, video.position);
      },
      queue: async info => queued(await receiver.queue(config.queue.add, { videoId: linkVideo(info).videoId })),
    },
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
    void showCastResult(browserApi, () => (queue ? item.queue : item.cast)(info, tab),
      queue ? 'Van TV — added to the queue' : 'Van TV — cast accepted');
  });
}

export function installRemoteAction(browserApi) {
  browserApi.browserAction.onClicked.addListener(() => {
    void browserApi.sidebarAction.toggle().catch(error => {
      console.warn('Van TV sidebar could not toggle', error);
    });
  });
}

export function installCommands(browserApi, receiver) {
  browserApi.commands.onCommand.addListener(command => {
    if (command !== config.command) return;
    void showCastResult(browserApi, async () => castTab(browserApi, receiver, await activeTab(browserApi)));
  });
}
