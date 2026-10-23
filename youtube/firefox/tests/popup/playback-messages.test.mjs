import assert from 'node:assert/strict';
import test from 'node:test';
import { decodeStatus } from '../../background/receiver-client.mjs';
import { playbackMessageModel } from '../../popup/playback-messages.mjs';
import { defaultStatus } from '../background/receiver-fixture.mjs';

const measurements = {
  available: true, buffering: false, reason: null, bufferSeconds: 20,
  inputBytesPerSecond: 50_000, requiredBytesPerSecond: 250_000, frameDrops: 0, decoderDrops: 0,
};
const model = diagnostics => playbackMessageModel(decodeStatus({ ...defaultStatus, diagnostics }));

test('the receiver boundary retains only valid diagnostics and omits private extras', () => {
  const result = decodeStatus({ ...defaultStatus, diagnostics: { ...measurements, privateUrl: 'discard' } });
  assert.deepEqual(result.diagnostics, measurements);
  for (const patch of [{ reason: 'guess' }, { buffering: 'yes' }, { bufferSeconds: -1 },
    { inputBytesPerSecond: Infinity }, { requiredBytesPerSecond: '250000' }, { frameDrops: undefined }]) {
    assert.equal(decodeStatus({ ...defaultStatus, diagnostics: { ...measurements, ...patch } }).diagnostics, null);
  }
  assert.equal(decodeStatus(defaultStatus).diagnostics, null);
});

test('low incoming rate with a full buffer alone does not become a bandwidth warning', () => {
  const view = model(measurements);
  assert.equal(view.warning, false);
  assert.match(view.text, /No active/);
  assert.match(view.measurements, /Receiving: 0.40 Mbps/);
  assert.match(view.measurements, /Needed: about 2.00 Mbps/);
});

test('confirmed buffering distinguishes suspected bandwidth from unknown without inventing a cause', () => {
  const bandwidth = model({ ...measurements, buffering: true, bufferSeconds: 0.2, reason: 'bandwidth' });
  assert.equal(bandwidth.warning, true);
  assert.match(bandwidth.text, /appears too slow/);
  const unknown = model({ ...measurements, buffering: true, reason: 'unknown', inputBytesPerSecond: null });
  assert.match(unknown.text, /cause not yet determined/);
  assert.doesNotMatch(unknown.measurements, /Receiving/);
});

test('rendering drops stay separate from buffering and clear with a healthy sample', () => {
  const dropped = model({ ...measurements, reason: 'rendering', frameDrops: 12, decoderDrops: 2 });
  assert.equal(dropped.warning, true);
  assert.match(dropped.text, /decoding or rendering/);
  assert.match(dropped.measurements, /Recent output drops: 12/);
  assert.doesNotMatch(dropped.text, /Buffering/);
  assert.equal(model(measurements).warning, false);
});

test('missing support, unavailable measurements and unreachable receivers have distinct messages', () => {
  assert.match(playbackMessageModel(decodeStatus(defaultStatus)).text, /receiver update/);
  const waiting = model({ ...measurements, available: false });
  assert.equal(waiting.warning, false);
  assert.match(waiting.text, /Waiting/);
  assert.match(playbackMessageModel(null).text, /unreachable/);
  assert.equal(playbackMessageModel(undefined).warning, false);
});
