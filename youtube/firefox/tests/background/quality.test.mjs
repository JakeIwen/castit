import test from 'node:test';
import assert from 'node:assert/strict';
import { createReceiverClient, decodeStatus } from '../../background/receiver-client.mjs';
import { createMessageHandler } from '../../background/actions.mjs';
import { defaultStatus, startReceiver } from './receiver-fixture.mjs';
import { isWorking } from '../../popup/state.mjs';

const quality = { selected: '720', loading: false, error: false,
  options: [{ value: 'auto', label: 'Auto' }, { value: '720', label: '720p' }] };

test('Quality options come from capabilities; old or malformed receivers disable the selector', () => {
  assert.equal(decodeStatus(defaultStatus).quality, null);
  const result = decodeStatus({ ...defaultStatus, quality: { ...quality, private: 'discard' } }).quality;
  assert.deepEqual(result, quality);
  assert.notStrictEqual(result.options, quality.options);
  for (const bad of [{ ...quality, selected: '1080' }, { ...quality, loading: 'yes' },
    { ...quality, error: null }, { ...quality, options: [] },
    { ...quality, options: [{ value: '720', label: null }] },
    { ...quality, options: [quality.options[1], quality.options[1]] }]) {
    assert.equal(decodeStatus({ ...defaultStatus, quality: bad }).quality, null);
  }
  assert.equal(isWorking({ ...defaultStatus, quality: { ...quality, loading: true } }), true);
});

test('Popup quality and subtitle fields reach HTTP intact through the message handler', async t => {
  const fixture = await startReceiver(t);
  const receiver = createReceiverClient({ baseUrls: [fixture.url] });
  const handle = createMessageHandler({}, receiver);
  for (const fields of [{ action: 'quality', quality: '720' }, { action: 'subtitles', enabled: false },
    { action: 'subtitles', language: 'es' }]) {
    const response = await handle({ type: 'control', ...fields }, {});
    assert.equal(response.ok, true);
    assert.equal(handle({ type: 'control', ...fields }, { tab: { id: 1 } }), undefined);
  }
  assert.deepEqual(fixture.requests.filter(request => request.method === 'POST').map(request => request.body), [
    { action: 'quality', quality: '720' }, { action: 'subtitles', enabled: false },
    { action: 'subtitles', enabled: true, language: 'es' },
  ]);
  const before = fixture.requests.length;
  for (const fields of [{}, null, { quality: 720 }, { quality: '' }, { quality: '720/1080' }]) {
    await assert.rejects(receiver.control('quality', fields), /Invalid quality fields/);
  }
  assert.equal(fixture.requests.length, before);
});
