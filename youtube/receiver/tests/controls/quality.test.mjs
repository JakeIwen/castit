import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { once } from 'node:events';
import { createStatusServer } from '../../src/http/status-server.mjs';
import { createPlayerControls } from '../../src/controls/player-controls.mjs';
import { playerFixture, VIDEO, settleUntil } from '../playback/player-fixture.mjs';

async function fixture(t) {
  const { player, instances } = playerFixture();
  const controls = createPlayerControls(player);
  let writes = 0;
  const server = await createStatusServer({ snapshot: () => ({ ok: true, quality: player.quality }),
    pairing: { snapshot: () => ({}) }, control: (action, fields) => { writes++; return controls[action](fields); } });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => { await player.endSession(); server.closeAllConnections(); await new Promise(r => server.close(r)); });
  return { player, instances, base: `http://127.0.0.1:${server.address().port}`, writes: () => writes };
}

test('Quality HTTP validates, acknowledges persistence before slow reload, and exposes outcome', async t => {
  const { player, instances, base, writes } = await fixture(t);
  const post = quality => fetch(`${base}/api/control`, { method: 'POST',
    headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'quality', quality }) });
  for (const value of [undefined, null, 720, {}, ['720'], 'best', '720p', '720/1080']) {
    assert.equal((await post(value)).status, 400);
  }
  assert.equal(writes(), 0);
  await player.play(VIDEO, 65);
  let release;
  player.resolver.resolve = () => new Promise(resolve => { release = resolve; });
  const response = await post('720');
  assert.deepEqual(await response.json(), { action: 'quality', done: true });
  await settleUntil(() => release);
  const state = await (await fetch(`${base}/api/status`)).json();
  assert.equal(state.quality.selected, '720');
  assert.equal(state.quality.loading, true);
  assert.ok(state.quality.options.some(option => option.value === '720' && option.label === '720p'));
  release(null);
  await settleUntil(() => !player.quality.loading);
  assert.equal(player.quality.error, false);
  assert.deepEqual(instances.at(-1).loaded, { id: VIDEO.id, position: 65 });
});

test('vantv quality uses the real HTTP setting, validates input and displays saved selection', {
  skip: process.platform !== 'darwin' ? 'The Mac CLI requires macOS plutil and zsh' : false,
}, async t => {
  const { base, writes } = await fixture(t);
  const run = (...args) => promisify(execFile)('/bin/zsh', [new URL('../../../vantv.zsh', import.meta.url).pathname,
    'quality', ...args], { env: { ...process.env, VAN_TV: base } });
  assert.match((await run()).stdout, /Quality: Auto/);
  for (const choice of ['1080', '720', '480', '360']) assert.match((await run(choice)).stdout, new RegExp(`Quality: ${choice}p maximum`));
  assert.match((await run('auto')).stdout, /Quality: Auto/);
  for (const value of ['720p', 'best', '720/1080', '720"', '']) await assert.rejects(run(value), { code: 2 });
  await assert.rejects(run('720', '480'), { code: 2 });
  assert.equal(writes(), 5);
});
