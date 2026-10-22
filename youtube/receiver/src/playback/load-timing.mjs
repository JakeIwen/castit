const PHASES = ['handoff', 'wake', 'mpv_start', 'resolve', 'load'];

// Durations overlap; total is elapsed time, not the sum of the phases.
export class LoadTiming {
  constructor({ now = () => performance.now() } = {}) {
    this.now = now;
    this.started = now();
    this.durations = Object.fromEntries(PHASES.map(name => [name, 0]));
  }

  async measure(name, operation) {
    const started = this.now();
    try { return await operation(); }
    finally { this.durations[name] = this.now() - started; }
  }

  report(log, outcome) {
    const phases = PHASES.map(name => `${name}=${Math.round(this.durations[name])}ms`);
    log.info?.(`Video load timing ${phases.join(' ')} total=${Math.round(this.now() - this.started)}ms outcome=${outcome}`);
  }
}
