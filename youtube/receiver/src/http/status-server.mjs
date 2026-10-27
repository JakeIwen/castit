import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { qualityArguments } from '../playback/quality.mjs';
import { subtitleArguments } from '../playback/subtitles.mjs';
import { config } from '../config/receiver-config.mjs';
import { isVideoId } from '../youtube/video-id.mjs';
import { findYouTubeVideo } from '../youtube/video-url.mjs';
import { CONTROL_ACTIONS, QUEUE_ACTIONS, seekArguments, audioDelayArguments, speedArguments,
  volumeArguments, muteArguments, queueArguments } from '../controls/player-controls.mjs';

const MAX_POST_BODY = 4096;
const LINK_PREVIEW_LENGTH = 60;
// Web pages can't forge these origins, and a JSON body already forces a CORS
// preflight this server never answers; the status page itself is same-origin.
const EXTENSION_ORIGINS = ['moz-extension://', 'chrome-extension://'];
const POST_ROUTES = ['/api/pairing', '/api/control', '/api/cast', '/api/queue'];
const controlArguments = {
  quality: { parse: qualityArguments, error: 'Quality must match a supported option (string)' },
  subtitles: { parse: subtitleArguments, error: 'Subtitles need a boolean enabled and/or a language code' },
  seek: { parse: seekArguments, error: 'Seek needs one of position (>= 0) or offset' },
  audio_delay: { parse: audioDelayArguments, error: 'Audio delay needs exactly one of delay or offset (finite seconds)' },
  speed: { parse: speedArguments, error: 'Speed needs exactly one of speed or offset (finite numbers)' },
  volume: { parse: volumeArguments, error: 'Volume needs exactly one of level or offset (finite numbers)' },
  mute: { parse: muteArguments, error: 'Mute takes an optional boolean muted' },
};

const assets = {
  '/': ['index.html', 'text/html; charset=utf-8'],
  '/status.mjs': ['status.mjs', 'text/javascript; charset=utf-8'],
  '/status.css': ['status.css', 'text/css; charset=utf-8'],
};

export async function createStatusServer({ snapshot, pairing, control = async () => false,
  queue = async () => false,
  cast = async () => { throw new Error('Cast unavailable'); },
  hosts = ['localhost', '127.0.0.1', config.lanAddress, ...config.hostnames] }) {
  const content = new Map(await Promise.all(Object.entries(assets).map(async ([path, [file, type]]) =>
    [path, { type, body: await readFile(new URL(`../../web/${file}`, import.meta.url)) }])));
  return createServer((request, response) => {
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Content-Security-Policy', "default-src 'self'; frame-ancestors 'none'; base-uri 'none'");
    const json = (code, body) => {
      response.writeHead(code, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify(body));
    };
    let url;
    try { url = new URL(request.url, `http://${request.headers.host}`); }
    catch { json(400, { error: 'Invalid request' }); return; }
    if (!hosts.includes(url.hostname)) { json(403, { error: 'Untrusted host' }); return; }
    if (request.method === 'GET' && url.pathname === '/health') {
      const state = snapshot();
      json(state.ok ? 200 : 503, state);
    } else if (request.method === 'GET' && url.pathname === '/api/status') {
      json(200, { ...snapshot(), pairing: pairing.snapshot() });
    } else if (request.method === 'POST' && POST_ROUTES.includes(url.pathname)) {
      if (!trustedOrigin(request.headers.origin, url.origin) || request.headers['content-type'] !== 'application/json') {
        json(403, { error: 'Trusted-origin JSON required' }); return;
      }
      if (url.pathname === '/api/pairing') {
        request.resume();
        json(202, { requested: pairing.refresh() });
      } else {
        const handler = { '/api/cast': handleCast, '/api/queue': handleQueue }[url.pathname] ?? handleControl;
        void handler(request, { control, cast, queue }).then(([code, body]) => json(code, body));
      }
    } else if (request.method === 'GET' && content.has(url.pathname)) {
      const asset = content.get(url.pathname);
      response.writeHead(200, { 'Content-Type': asset.type });
      response.end(asset.body);
    } else json(404, { error: 'Not found' });
  });
}

