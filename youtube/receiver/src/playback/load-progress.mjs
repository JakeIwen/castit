export const LOAD_PHASES = Object.freeze({ RESOLVE: 'resolve', START: 'start', BUFFER: 'buffer' });

const HISTORY_LIMIT = 10;
const seconds = milliseconds => Math.round(milliseconds / 100) / 10;

export class LoadProgress {
  constructor({ now = () => performance.now() } = {}) {
    this.now = now;
    this.current = null;
    this.successful = [];
  }

  cancel() { this.current = null; }

  async track(operation) {
    const load = this.start();
    let successful = false;
    try { successful = await operation(load); return successful; }
    finally { load.finish(successful); }
  }

  start() {
    const load = { phase: LOAD_PHASES.RESOLVE, started: this.now() };
    this.current = load;
    const phase = value => { if (this.current === load) load.phase = value; };
    return {
      resolved: () => phase(LOAD_PHASES.START),
      buffering: () => phase(LOAD_PHASES.BUFFER),
      finish: successful => {
        if (this.current !== load) return;
        if (successful) {
          this.successful.push(this.now() - load.started);
          this.successful = this.successful.slice(-HISTORY_LIMIT);
        }
        this.current = null;
      },
    };
  }

  snapshot() {
    if (!this.current) return null;
    const times = this.successful.toSorted((a, b) => a - b);
    const middle = Math.floor(times.length / 2);
    const median = times.length % 2 ? times[middle] : (times[middle - 1] + times[middle]) / 2;
    return { phase: this.current.phase, elapsed: seconds(this.now() - this.current.started),
      expected: times.length ? median / 1000 : null };
  }
}
