import { mkdtemp, mkdir, rm, stat, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { StoreDisk } from '../../src/video-store/store-disk.mjs';
import { VideoStore } from '../../src/video-store/video-store.mjs';
import { STORE_LIMITS } from '../../src/video-store/contracts.mjs';

export const ID = 'abcdefghijk';
export const SECOND_ID = '0123456789a';
export const options = signal => ({ quality: 'auto', signal });

export class Clock {
  value = 1_800_000_000_000;
  timers = new Map();
  now = () => this.value;
  setTimer = (fn, delay) => { const key = {}; this.timers.set(key, { fn, at: this.value + delay }); return key; };
  clearTimer = key => this.timers.delete(key);
  async advance(ms) {
    this.value += ms;
    for (const [key, task] of this.timers) {
      if (task.at > this.value) continue;
      this.timers.delete(key);
      await task.fn();
    }
  }
}

export async function fixture(t, { resources = { video: Buffer.from('0123456789abcdefghijklmnopqrstuvwxyz') },
  unknownSize = false, resolver: suppliedResolver, ...settings } = {}) {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'video-store-')));
  const mount = join(directory, 'drive');
  const root = join(mount, 'van-tv');
  await mkdir(mount);
  const state = { mounted: true, freeBytes: STORE_LIMITS.freeBytes * 10, expired: false, requests: [], resolutions: [] };
  const upstream = createServer((request, response) => {
    const name = request.url.split('?')[0].slice(1);
    const buffer = resources[name];
    if (!buffer) { response.writeHead(404); response.end(); return; }
    if (state.expired && !request.url.includes('fresh')) { response.writeHead(403); response.end(); return; }
    const match = /^bytes=(\d+)-(\d+)$/.exec(request.headers.range ?? '');
    if (!match) { response.writeHead(400); response.end(); return; }
    const start = Number(match[1]);
    const end = Math.min(buffer.length, Number(match[2]) + 1);
    state.requests.push({ name, start, end, headers: request.headers });
    response.writeHead(206, { 'Content-Range': `bytes ${start}-${end - 1}/${buffer.length}`,
      'Content-Length': end - start });
    response.end(buffer.subarray(start, end));
  });
  await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${upstream.address().port}`;
  const resolver = suppliedResolver ?? { resolve: async (id, options) => {
    state.resolutions.push({ id, ...options });
    const tracks = Object.entries(resources).map(([name, buffer], index) => ({
      formatId: index ? '140' : (options.quality === '720' ? '136' : '137'), role: index ? 'audio' : 'video',
      size: unknownSize ? null : buffer.length, ext: 'mp4', vcodec: index ? 'none' : 'avc1',
      acodec: index || Object.keys(resources).length === 1 ? 'mp4a' : 'none',
      url: `${base}/${name}${options.fresh ? '?fresh' : ''}`, headers: { 'User-Agent': 'Cache fixture' },
    }));
    return { title: 'A title: safe?', channel: 'Example/channel', duration: 1, httpOptions: {}, tracks,
      videoUrl: tracks[0].url, audioUrl: tracks[1]?.url ?? null };
  } };
  const disk = new StoreDisk(root, {
    statPath: async path => path === mount ? { dev: state.mounted ? -1 : (await stat(directory)).dev,
      isDirectory: () => true } : stat(path),
    diskSpace: async () => ({ bavail: state.freeBytes, bsize: 1 }),
  });
  const clock = new Clock();
  const store = new VideoStore({ disk, resolver, now: clock.now, setTimer: clock.setTimer,
    clearTimer: clock.clearTimer, ffmpeg: process.platform === 'darwin' ? '/opt/homebrew/bin/ffmpeg' : '/usr/bin/ffmpeg',
    permissions: { allows: async () => true },
    ...settings });
  t.after(async () => {
    await store.close();
    await new Promise(resolve => { upstream.close(resolve); upstream.closeAllConnections(); });
    await rm(directory, { recursive: true, force: true });
  });
  return { store, disk, root, directory, state, clock, resolver, resources, upstream };
}

export async function finishedDownload(store, id) {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const job = (await store.list()).downloads.find(item => item.id === id);
    if (job && ['saved', 'error'].includes(job.state)) return job;
    await new Promise(resolve => setImmediate(resolve));
  }
  throw new Error('Download did not finish');
}

export async function range(url, start, end) {
  const response = await fetch(url, { headers: { Range: `bytes=${start}-${end - 1}` } });
  if (response.status !== 206) throw new Error(`Expected 206, got ${response.status}`);
  return Buffer.from(await response.arrayBuffer());
}
