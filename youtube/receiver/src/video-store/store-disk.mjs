import { stat, statfs, realpath, mkdir, open, readFile, rename, rm, readdir } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { STORE_LIMITS, VideoStoreError } from './contracts.mjs';

// The configured root is directly below a mountpoint. Checking its parent before
// mkdir prevents a missing removable disk from silently filling the system disk.
export class StoreDisk {
  constructor(root, { statPath = stat, diskSpace = statfs, canonical = realpath } = {}) {
    Object.assign(this, { root, statPath, diskSpace, canonical });
    this.mount = root ? dirname(root) : null;
  }

  async inspect() {
    if (!this.root) return { available: false, freeBytes: null };
    try {
      const [mount, parent, canonical] = await Promise.all([
        this.statPath(this.mount), this.statPath(dirname(this.mount)), this.canonical(this.mount),
      ]);
      if (!mount.isDirectory() || mount.dev === parent.dev || canonical !== this.mount) {
        return { available: false, freeBytes: null };
      }
      const space = await this.diskSpace(this.mount);
      return { available: true, freeBytes: Number(space.bavail) * Number(space.bsize) };
    } catch { return { available: false, freeBytes: null }; }
  }

  async require(writing = false, reserve = 0) {
    const state = await this.inspect();
    if (!state.available) throw new VideoStoreError('Video drive is not mounted', 503);
    if (writing && state.freeBytes < STORE_LIMITS.freeBytes + reserve) {
      throw new VideoStoreError('Video drive needs at least 2 GiB free');
    }
    return state;
  }

  // Reject symlinked directories as well as traversal from an edited sidecar.
  async safe(path) {
    const absolute = resolve(path);
    if (absolute !== this.root && !absolute.startsWith(`${this.root}/`)) throw new Error('Invalid store path');
    let existing = absolute;
    while (existing !== this.mount) {
      try {
        if (await this.canonical(existing) !== existing) throw new Error('Symlink in video store');
        return absolute;
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
        existing = dirname(existing);
      }
    }
    return absolute;
  }

  async directory(path) {
    await this.require(true);
    await this.safe(path);
    await mkdir(path, { recursive: true });
  }

  async json(path, value) {
    await this.require(true);
    await this.safe(path);
    const temporary = `${path}.tmp`;
    await this.safe(temporary);
    const file = await open(temporary, 'w');
    try { await file.writeFile(JSON.stringify(value)); await file.sync(); }
    finally { await file.close(); }
    await rename(temporary, path);
  }

  async readJson(path) {
    await this.require();
    await this.safe(path);
    return JSON.parse(await readFile(path, 'utf8'));
  }

  async list(path) {
    await this.require();
    await this.safe(path);
    try { return await readdir(path, { withFileTypes: true }); }
    catch (error) { if (error.code === 'ENOENT') return []; throw error; }
  }

  async remove(path) {
    await this.require();
    await this.safe(path);
    await rm(path, { recursive: true, force: true });
  }

  cachePath(id) { return join(this.root, '.cache', id); }
  trackPath(entry, formatId) { return join(this.cachePath(entry.id), `${formatId}.bin`); }
}