function trustedOrigin(origin, own) {
  if (origin === undefined || origin === 'null' || origin === own) return true;
  return EXTENSION_ORIGINS.some(scheme => origin.startsWith(scheme));
}

async function readJsonBody(request) {
  let body = '';
  let bytes = 0;
  for await (const chunk of request) {
    bytes += chunk.length;
    if (bytes > MAX_POST_BODY) throw new RangeError('Request too large');
    body += chunk;
  }
  const parsed = JSON.parse(body);
  if (!parsed || typeof parsed !== 'object') throw new TypeError('Object required');
  return parsed;
}

async function handleControl(request, { control }) {
  try {
    const body = await readJsonBody(request);
    const { action } = body;
    if (!CONTROL_ACTIONS.includes(action)) return [400, { error: 'Unknown action' }];
    const argumentsSpec = controlArguments[action];
    const fields = argumentsSpec ? argumentsSpec.parse(body) : {};
    if (!fields) return [400, { error: argumentsSpec.error }];
    return [200, { action, done: Boolean(await control(action, fields)) }];
  } catch (error) {
    return error instanceof RangeError ? [413, { error: error.message }] : [400, { error: 'Invalid control request' }];
  }
}

function invalidLinkError(value) {
  const text = (typeof value === 'string' ? value : JSON.stringify(value) ?? '').trim();
  const characters = Array.from(text);
  const preview = characters.slice(0, LINK_PREVIEW_LENGTH).join('')
    + (characters.length > LINK_PREVIEW_LENGTH ? '…' : '');
  return `Not a YouTube video link: "${preview}"`;
}

async function handleQueue(request, { queue }) {
  try {
    const body = await readJsonBody(request);
    const { action } = body;
    if (!QUEUE_ACTIONS.includes(action)) return [400, { error: 'Unknown queue action' }];
    const fields = queueArguments(body);
    if (!fields) {
      if (action === 'add' && body.url !== undefined && body.videoId === undefined) {
        return [400, { error: invalidLinkError(body.url) }];
      }
      return [400, { error: 'Queue add needs exactly one of videoId or url; remove, play and move need an integer key; move needs a non-negative safe integer index' }];
    }
    return [200, { action, done: Boolean(await queue(action, fields)) }];
  } catch (error) {
    return error instanceof RangeError ? [413, { error: error.message }] : [400, { error: 'Invalid queue request' }];
  }
}

// Casting is accepted, not awaited: a load can take tens of seconds and the
// sender watches /api/status for the outcome.
async function handleCast(request, { cast }) {
  let body;
  try { body = await readJsonBody(request); } catch (error) {
    return error instanceof RangeError ? [413, { error: error.message }] : [400, { error: 'Invalid cast request' }];
  }
  if ((body.videoId !== undefined) === (body.url !== undefined)) {
    return [400, { error: 'Cast needs exactly one of videoId or url' }];
  }
  const selection = body.url === undefined ? null : findYouTubeVideo(body.url);
  if (body.url !== undefined && !selection) return [400, { error: invalidLinkError(body.url) }];
  const videoId = selection?.videoId ?? body.videoId;
  const position = body.position === undefined ? selection?.position ?? 0 : Number(body.position);
  if (!isVideoId(videoId)) return [400, { error: 'Invalid videoId' }];
  if (!Number.isFinite(position) || position < 0) return [400, { error: 'Invalid position' }];
  try {
    await cast(videoId, position);
    return [202, { videoId, position }];
  } catch { return [503, { error: 'Van TV is not ready to cast' }]; }
}

export async function listenStatus(options, { addresses = ['127.0.0.1', config.lanAddress],
  port = config.statusPort } = {}) {
  const servers = [];
  try {
    for (const host of new Set(addresses)) {
      const server = await createStatusServer(options);
      servers.push(server);
      await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, host, resolve);
      });
    }
    return () => Promise.all(servers.map(server => new Promise(resolve => {
      server.close(resolve);
      server.closeIdleConnections();
    })));
  } catch (error) {
    for (const server of servers) server.close();
    throw error;
  }
}
