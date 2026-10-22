import '../config.js';
import { activeTab, castTab, queueTab, tabVideo } from './tab-casting.mjs';
import { parseYouTubeVideo, youtubeMenuPatterns } from '../youtube/video-url.mjs';

const config = globalThis.VAN_TV_CONFIG;
const menu = Object.freeze({ link: 'cast-link', page: 'cast-page', queueLink: 'queue-link', queuePage: 'queue-page' });

function controlFields(message) {
  const fields = {};
  for (const name of ['position', 'delay', 'offset', 'speed', 'level', 'muted', 'videoId', 'key', 'index']) {
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
  browserApi.contextMenus.create({ id: menu.queueLink, title: 'Add to Queue',
    contexts: ['link'], targetUrlPatterns: patterns.link });
  browserApi.contextMenus.create({ id: menu.link, title: 'Cast',
    contexts: ['link'], targetUrlPatterns: patterns.link });
  browserApi.contextMenus.create({ id: menu.queuePage, title: 'Add to Queue',
    contexts: ['page'], documentUrlPatterns: patterns.page });
  browserApi.contextMenus.create({ id: menu.page, title: 'Cast',
    contexts: ['page'], documentUrlPatterns: patterns.page });
  const linkVideo = info => {
    const video = parseYouTubeVideo(info.linkUrl);
    if (!video) throw new Error('This link is not a YouTube video');
    return video;
  };
  const queued = new Set([menu.queueLink, menu.queuePage]);
  const actions = {
    [menu.link]: async info => {
      const video = linkVideo(info);
      await receiver.cast(video.videoId, video.position);
    },
    [menu.queueLink]: async info => {
      const result = await receiver.queue(config.queue.add, { videoId: linkVideo(info).videoId });
      if (!result.done) throw new Error('The Van TV queue is full');
    },
    [menu.page]: (_info, tab) => castTab(browserApi, receiver, tab),
    [menu.queuePage]: async (_info, tab) => {
      const result = await queueTab(browserApi, receiver, tab);
      if (!result.done) throw new Error('The Van TV queue is full');
    },
  };
  browserApi.contextMenus.onClicked.addListener((info, tab) => {
    const action = actions[info.menuItemId];
    if (!action) return;
    void showCastResult(browserApi, () => action(info, tab),
      queued.has(info.menuItemId) ? 'Van TV — added to the queue' : undefined);
  });
}

export function installCommands(browserApi, receiver) {
  browserApi.commands.onCommand.addListener(command => {
    if (command !== config.command) return;
    void showCastResult(browserApi, async () => castTab(browserApi, receiver, await activeTab(browserApi)));
  });
}
