export const LOAD_PHASES = Object.freeze({ RESOLVE: 'resolve', START: 'start', BUFFER: 'buffer' });

const HISTORY_LIMIT = 10;
const seconds = milliseconds => Math.round(milliseconds / 100) / 10;

export class LoadProgress {
  constructor({ now = () => performance.now() } = {}) {
    this.now = now;
    this.current = null;
    this.successful = [];
  }

  start(signal, started = this.now()) {
    const load = { phase: LOAD_PHASES.RESOLVE, started };
    this.current = load;
    const cancel = () => { if (this.current === load) this.current = null; };
    signal.addEventListener('abort', cancel, { once: true });
    if (signal.aborted) cancel();
    const phase = value => { if (this.current === load) load.phase = value; };
    return {
      resolved: () => phase(LOAD_PHASES.START),
      buffering: () => phase(LOAD_PHASES.BUFFER),
      finish: successful => {
        signal.removeEventListener('abort', cancel);
        if (this.current !== load) return;
        if (successful && !signal.aborted) {
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
