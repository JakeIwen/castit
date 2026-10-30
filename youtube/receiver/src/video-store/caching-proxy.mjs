import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { STORE_LIMITS, VideoStoreError } from './contracts.mjs';
import { requestRange } from './ranges.mjs';

export class CachingProxy {
  constructor(entries, transfer) {
    Object.assign(this, { entries, transfer });
    this.routes = new Map();
    this.abort = new AbortController();
    this.pending = new Set();
  }

  async start() {
    this.starting ||= new Promise((resolve, reject) => {
      this.server = createServer((request, response) => {
        const pending = this.handle(request, response).catch(() => {
          if (!response.headersSent) response.writeHead(502);
          response.destroy();
        }).finally(() => this.pending.delete(pending));
        this.pending.add(pending);
      });
      this.server.once('error', reject);
      this.server.listen(0, '127.0.0.1', resolve);
      this.server.unref();
    });
    await this.starting;
  }

  async stream(session, signal) {
    await this.start();
    signal?.throwIfAborted();
    const token = randomUUID();
    this.routes.set(token, { session, signal });
    signal?.addEventListener('abort', () => this.routes.delete(token), { once: true });
    const address = `http://127.0.0.1:${this.server.address().port}/${token}`;
    const tracks = this.entries.selection(session.entry, session.quality);
    return { ...session.stream, videoUrl: `${address}/${tracks[0].formatId}`,
      audioUrl: tracks[1] ? `${address}/${tracks[1].formatId}` : null };
  }

  async handle(request, response) {
    const host = `127.0.0.1:${this.server.address().port}`;
    if (request.headers.host !== host || !['GET', 'HEAD'].includes(request.method)) {
      response.writeHead(403); response.end(); return;
    }
    const [token, formatId] = request.url.slice(1).split('/');
    const route = this.routes.get(token);
    const track = route && Object.hasOwn(route.session.entry.tracks, formatId)
      ? route.session.entry.tracks[formatId] : null;
    if (!track) { response.writeHead(404); response.end(); return; }
    const abort = new AbortController();
    response.once('close', () => abort.abort());
    const signal = AbortSignal.any([abort.signal, this.abort.signal, ...(route.signal ? [route.signal] : [])]);
    const { session } = route;
    try {
      const state = await this.entries.disk.inspect();
      if (!state.available || state.freeBytes < STORE_LIMITS.freeBytes) {
        const source = session.stream.tracks.find(item => item.formatId === formatId);
        response.writeHead(307, { Location: source.url }); response.end(); return;
      }
      const size = await this.transfer.size(session, track, signal);
      const range = requestRange(request.headers.range, size);
      if (!range) {
        response.writeHead(416, { 'Content-Range': `bytes */${size}` }); response.end(); return;
      }
      await this.respond(response, request.method, session, track, range, signal);
    } catch (error) {
      if (!response.headersSent && error instanceof VideoStoreError) {
        response.writeHead(error.statusCode); response.end();
      } else response.destroy();
    }
  }

  async respond(response, method, session, track, range, signal) {
    const headers = { 'Accept-Ranges': 'bytes', 'Content-Type': 'application/octet-stream',
      'Content-Length': range.end - range.start, 'Cache-Control': 'no-store' };
    if (range.partial) headers['Content-Range'] = `bytes ${range.start}-${range.end - 1}/${track.size}`;
    if (method === 'HEAD') {
      response.writeHead(range.partial ? 206 : 200, headers); response.end(); return;
    }
    // Keep the first response small enough that playback needn't wait for a
    // full 10 MiB transfer before mpv can probe the container.
    for (let start = range.start; start < range.end; start += STORE_LIMITS.readBytes) {
      signal.throwIfAborted();
      const end = Math.min(range.end, start + STORE_LIMITS.readBytes);
      await this.transfer.ensure(session, track, start, end, signal);
      const buffer = await this.entries.read(session.entry, track, start, end);
      if (!response.headersSent) response.writeHead(range.partial ? 206 : 200, headers);
      await new Promise((resolve, reject) => response.write(buffer, error => error ? reject(error) : resolve()));
    }
    response.end();
  }

  async drain() { await Promise.allSettled([...this.pending]); }

  async close() {
    this.abort.abort();
    this.routes.clear();
    if (this.server) {
      await new Promise(resolve => { this.server.close(resolve); this.server.closeAllConnections(); });
    }
    await Promise.allSettled(this.pending);
  }
}
