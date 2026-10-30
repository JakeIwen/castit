import { open, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { isVideoId } from '../youtube/video-id.mjs';
import { normalizeVideoTitle } from '../youtube/video-title.mjs';
import { isQuality } from '../playback/quality.mjs';
import { complete } from './ranges.mjs';
import { UNKNOWN_CHANNEL, TRACK_ROLES } from './contracts.mjs';

export const isFormatId = value => typeof value === 'string' && /^[a-zA-Z0-9_-]{1,80}$/.test(value)
  && !Object.hasOwn(Object.prototype, value);

function validEntry(value, id) {
  if (value?.id !== id || typeof value.keep !== 'boolean' || !Number.isFinite(value.touchedAt)
    || !value.selections || !value.tracks || typeof value.title !== 'string'
    || typeof value.channel !== 'string'
    || (value.duration !== null && (!Number.isFinite(value.duration) || value.duration < 0))) return false;
  return Object.values(value.tracks).every(track => isFormatId(track.formatId)
    && Object.values(TRACK_ROLES).includes(track.role)
    && (track.size === null || (Number.isSafeInteger(track.size) && track.size > 0))
    && Array.isArray(track.ranges) && track.ranges.every(([start, end], index, ranges) =>
      Number.isSafeInteger(start) && Number.isSafeInteger(end) && start >= 0 && end > start
      && (track.size === null || end <= track.size) && (!index || start > ranges[index - 1][1])))
    && Object.entries(value.tracks).every(([key, track]) => key === track.formatId)
    && Object.entries(value.selections).every(([quality, formats]) => isQuality(quality)
      && Array.isArray(formats) && formats.length >= 1 && formats.length <= 2
      && formats.every(id => Object.hasOwn(value.tracks, id))
      && value.tracks[formats[0]].role === TRACK_ROLES.VIDEO
      && (formats.length === 1 || value.tracks[formats[1]].role === TRACK_ROLES.AUDIO));
}

export class CacheEntries {
  constructor(disk, now = Date.now) {
    Object.assign(this, { disk, now });
    this.entries = new Map();
    this.writes = new Map();
  }

  async get(id) {
    if (!isVideoId(id)) return null;
    if (this.entries.has(id)) return this.entries.get(id);
    try {
      const entry = await this.disk.readJson(join(this.disk.cachePath(id), 'entry.json'));
      if (!validEntry(entry, id)) return null;
      for (const track of Object.values(entry.tracks)) {
        if (!track.ranges.length) continue;
        const path = await this.disk.safe(this.disk.trackPath(entry, track.formatId));
        const file = await stat(path);
        if (!file.isFile() || file.size < track.ranges.at(-1)[1]) track.ranges = [];
      }
      if (this.entries.has(id)) return this.entries.get(id);
      this.entries.set(id, entry);
      return entry;
    } catch { return null; }
  }

  async save(entry) {
    const previous = this.writes.get(entry.id) ?? Promise.resolve();
    const next = previous.catch(() => {}).then(async () => {
      await this.disk.directory(this.disk.cachePath(entry.id));
      await this.disk.json(join(this.disk.cachePath(entry.id), 'entry.json'), entry);
    });
    this.writes.set(entry.id, next);
    try { await next; }
    finally { if (this.writes.get(entry.id) === next) this.writes.delete(entry.id); }
  }

  async attach(id, stream, quality) {
    if (!stream?.tracks?.length || !stream.tracks.every(track => isFormatId(track.formatId))) return null;
    let entry = await this.get(id) ?? this.entries.get(id);
    if (!entry) {
      entry = { id, title: id, channel: UNKNOWN_CHANNEL,
        duration: stream.duration ?? null, keep: false, touchedAt: this.now(), departedAt: null,
        selections: {}, tracks: {} };
      this.entries.set(id, entry);
    }
    entry.title = normalizeVideoTitle(stream.title) || entry.title;
    entry.channel = normalizeVideoTitle(stream.channel) || entry.channel;
    entry.duration = stream.duration ?? entry.duration;
    for (const track of stream.tracks) {
      if (!entry.tracks[track.formatId]) {
        const { formatId, role, size, ext, vcodec, acodec } = track;
        entry.tracks[formatId] = { formatId, role, size, ext, vcodec, acodec, ranges: [] };
      }
    }
    entry.selections[quality] = stream.tracks.map(track => track.formatId);
    entry.touchedAt = this.now();
    await this.save(entry);
    return entry;
  }

  selection(entry, quality) { return entry?.selections[quality]?.map(id => entry.tracks[id]) ?? []; }

  async local(id, quality) {
    const entry = await this.get(id);
    const tracks = this.selection(entry, quality);
    if (!tracks.length || !tracks.every(complete)) return null;
    await this.disk.require();
    for (const track of tracks) {
      const path = await this.disk.safe(this.disk.trackPath(entry, track.formatId));
      if ((await stat(path)).size < track.size) return null;
    }
    return { entry, tracks };
  }

  async read(entry, track, start, end) {
    await this.disk.require();
    const path = await this.disk.safe(this.disk.trackPath(entry, track.formatId));
    const file = await open(path, 'r');
    try {
      const buffer = Buffer.alloc(end - start);
      let count = 0;
      while (count < buffer.length) {
        const { bytesRead } = await file.read(buffer, count, buffer.length - count, start + count);
        if (!bytesRead) throw new Error('Incomplete cache file');
        count += bytesRead;
      }
      return buffer;
    } finally { await file.close(); }
  }

  async remove(id) {
    await this.writes.get(id)?.catch(() => {});
    await this.disk.remove(this.disk.cachePath(id));
    this.entries.delete(id);
  }

  async all() {
    const directories = await this.disk.list(join(this.disk.root, '.cache'));
    return (await Promise.all(directories.filter(item => item.isDirectory() && isVideoId(item.name))
      .map(item => this.get(item.name)))).filter(Boolean);
  }
}
