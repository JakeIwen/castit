import '../config.js';
import '../youtube/video-title.js';
import { isPosition, parseYouTubeVideo } from '../youtube/video-url.mjs';

const { message, queue } = globalThis.VAN_TV_CONFIG;
const cleanVideoTitle = globalThis.VAN_TV_CLEAN_VIDEO_TITLE;

export async function activeTab(browserApi) {
  const [tab] = await browserApi.tabs.query({ active: true, currentWindow: true });
  return tab ?? null;
}

/** @returns {Promise<import('../youtube/video-url.mjs').VideoSelection|null>} */
export async function tabVideo(browserApi, tab) {
  const parsed = parseYouTubeVideo(tab?.url);
  if (!parsed) return null;
  let current;
  try { current = await browserApi.tabs.sendMessage(tab.id, {
    type: message.getVideo, url: tab.url, videoId: parsed.videoId,
  }); }
  catch { return parsed; }
  // A responsive content script returning no video means the SPA navigated;
  // only an unavailable script may fall back to the original URL.
  if (!current || current.videoId !== parsed.videoId) {
    throw new Error('The tab changed; try casting again');
  }
  const title = cleanVideoTitle(current.title);
  const selection = current.position === null ? parsed : current;
  if (!isPosition(selection.position)) throw new Error('Invalid tab playback position');
  return title ? { ...selection, title } : selection;
}

export async function castTab(browserApi, receiver, tab) {
  const video = await tabVideo(browserApi, tab);
  if (!video) throw new Error('Open a YouTube video to cast this tab');
  const title = cleanVideoTitle(video.title) ?? cleanVideoTitle(tab?.title, { page: true });
  const result = await receiver.cast(video.videoId, video.position, title);
  try {
    await browserApi.tabs.sendMessage(tab.id, {
      type: message.castAccepted, videoId: video.videoId, url: tab.url,
    });
  } catch { /* A URL-only cast can succeed without a content script to pause. */ }
  return result;
}

// Queued videos start from the beginning, and the tab keeps playing.
export async function queueTab(browserApi, receiver, tab) {
  const video = parseYouTubeVideo(tab?.url);
  if (!video) throw new Error('Open a YouTube video to queue this tab');
  return receiver.queue(queue.add, { videoId: video.videoId, title: cleanVideoTitle(tab?.title, { page: true }) });
}
