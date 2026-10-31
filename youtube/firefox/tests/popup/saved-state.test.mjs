import assert from 'node:assert/strict';
import test from 'node:test';
import { downloadActive, downloadControlModel, downloadLabel, formatBytes, playbackSourceLabel, savedLibraryModel } from '../../popup/saved-state.mjs';
import { defaultLibrary, defaultStatus } from '../background/receiver-fixture.mjs';

const config = globalThis.VAN_TV_CONFIG;
const status = { ...defaultStatus, library: { available: true }, download: null };

test('download control hides without a loaded video or available library and shows progress or retry details', () => {
  assert.equal(downloadControlModel(status).hidden, false);
  assert.equal(downloadControlModel(status).label, 'Save on Van TV');
  for (const value of [null, { ...status, video: null }, { ...status, ok: false }, { ...status, library: null },
    { ...status, library: { available: false } }]) assert.equal(downloadControlModel(value).hidden, true);
  assert.equal(downloadControlModel(status, true).disabled, true);
  const downloading = downloadControlModel({ ...status, download: { state: config.downloadState.downloading, progress: 0.42, error: null } });
  assert.equal(downloading.disabled, true);
  assert.equal(downloading.progress, '42%');
  assert.equal(downloading.label, 'Downloading 42%');
  assert.equal(downloadLabel({ state: config.downloadState.downloading, progress: null }), 'Downloading…');
  assert.equal(downloadLabel({ state: config.downloadState.finalizing }), 'Saving…');
  assert.equal(downloadControlModel({ ...status, download: { state: config.downloadState.saved } }).disabled, true);
  const failed = downloadControlModel({ ...status, download: { state: config.downloadState.error, error: 'Drive full' } });
  assert.equal(failed.disabled, false);
  assert.equal(failed.label, 'Download failed: Drive full');
});

test('Held saves show their reason in the control and saved list and remain active for polling', () => {
  const download = { state: config.downloadState.waiting, progress: null,
    error: 'Waiting for metered connection permission' };
  const model = downloadControlModel({ ...status, download });
  assert.equal(model.disabled, true);
  assert.equal(downloadActive(download), true);
  assert.equal(model.label, download.error);
  const library = savedLibraryModel({ ...defaultLibrary,
    downloads: [{ id: status.video.id, title: 'Held video', ...download }] });
  assert.equal(library.downloads[0].label, download.error);
});

test('saved list sorts channel names case-insensitively and videos newest first without mutating input', () => {
  const library = structuredClone(defaultLibrary);
  library.channels[0].channel = 'zebra';
  const video = library.channels[0].videos[0];
  library.channels.unshift({ channel: 'Alpha', videos: [
    { ...video, savedAt: '2026-10-28T12:00:00Z', title: 'Older' },
    { ...video, savedAt: '2026-10-29T12:00:00Z', title: 'Newer', bytes: 2 * 1024 ** 3 },
  ] });
  library.downloads.push({ id: video.id, title: 'In progress', state: config.downloadState.downloading, progress: 0.5 });
  const model = savedLibraryModel(library);
  assert.deepEqual(model.channels.map(group => group.channel), ['Alpha', 'zebra']);
  assert.deepEqual(model.channels[0].videos.map(row => row.title), ['Newer', 'Older']);
  assert.equal(model.channels[0].videos[0].detail, '3:00 · 2.0 GiB');
  assert.equal(library.channels[0].videos[0].title, 'Older');
  assert.equal(model.downloads[0].label, 'Downloading 50%');
  assert.equal(savedLibraryModel({ available: false }).message, 'Saved videos unavailable.');
  assert.equal(savedLibraryModel({ available: true, channels: [], downloads: [] }).message, 'No saved videos.');
  assert.equal(formatBytes(512), '512 B');
  assert.equal(formatBytes(1024), '1.0 KiB');
});

test('Info source labels follow the receiver vocabulary and do not invent an unknown source', () => {
  assert.equal(playbackSourceLabel(config.source.saved), 'Saved copy');
  assert.equal(playbackSourceLabel(config.source.cache), 'Disk cache');
  assert.equal(playbackSourceLabel(config.source.web), 'YouTube');
  assert.equal(playbackSourceLabel(null), '');
});
