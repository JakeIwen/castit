import { EventEmitter } from 'node:events';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { config, playback, mpvArguments, watchUrl } from '../../config/receiver-config.mjs';
import { MpvIpc } from './ipc.mjs';
import { signalGroup } from '../../host/process-command.mjs';

export class MpvProcess extends EventEmitter {
  constructor({ spawnProcess = spawn, runtimeDirectory = config.runtimeDirectory } = {}) {
    super();
    Object.assign(this, { spawnProcess, runtimeDirectory });
  }

  async start(signal) {
    signal?.throwIfAborted();
    this.directory = await mkdtemp(join(this.runtimeDirectory, 'mpv-'));
    if (this.closing || signal?.aborted) {
      await rm(this.directory, { recursive: true, force: true });
      throw new Error('Playback cancelled');
    }
    const socket = join(this.directory, 'ipc');
    this.child = this.spawnProcess(playback.mpv, mpvArguments(socket), {
      detached: true, stdio: 'ignore',
      env: { ...process.env, ...config.sessionEnvironment },
    });
    this.child.once('error', error => { this.failure = error; });
    this.exit = new Promise(resolve => {
      this.child.once('exit', resolve);
      this.child.once('error', resolve);
    });
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      signal?.throwIfAborted();
      if (this.closing || this.failure || this.child.exitCode !== null) throw new Error('mpv failed to start');
      const ipc = new MpvIpc(socket);
      try {
        await ipc.connect();
        this.ipc = ipc;
        ipc.on('event', message => this.emit('event', message));
        ipc.on('disconnect', () => { if (!this.closing) this.emit('disconnect'); });
        return;
      } catch {
        ipc.close();
        await delay(50, undefined, { signal });
      }
    }
    throw new Error('mpv IPC startup timeout');
  }

  command(argv, options) { return this.ipc.command(argv, options); }

  async load(videoId, position, signal, stream = null) {
    signal?.throwIfAborted();
    const loaded = this.waitForLoad(signal);
    // Attach rejection handling before sending: an IPC failure can beat the ACK.
    loaded.catch(() => {});
    try {
      // mpv 0.35 accepts a node map as loadfile's third argument. Append treats
      // audio URLs literally, unlike audio-files' colon-separated path list.
      const options = { start: String(position) };
      if (stream) {
        Object.assign(options, stream.httpOptions, { ytdl: 'no' });
        if (stream.title) options['force-media-title'] = stream.title;
        if (stream.audioUrl) options['audio-files-append'] = stream.audioUrl;
      }
      await this.command(['loadfile', stream?.videoUrl || watchUrl(videoId), 'replace', options]);
      await loaded;
    } catch (error) {
      await this.close();
      throw error;
    }
  }

  waitForLoad(signal) {
    return new Promise((resolve, reject) => {
      const finish = error => {
        clearTimeout(timer);
        this.removeListener('event', event);
        this.removeListener('disconnect', disconnect);
        signal?.removeEventListener('abort', cancel);
        if (error) reject(error); else resolve();
      };
      const event = message => {
        if (message.event === 'file-loaded') finish();
        else if (message.event === 'end-file' && message.reason === 'error') finish(new Error('mpv could not load video'));
      };
      const disconnect = () => finish(new Error('mpv disconnected during load'));
      const cancel = () => finish(new Error('Playback cancelled'));
      const timer = setTimeout(() => finish(new Error('Video load timeout')), config.loadTimeoutMs);
      this.on('event', event);
      this.on('disconnect', disconnect);
      signal?.addEventListener('abort', cancel, { once: true });
      if (signal?.aborted) cancel();
    });
  }

  close() {
    this.closing = true;
    return this.closePromise ||= this.closeProcess();
  }

  async closeProcess() {
    if (this.child) {
      await Promise.race([
        this.ipc?.command(['quit']).catch(() => {}), delay(playback.mpvStopGraceMs),
      ]);
      // The IPC socket can close before the OS reaps a graceful quit. Give it
      // that bounded grace before signalling (macOS rejects the exiting group).
      await Promise.race([this.exit, delay(playback.mpvStopGraceMs)]);
      if (this.child.exitCode === null && this.child.signalCode === null && !this.failure) {
        signalGroup(this.child.pid, 'SIGTERM');
        await Promise.race([this.exit, delay(playback.mpvStopGraceMs)]);
      }
      signalGroup(this.child.pid, 'SIGKILL');
      await this.exit;
    }
    this.emit('disconnect');
    this.ipc?.close();
    if (this.directory) await rm(this.directory, { recursive: true, force: true });
  }
}
