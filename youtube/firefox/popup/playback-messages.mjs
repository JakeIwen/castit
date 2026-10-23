import { diagnosticReason } from '../playback/diagnostics.mjs';
import { setAttribute, setClass, setProperty, setText } from './dom-state.mjs';

const explanations = Object.freeze({
  [diagnosticReason.bandwidth]: 'Buffering — incoming data appears too slow for this video.',
  [diagnosticReason.rendering]: 'Frames are being dropped — decoding or rendering may be falling behind.',
  [diagnosticReason.unknown]: 'Buffering — cause not yet determined.',
});
const bandwidth = bytes => `${(bytes * 8 / 1_000_000).toFixed(2)} Mbps`;

export function playbackMessageModel(status) {
  if (!status) return { warning: status === null, text: status === null
    ? 'Van TV is unreachable.' : 'Connecting to Van TV…', measurements: '' };
  if (!status.ok) return { warning: true, text: 'The receiver is not running.', measurements: '' };
  const diagnostics = status.diagnostics;
  if (!diagnostics) return { warning: true,
    text: 'Playback diagnostics need a receiver update.', measurements: '' };
  if (!diagnostics.available) return { warning: false,
    text: status.video ? 'Waiting for playback measurements.' : 'No active playback.', measurements: '' };
  const reason = diagnostics.buffering
    ? (diagnostics.reason === diagnosticReason.bandwidth ? diagnosticReason.bandwidth : diagnosticReason.unknown)
    : diagnostics.reason === diagnosticReason.rendering ? diagnosticReason.rendering : null;
  const measurements = [];
  if (diagnostics.bufferSeconds !== null) measurements.push(`Buffer: ${diagnostics.bufferSeconds.toFixed(1)} s`);
  if (diagnostics.inputBytesPerSecond !== null) measurements.push(`Receiving: ${bandwidth(diagnostics.inputBytesPerSecond)}`);
  if (diagnostics.requiredBytesPerSecond !== null) measurements.push(`Needed: about ${bandwidth(diagnostics.requiredBytesPerSecond)}`);
  if (reason === diagnosticReason.rendering) {
    if (diagnostics.frameDrops !== null) measurements.push(`Recent output drops: ${diagnostics.frameDrops}`);
    if (diagnostics.decoderDrops !== null) measurements.push(`Recent decoder drops: ${diagnostics.decoderDrops}`);
  }
  return { warning: Boolean(reason), text: explanations[reason] ?? 'No active playback warnings.',
    measurements: measurements.join(' · ') };
}

export class PlaybackMessages {
  constructor({ before, notice, historyNotice }) {
    const document = before.ownerDocument;
    Object.assign(this, { notice, historyNotice, noticeWarning: false });
    this.details = document.createElement('details');
    this.details.className = 'playback-messages';
    const summary = document.createElement('summary');
    this.symbol = document.createElement('span');
    this.symbol.setAttribute('aria-hidden', 'true');
    this.label = document.createElement('span');
    summary.append(this.symbol, this.label);
    const content = document.createElement('div');
    content.className = 'playback-messages-content';
    this.explanation = document.createElement('p');
    this.measurements = document.createElement('p');
    this.measurements.className = 'playback-measurements';
    this.quality = document.createElement('p');
    content.append(this.explanation, this.measurements, this.quality, notice, historyNotice);
    this.details.append(summary, content);
    before.before(this.details);
    this.render(undefined);
  }

  setNotice(text, warning = false) {
    this.noticeWarning = warning && Boolean(text);
    setText(this.notice, text);
    this.render(this.status);
  }

  render(status) {
    this.status = status;
    const view = playbackMessageModel(status);
    const qualityMissing = Boolean(status?.ok && !status.quality);
    const qualityFailed = Boolean(status?.quality?.error);
    const warnings = Number(view.warning) + Number(qualityMissing || qualityFailed)
      + Number(this.noticeWarning) + Number(Boolean(this.historyNotice.textContent));
    setText(this.symbol, warnings ? '⚠' : 'ⓘ');
    setText(this.label, warnings ? `Info · ${warnings} warning${warnings === 1 ? '' : 's'}` : 'Info');
    setClass(this.details, 'has-warning', warnings > 0);
    setAttribute(this.details, 'data-warning', warnings > 0);
    setText(this.explanation, view.text);
    setText(this.measurements, view.measurements);
    setProperty(this.measurements, 'hidden', !view.measurements);
    setText(this.quality, qualityMissing ? 'Quality controls need a receiver update.'
      : qualityFailed ? 'Quality change failed. Use Retry beside Quality.' : '');
    setProperty(this.quality, 'hidden', !this.quality.textContent);
  }
}
