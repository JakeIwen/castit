import { stat, rename } from 'node:fs/promises';
import { join, basename, dirname } from 'node:path';
import { isVideoId } from '../youtube/video-id.mjs';
import { runCommand } from '../host/process-command.mjs';
import { STORE_LIMITS, UNKNOWN_CHANNEL, TRACK_ROLES, VideoStoreError } from './contracts.mjs';

export function safeName(value, fallback = 'Untitled') {
  const text = String(value ?? '').normalize('NFC').replace(/[\p{Cc}"*/:<>?\\|]/gu, '_')
    .replace(/[. ]+$/g, '').trim();
  let result = '';
  for (const character of text) {
    if (result.length + character.length > 200) break;
    result += character;
  }
  result = result.replace(/[. ]+$/g, '');
  if (!result || /^\.+$/.test(result)) return fallback;
  if (result.startsWith('.')) result = `_${result.slice(1)}`;
  return /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(result) ? `_${result}` : result;
}

export function savedExtension(tracks) {
  const video = tracks.find(track => track.role === TRACK_ROLES.VIDEO);
  const audio = tracks.find(track => track.role === TRACK_ROLES.AUDIO) ?? video;
  return /^(avc|h264)/i.test(video?.vcodec ?? '') && /^(mp4a|aac)/i.test(audio?.acodec ?? '') ? 'mp4' : 'mkv';
}

export class SavedLibrary {
  constructor(disk, { run = runCommand, ffmpeg = '/usr/bin/ffmpeg', now = Date.now } = {}) {
    Object.assign(this, { disk, run, ffmpeg, now });
    this.videos = new Map();
  }

  async scan() {
    const videos = new Map();
    for (const directory of await this.disk.list(this.disk.root)) {
      if (!directory.isDirectory() || directory.name.startsWith('.')) continue;
      const path = join(this.disk.root, directory.name);
      for (const file of await this.disk.list(path)) {
        if (!file.isFile() || !file.name.endsWith('.info.json')) continue;
        const video = await this.read(join(path, file.name));
        if (video) videos.set(video.id, video);
      }
    }
    this.videos = videos;
    return videos;
  }

  async read(sidecar) {
    try {
      const video = await this.disk.readJson(sidecar);
      if (!isVideoId(video?.id) || typeof video.title !== 'string' || typeof video.channel !== 'string'
        || typeof video.file !== 'string' || basename(video.file) !== video.file
        || !video.file.endsWith('.mp4') && !video.file.endsWith('.mkv')
        || !Number.isFinite(Date.parse(video.savedAt))) return null;
      const path = join(dirname(sidecar), video.file);
      await this.disk.safe(path);
      const file = await stat(path);
      if (!file.isFile() || !file.size) return null;
      return { ...video, bytes: file.size, path, sidecar };
    } catch { return null; }
  }

  async find(id) {
    await this.scan();
    return this.videos.get(id) ?? null;
  }

  channels() {
    const channels = new Map();
    for (const video of this.videos.values()) {
      const { id, title, channel, duration, bytes, savedAt } = video;
      if (!channels.has(channel)) channels.set(channel, []);
      channels.get(channel).push({ id, title, channel, duration, bytes, savedAt });
    }
    return [...channels].sort(([a], [b]) => a.toLowerCase().localeCompare(b.toLowerCase()))
      .map(([channel, videos]) => ({ channel, videos: videos.sort((a, b) => b.savedAt.localeCompare(a.savedAt)) }));
  }

  async save(entry, tracks, quality, signal) {
    const bytes = tracks.reduce((sum, track) => sum + track.size, 0);
    const ext = savedExtension(tracks);
    const temporary = join(this.disk.cachePath(entry.id), `finalizing.${ext}`);
    await this.disk.remove(temporary);
    await this.disk.require(true, bytes + STORE_LIMITS.chunkBytes);
    const directory = join(this.disk.root, safeName(entry.channel, UNKNOWN_CHANNEL));
    await this.disk.directory(directory);
    const file = `${safeName(entry.title)} [${entry.id}].${ext}`;
    const destination = await this.disk.safe(join(directory, file));
    const inputs = await Promise.all(tracks.map(track => this.disk.safe(this.disk.trackPath(entry, track.formatId))));
    const argv = [this.ffmpeg, '-nostdin', '-hide_banner', '-loglevel', 'error', '-y',
      ...inputs.flatMap(path => ['-i', path]), '-map', '0:v:0', '-map', tracks.length > 1 ? '1:a:0' : '0:a:0?',
      '-c', 'copy', temporary];
    const abort = new AbortController();
    const combined = signal ? AbortSignal.any([signal, abort.signal]) : abort.signal;
    let spaceError;
    const timer = setInterval(() => {
      void this.disk.require(true).catch(error => { spaceError = error; abort.abort(); });
    }, 1000);
    timer.unref?.();
    try { await this.run(argv, { signal: combined, timeoutMs: STORE_LIMITS.muxTimeoutMs }); }
    catch (error) { await this.disk.remove(temporary).catch(() => {}); throw spaceError ?? error; }
    finally { clearInterval(timer); }
    combined.throwIfAborted();
    await this.disk.require(true);
    await rename(temporary, destination);
    const video = { id: entry.id, title: entry.title, channel: entry.channel, duration: entry.duration,
      bytes: (await stat(destination)).size, savedAt: new Date(this.now()).toISOString(), quality,
      codecs: tracks.map(({ formatId, vcodec, acodec, size }) => ({ formatId, vcodec, acodec, size })), file };
    const sidecar = `${destination}.info.json`;
    await this.disk.json(sidecar, video);
    this.videos.set(entry.id, { ...video, path: destination, sidecar });
    return video;
  }

  async delete(id) {
    if (!isVideoId(id)) throw new VideoStoreError('Invalid video id');
    const video = await this.find(id);
    if (!video) return false;
    await this.disk.remove(video.path);
    await this.disk.remove(video.sidecar);
    this.videos.delete(id);
    return true;
  }
}
