import { config } from '../config/receiver-config.mjs';
import { runCommand } from './process-command.mjs';

export class RoomPreparation {
  constructor({ run = runCommand, log = console, roomCommand = config.roomCommand } = {}) {
    this.run = run;
    this.log = log;
    this.roomCommand = roomCommand;
    this.prepared = false;
    this.pending = null;
  }

  async beforeVideo(signal) {
    signal?.throwIfAborted();
    const wake = this.run(config.wakeCommand, { signal }).catch(() => this.log.warn('Screen wake failed'));
    // A null room command means this install has no audio routing to switch.
    if (this.roomCommand !== null && !this.prepared && !this.pending) {
      this.pending = this.run(this.roomCommand, { timeoutMs: config.roomTimeoutMs, signal })
        .then(() => { this.prepared = true; })
        .catch(() => this.log.warn('Room preparation failed; continuing playback'))
        .finally(() => { this.pending = null; });
    }
    await Promise.all([wake, this.pending]);
    signal?.throwIfAborted();
  }

  endSession() { this.prepared = false; }
}
