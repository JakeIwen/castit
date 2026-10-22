import { lstat, access } from 'node:fs/promises';
import { constants } from 'node:fs';
import { join } from 'node:path';
import { config, playback } from '../config/receiver-config.mjs';
import { runCommandOutput } from '../host/process-command.mjs';
import { isVideoId } from '../youtube/video-id.mjs';

export const HistoryFailure = Object.freeze({
  SIGNED_OUT: 'signed-out', REJECTED_FILE: 'rejected-file', ERROR: 'error',
});
export const HISTORY_TIMEOUT_MS = 120_000;
const OUTPUT_LIMIT = 64 * 1024;
const IONICE = '/usr/bin/ionice';

// Never follow a symlink, accept another user's jar, or loosen its permissions.
export async function inspectCookieFile(file, uid = process.getuid()) {
  try {
    const info = await lstat(file);
    if (!info.isFile() || info.uid !== uid || (info.mode & 0o7777) !== 0o600) {
      return { enabled: false, reason: HistoryFailure.REJECTED_FILE, version: null };
    }
    return { enabled: true, reason: null,
      version: [info.dev, info.ino, info.size, info.mtimeMs, info.ctimeMs].join(':') };
  } catch (error) {
    return { enabled: false, reason: error.code === 'ENOENT' ? null : HistoryFailure.ERROR, version: null };
  }
}

export function historyCommand({ videoId, cookieFile, ytdlp = playback.ytdlp,
  ytdlpOptions = playback.ytdlpOptions, ionice = false }) {
  if (!isVideoId(videoId)) throw new TypeError('Invalid watch-history video');
  const runtime = ytdlpOptions.split(',').find(option => option.startsWith('js-runtimes='))
    ?.slice('js-runtimes='.length);
  if (!runtime) throw new TypeError('Watch history requires the playback JS runtime');
  return ['/usr/bin/nice', '-n', '19', ...(ionice ? [IONICE, '-c3'] : []),
    ytdlp, '--ignore-config', '--no-cache-dir', '--cookies', cookieFile,
    '--mark-watched', '--simulate', '--no-playlist', '--js-runtimes', runtime,
    '--', `https://www.youtube.com/watch?v=${videoId}`];
}

// yt-dlp can exit successfully after warning that account cookies are invalid.
export function classifyHistoryResult({ code, stdout = '', stderr = '' }) {
  const output = `${stdout}\n${stderr}`;
  if (/cookies?[^\n]{0,160}(?:no longer valid|expired|invalid|rotated)|(?:invalid|expired)[^\n]{0,80}cookies?|sign[ -]?in|not logged in|login required|authentication required/i.test(output)) {
    return HistoryFailure.SIGNED_OUT;
  }
  return code === 0 ? null : HistoryFailure.ERROR;
}

export class YtdlpHistory {
  constructor({ stateDirectory = config.stateDirectory, run = runCommandOutput,
    ytdlp = playback.ytdlp, ytdlpOptions = playback.ytdlpOptions,
    hasIonice = async () => access(IONICE, constants.X_OK).then(() => true, () => false) } = {}) {
    Object.assign(this, { run, ytdlp, ytdlpOptions, hasIonice });
    this.cookieFile = join(stateDirectory, 'youtube-cookies.txt');
  }

  inspect() { return inspectCookieFile(this.cookieFile); }

  async mark(videoId, { signal } = {}) {
    const file = await this.inspect();
    if (!file.enabled) return file;
    let reason;
    try {
      const argv = historyCommand({ videoId, cookieFile: this.cookieFile,
        ytdlp: this.ytdlp, ytdlpOptions: this.ytdlpOptions, ionice: await this.hasIonice() });
      const result = await this.run(argv, { signal, timeoutMs: HISTORY_TIMEOUT_MS, maxBytes: OUTPUT_LIMIT });
      reason = classifyHistoryResult(result);
    } catch {
      // Neither subprocess errors nor captured output may reach logs or status.
      reason = HistoryFailure.ERROR;
    }
    // yt-dlp may save its jar on exit; that isn't a user-supplied replacement.
    const after = await this.inspect();
    return after.enabled ? { ...after, reason } : after;
  }
}
