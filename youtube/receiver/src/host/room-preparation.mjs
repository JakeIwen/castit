import { config } from '../config/receiver-config.mjs';
import { runCommand } from './process-command.mjs';

export class RoomPreparation {
  constructor({ run = runCommand, log = console, roomCommand = config.roomCommand } = {}) {
    this.run = run;
    this.log = log;
    this.roomCommand = roomCommand;
    this.timer = null;
    this.running = false;
    this.rerun = false;
  }

  async beforeVideo(signal) {
    signal?.throwIfAborted();
    await this.run(config.wakeCommand, { signal }).catch(() => this.log.warn('Screen wake failed'));
    signal?.throwIfAborted();
  }

  afterPlayback() {
    this.cancelPending();
    if (this.roomCommand === null) return;
    // Optical audio can undo speaker grouping, so repair only after it starts.
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.checkRoom();
    }, config.roomCheckDelayMs);
    this.timer.unref?.();
  }

  async checkRoom() {
    if (this.running) { this.rerun = true; return; }
    this.running = true;
    try { await this.run(this.roomCommand, { timeoutMs: config.roomTimeoutMs }); }
    catch { this.log.warn('Room check failed; continuing playback'); }
    finally {
      this.running = false;
      if (this.rerun) {
        this.rerun = false;
        void this.checkRoom();
      }
    }
  }

  cancelPending() {
    clearTimeout(this.timer);
    this.timer = null;
    this.rerun = false;
  }

  endSession() { this.cancelPending(); }
}
