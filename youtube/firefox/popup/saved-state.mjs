import '../config.js';
import { formatTime } from './state.mjs';

const { downloadState, source } = globalThis.VAN_TV_CONFIG;
const sourceLabels = Object.freeze({
  [source.saved]: 'Saved copy', [source.cache]: 'Disk cache', [source.web]: 'YouTube',
});
export const playbackSourceLabel = value => Object.hasOwn(sourceLabels, value) ? sourceLabels[value] : '';
export const downloadActive = value => value?.state === downloadState.downloading || value?.state === downloadState.finalizing;

export function downloadLabel(download) {
  switch (download?.state) {
    case downloadState.downloading:
      return download.progress === null ? 'Downloading…' : `Downloading ${Math.floor(download.progress * 100)}%`;
    case downloadState.finalizing: return 'Saving…';
    case downloadState.saved: return 'Saved';
    case downloadState.error: return `Download failed${download.error ? `: ${download.error}` : ''}`;
    default: return 'Save on Van TV';
  }
}

export function downloadControlModel(status, busy = false) {
  const download = status?.download;
  return {
    hidden: !status?.ok || !status.video || !status.library?.available,
    disabled: busy || downloadActive(download) || download?.state === downloadState.saved,
    label: downloadLabel(download),
    state: download?.state ?? '',
    // A percentage fits in the control without replacing its download icon.
    progress: download?.state === downloadState.downloading && download.progress !== null
      ? `${Math.floor(download.progress * 100)}%` : '',
  };
}

export function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes < 0) return '—';
  if (bytes < 1024) return `${bytes} B`;
  const unit = bytes >= 1024 ** 3 ? 'GiB' : bytes >= 1024 ** 2 ? 'MiB' : 'KiB';
  const divisor = { GiB: 1024 ** 3, MiB: 1024 ** 2, KiB: 1024 }[unit];
  return `${(bytes / divisor).toFixed(1)} ${unit}`;
}

export function savedLibraryModel(library) {
  if (!library?.available) return { message: 'Saved videos unavailable.', channels: [], downloads: [] };
  const channels = library.channels.map(group => ({
    channel: group.channel,
    videos: [...group.videos].sort((a, b) => new Date(b.savedAt).getTime() - new Date(a.savedAt).getTime()).map(video => ({
      id: video.id, title: video.title || video.id,
      detail: `${formatTime(video.duration)} · ${formatBytes(video.bytes)}`,
    })),
  })).filter(group => group.videos.length)
    .sort((a, b) => a.channel.localeCompare(b.channel, 'en', { sensitivity: 'base' }));
  return { message: channels.some(group => group.videos.length) || library.downloads.length ? '' : 'No saved videos.',
    channels, downloads: library.downloads.map(download => ({
      id: download.id, title: download.title || download.id, label: downloadLabel(download),
    })) };
}
