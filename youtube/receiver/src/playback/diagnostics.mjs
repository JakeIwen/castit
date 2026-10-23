export const DiagnosticReason = Object.freeze({ bandwidth: 'bandwidth', rendering: 'rendering', unknown: 'unknown' });

/**
 * Measurements describe the current video; rates are bytes/second and drop
 * counts are increases over the recent sample window, not lifetime totals.
 * A reason is a suspected explanation, never proof of a network or CPU fault.
 * @typedef {{available: boolean, buffering: boolean,
 * reason: 'bandwidth'|'rendering'|'unknown'|null, bufferSeconds: number|null,
 * inputBytesPerSecond: number|null, requiredBytesPerSecond: number|null,
 * frameDrops: number|null, decoderDrops: number|null}} PlaybackDiagnostics
 */

const WINDOW_MS = 10_000;
const MIN_RATE_SAMPLES = 3;
const MIN_RATE_SPAN_MS = 4000;
const LOW_BUFFER_SECONDS = 1.5;
const INSUFFICIENT_RATE_RATIO = 0.8;
const WARNING_DROP_COUNT = 3;

const nonnegative = value => Number.isFinite(value) && value >= 0 ? value : null;
const mean = values => values.reduce((sum, value) => sum + value, 0) / values.length;

/** @returns {PlaybackDiagnostics} */
export function unavailableDiagnostics() {
  return { available: false, buffering: false, reason: null, bufferSeconds: null,
    inputBytesPerSecond: null, requiredBytesPerSecond: null, frameDrops: null, decoderDrops: null };
}

function normalizeSample(sample, at) {
  const video = nonnegative(sample.videoBitrate);
  const audio = nonnegative(sample.audioBitrate);
  const speed = Number.isFinite(sample.speed) && sample.speed > 0 ? sample.speed : 1;
  // Both track rates must be known: a missing video rate must not make audio
  // alone look like the total demand and falsely clear a bandwidth suspicion.
  const required = video !== null && audio !== null ? (video + audio) * speed / 8 : null;
  return { at, available: typeof sample.buffering === 'boolean' && typeof sample.paused === 'boolean',
    paused: sample.paused === true, buffering: sample.buffering === true,
    position: nonnegative(sample.position), speed,
    bufferSeconds: nonnegative(sample.cache?.['cache-duration']),
    inputBytesPerSecond: nonnegative(sample.cache?.['raw-input-rate']),
    requiredBytesPerSecond: required,
    frameDrops: nonnegative(sample.totalFrameDrops), decoderDrops: nonnegative(sample.totalDecoderDrops) };
}

function discontinuity(previous, current) {
  if (!previous) return false;
  const elapsed = (current.at - previous.at) / 1000;
  if (elapsed <= 0 || elapsed > WINDOW_MS / 1000 || previous.paused !== current.paused) return true;
  if (previous.position === null || current.position === null) return false;
  const advanced = current.position - previous.position;
  return advanced < -0.5 || advanced > elapsed * current.speed + 3;
}

function recentDrops(samples, name) {
  const values = samples.map(sample => sample[name]);
  if (values.some(value => value === null)) return null;
  // A decoder/output reset makes the old baseline incomparable.
  for (let index = 1; index < values.length; index++) {
    if (values[index] < values[index - 1]) return null;
  }
  return values.at(-1) - values[0];
}

function suspectedBandwidth(samples, current) {
  if (current.bufferSeconds === null || current.bufferSeconds > LOW_BUFFER_SECONDS) return false;
  const recent = samples.slice(-MIN_RATE_SAMPLES);
  return recent.length === MIN_RATE_SAMPLES
    && current.at - recent[0].at >= MIN_RATE_SPAN_MS
    && recent.every(sample => !sample.paused && sample.inputBytesPerSecond !== null
      && sample.requiredBytesPerSecond > 0
      && sample.inputBytesPerSecond < sample.requiredBytesPerSecond * INSUFFICIENT_RATE_RATIO);
}

export class DiagnosticsHistory {
  constructor() { this.reset(); }

  reset() {
    this.samples = [];
    this.value = unavailableDiagnostics();
  }

  /** Accept one completed mpv sample; timestamps are monotonic milliseconds. */
  record(sample, at) {
    const current = normalizeSample(sample, at);
    if (!current.available) { this.reset(); return this.snapshot(); }
    if (discontinuity(this.samples.at(-1), current)) this.samples = [];
    this.samples = this.samples.filter(item => current.at - item.at <= WINDOW_MS);
    this.samples.push(current);
    const active = !current.paused;
    const buffering = active && current.buffering;
    const frameDrops = recentDrops(this.samples, 'frameDrops');
    const decoderDrops = recentDrops(this.samples, 'decoderDrops');
    let reason = null;
    if (buffering) reason = suspectedBandwidth(this.samples, current)
      ? DiagnosticReason.bandwidth : DiagnosticReason.unknown;
    else if (active && !this.samples.some(item => item.buffering)
      && (frameDrops >= WARNING_DROP_COUNT || decoderDrops >= WARNING_DROP_COUNT)) {
      reason = DiagnosticReason.rendering;
    }
    const rates = this.samples.filter(item => item.inputBytesPerSecond !== null);
    this.value = { available: true, buffering, reason, bufferSeconds: current.bufferSeconds,
      inputBytesPerSecond: current.inputBytesPerSecond === null ? null
        : mean(rates.map(item => item.inputBytesPerSecond)),
      requiredBytesPerSecond: current.requiredBytesPerSecond,
      frameDrops: active ? frameDrops : 0, decoderDrops: active ? decoderDrops : 0 };
    return this.snapshot();
  }

  /** @returns {PlaybackDiagnostics} */
  snapshot() { return { ...this.value }; }
}
