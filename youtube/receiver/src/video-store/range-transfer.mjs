import { open } from 'node:fs/promises';
import { STORE_LIMITS, VideoStoreError } from './contracts.mjs';
import { missingRanges, mergeRanges } from './ranges.mjs';

// Playback and Download share one per-format queue, so overlapping requests can
// never fetch the same missing bytes concurrently or publish conflicting maps.
export class RangeTransfer {
  constructor(entries, resolver, { fetcher = globalThis.fetch } = {}) {
    Object.assign(this, { entries, resolver, fetcher });
    this.queues = new Map();
  }

  async ensure(session, track, start, end, signal) {
    for (let cursor = start; cursor < end; cursor += STORE_LIMITS.readBytes) {
      // Yield the per-format queue between pieces so a background Download
      // cannot hold a seek behind the remainder of a multi-gigabyte video.
      await this.ensurePiece(session, track, cursor, Math.min(end, cursor + STORE_LIMITS.readBytes), signal);
    }
  }

  async ensurePiece(session, track, start, end, signal) {
    const key = `${session.entry.id}:${track.formatId}`;
    const previous = this.queues.get(key) ?? Promise.resolve();
    let started = false;
    const operation = previous.catch(() => {}).then(async () => {
      started = true;
      signal?.throwIfAborted();
      for (const [left, right] of missingRanges(track.ranges, start, end)) {
        for (let cursor = left; cursor < right; cursor += STORE_LIMITS.chunkBytes) {
          await this.fetchChunk(session, track, cursor, Math.min(right, cursor + STORE_LIMITS.chunkBytes), signal);
        }
      }
    });
    this.queues.set(key, operation);
    const finish = () => { if (this.queues.get(key) === operation) this.queues.delete(key); };
    void operation.then(finish, finish);
    await cancellableWait(operation, signal, () => started);
  }

  async refresh(session, track, signal) {
    const stream = await this.resolver.resolve(session.entry.id, { quality: session.quality, signal, fresh: true });
    const replacement = stream?.tracks?.find(item => item.formatId === track.formatId);
    if (!replacement || (track.size && replacement.size && track.size !== replacement.size)) {
      throw new VideoStoreError('The selected video format changed; start a new playback');
    }
    session.stream = stream;
    return replacement;
  }

  async upstream(session, track, start, end, signal) {
    let source = session.stream.tracks.find(item => item.formatId === track.formatId);
    if (!source) throw new VideoStoreError('Video format is unavailable');
    for (let attempt = 0; attempt < 2; attempt++) {
      const response = await this.fetcher(source.url, { signal,
        headers: { ...source.headers, Range: `bytes=${start}-${end - 1}`, 'Accept-Encoding': 'identity' } });
      if (![403, 410].includes(response.status) || attempt) return response;
      await response.body?.cancel();
      source = await this.refresh(session, track, signal);
    }
  }

  async fetchChunk(session, track, start, end, signal) {
    const disk = this.entries.disk;
    await disk.require(true, end - start);
    const deadline = AbortSignal.timeout(STORE_LIMITS.upstreamTimeoutMs);
    const fetchSignal = signal ? AbortSignal.any([signal, deadline]) : deadline;
    const response = await this.upstream(session, track, start, end, fetchSignal);
    let range;
    try { range = upstreamRange(response, start, end, track.size); }
    catch (error) { await response.body?.cancel(); throw error; }
    track.size = range.size;
    let file;
    try {
      const path = await disk.safe(disk.trackPath(session.entry, track.formatId));
      const created = await open(path, 'a+');
      await created.close();
      // O_APPEND ignores explicit offsets on Linux, so sparse writes use r+.
      file = await open(path, 'r+');
    } catch (error) { await response.body?.cancel(); throw error; }
    let position = start;
    try {
      for await (const value of response.body) {
        fetchSignal.throwIfAborted();
        if (position + value.length > range.end) throw new Error('Upstream exceeded requested range');
        await disk.require(true, value.length);
        let written = 0;
        while (written < value.length) {
          const result = await file.write(value, written, value.length - written, position);
          if (!result.bytesWritten) throw new Error('Cache write failed');
          written += result.bytesWritten;
          position += result.bytesWritten;
        }
      }
      if (position !== range.end) throw new Error('Upstream ended before the requested range');
    } finally {
      try { await file.sync(); } finally { await file.close(); }
      if (position > start) {
        track.ranges = mergeRanges(track.ranges, start, position);
        session.entry.touchedAt = this.entries.now();
        await this.entries.save(session.entry);
        session.onProgress?.();
      }
    }
  }

  async size(session, track, signal) {
    if (track.size === null) await this.ensure(session, track, 0, 1, signal);
    return track.size;
  }
}

// Cancelling a waiting playback request must not wait for, or cancel, an
// independent Download that owns the current chunk. The queue still drains in order.
async function cancellableWait(operation, signal, started) {
  if (!signal) return operation;
  let cancel;
  const aborted = new Promise((_, reject) => {
    cancel = () => { if (!started()) reject(signal.reason); };
    signal.addEventListener('abort', cancel, { once: true });
  });
  try {
    if (signal.aborted) cancel();
    await Promise.race([operation, aborted]);
  } finally { signal.removeEventListener('abort', cancel); }
}

function upstreamRange(response, start, end, knownSize) {
  const match = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(response.headers.get('content-range') ?? '');
  if (response.status === 206 && match) {
    const [left, right, size] = match.slice(1).map(Number);
    if ([left, right, size].every(Number.isSafeInteger) && left === start && right + 1 === Math.min(end, size)
      && size > start && (!knownSize || knownSize === size)) return { end: right + 1, size };
  }
  // A small progressive resource may ignore Range; accepting it only when the
  // entire body fits this exact request keeps downloads bounded and nonduplicating.
  const size = Number(response.headers.get('content-length'));
  if (response.status === 200 && start === 0 && Number.isSafeInteger(size) && size > 0 && size <= end
    && (!knownSize || size === knownSize)) return { end: size, size };
  throw new VideoStoreError('Video server did not provide a valid byte range');
}
