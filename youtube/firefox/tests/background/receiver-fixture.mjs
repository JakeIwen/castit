import { createServer } from 'node:http';
import '../../config.js';

export const videoId = 'dQw4w9WgXcQ';
export const defaultStatus = Object.freeze({
  ok: true, player: globalThis.VAN_TV_CONFIG.player.playing,
  video: { id: videoId, title: 'A test video' }, position: 45, duration: 180,
  receiver: 'running', senders: 0, pairing: { code: 'private-test-code' },
});

export const defaultLibrary = Object.freeze({
  available: true, freeBytes: 8_000_000_000,
  channels: [{ channel: 'Test channel', videos: [{ id: videoId, title: 'A saved video',
    channel: 'Test channel', duration: 180, bytes: 10485760, savedAt: '2026-10-30T12:00:00Z' }] }],
  downloads: [],
});

export async function startReceiver(t, { respond } = {}) {
  const requests = [];
  const server = createServer(async (request, response) => {
    let text = '';
    for await (const chunk of request) text += chunk;
    const entry = { method: request.method, path: request.url, headers: request.headers,
      body: text ? JSON.parse(text) : null };
    requests.push(entry);
    if (respond && await respond(entry, response)) return;
    const body = request.url === '/api/status' ? defaultStatus
      : request.url === '/api/library' ? defaultLibrary
      : request.url === '/api/cast' ? entry.body : { action: entry.body.action, done: true };
    response.writeHead(request.url === '/api/cast' ? 202 : 200, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify(body));
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  return { url: `http://127.0.0.1:${server.address().port}`, requests };
}
