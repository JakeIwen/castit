/** @typedef {import('../../receiver/src/playback/diagnostics.mjs').PlaybackDiagnostics} PlaybackDiagnostics */

export const diagnosticReason = Object.freeze({
  bandwidth: 'bandwidth', rendering: 'rendering', unknown: 'unknown',
});
const reasons = Object.values(diagnosticReason);
const metrics = Object.freeze([
  'bufferSeconds', 'inputBytesPerSecond', 'requiredBytesPerSecond', 'frameDrops', 'decoderDrops',
]);

/** Validate the receiver boundary; unavailable measurements remain null. */
export function decodeDiagnostics(value) {
  if (!value || typeof value.available !== 'boolean' || typeof value.buffering !== 'boolean'
      || (value.reason !== null && !reasons.includes(value.reason))) return null;
  const numberOrNull = field => value[field] === null
    || typeof value[field] === 'number' && Number.isFinite(value[field]) && value[field] >= 0;
  if (!metrics.every(numberOrNull)) return null;
  return { available: value.available, buffering: value.buffering, reason: value.reason,
    ...Object.fromEntries(metrics.map(field => [field, value[field]])) };
}
