import test from 'node:test';
import assert from 'node:assert/strict';
import { qualityFormat } from '../../src/playback/quality.mjs';
import { METERED_CONSUMERS } from '../../src/host/metered-permissions.mjs';
import { playerFixture, VIDEO, SECOND, settleUntil } from './player-fixture.mjs';

const autoLabel = player => player.quality.options.find(option => option.value === 'auto').label;

test('Denied Auto uses the strict 720 selector for direct extraction, hook fallback and queue prefetch', async t => {
  const calls = [];
  const permissions = [];
  const { player, instances } = playerFixture({
    permissions: { allows: async consumer => { permissions.push(consumer); return false; } },
    resolver: { resolve: async (id, options) => { calls.push({ id, ...options }); return null; } },
  });
  t.after(() => player.endSession());
  player.castQueue.add(SECOND.id);
  assert.equal(await player.play(VIDEO), true);
  await settleUntil(() => calls.length === 2);
  assert.equal(player.quality.selected, 'auto', 'metering never changes the saved/manual selection');
  assert.equal(autoLabel(player), 'Auto (720p, metered)');
  assert.deepEqual(calls.map(call => call.quality), ['720', '720']);
  assert.equal(instances[0].propertiesAtLoad.get('ytdl-format'), qualityFormat('720'));
  assert.deepEqual(permissions, [METERED_CONSUMERS.HD]);
});

test('Auto rechecks admission at each new video, never switches the current video on permission changes', async t => {
  let permitted = true;
  let checks = 0;
  const { player, instances } = playerFixture({ permissions: { allows: async () => { checks++; return permitted; } } });
  t.after(() => player.endSession());
  await player.play(VIDEO);
  assert.equal(instances[0].propertiesAtLoad.get('ytdl-format'), qualityFormat('auto'));
  assert.equal(autoLabel(player), 'Auto');
  permitted = false;
  await player.seek(5);
  await player.pause();
  await player.resume();
  assert.equal(instances.length, 1);
  assert.equal(checks, 1);
  await player.play(SECOND);
  assert.equal(checks, 2);
  assert.equal(instances[1].propertiesAtLoad.get('ytdl-format'), qualityFormat('720'));
  assert.equal(autoLabel(player), 'Auto (720p, metered)');
  permitted = true;
  await player.seek(10);
  assert.equal(autoLabel(player), 'Auto (720p, metered)');
  await player.play(VIDEO);
  assert.equal(checks, 3);
  assert.equal(instances[2].propertiesAtLoad.get('ytdl-format'), qualityFormat('auto'));
  assert.equal(autoLabel(player), 'Auto');
});

test('Explicit quality including saved manual 720 and selected 1080 bypasses the HD permission', async t => {
  const store = { get: async () => ({ quality: '720' }), set: async () => {} };
  const { player, instances } = playerFixture({ store,
    permissions: { allows: () => assert.fail('explicit choices do not ask HD permission') } });
  t.after(() => player.endSession());
  await player.initialize();
  await player.play(VIDEO);
  assert.equal(player.quality.selected, '720');
  assert.equal(instances[0].propertiesAtLoad.get('ytdl-format'), qualityFormat('720'));
  await player.setQuality('1080');
  await settleUntil(() => !player.quality.loading);
  assert.equal(player.quality.selected, '1080');
  assert.equal(instances[1].propertiesAtLoad.get('ytdl-format'), qualityFormat('1080'));
  assert.equal(autoLabel(player), 'Auto');
});
