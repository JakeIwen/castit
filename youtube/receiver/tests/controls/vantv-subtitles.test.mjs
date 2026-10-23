import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { once } from 'node:events';
import { createStatusServer } from '../../src/http/status-server.mjs';
import { createPlayerControls } from '../../src/controls/player-controls.mjs';
import { playerFixture } from '../playback/player-fixture.mjs';

test('vantv subs sends real HTTP settings and displays the saved language', {
  skip: process.platform !== 'darwin' ? 'The Mac CLI requires macOS plutil and zsh' : false,
}, async t => {
  const { player } = playerFixture();
  const controls = createPlayerControls(player);
  let writes = 0;
  const server = await createStatusServer({ snapshot: () => ({ ok: true, subtitles: player.subtitles }),
    pairing: { snapshot: () => ({}) }, control: (action, fields) => { writes++; return controls[action](fields); } });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => { await player.endSession(); server.closeAllConnections(); await new Promise(r => server.close(r)); });
  const run = (...args) => promisify(execFile)('/bin/zsh', [new URL('../../../vantv.zsh', import.meta.url).pathname,
    'subs', ...args], { env: { ...process.env, VAN_TV: `http://127.0.0.1:${server.address().port}` } });
  assert.match((await run()).stdout, /Subtitles: off \(en\)/);
  assert.match((await run('on')).stdout, /Subtitles: on \(en\)/);
  assert.match((await run('pt-BR')).stdout, /Subtitles: on \(pt-br\)/);
  assert.match((await run('off')).stdout, /Subtitles: off \(pt-br\)/);
  assert.match((await run('on')).stdout, /Subtitles: on \(pt-br\)/);
  assert.equal(writes, 4);
  for (const value of ['all', 'en.*', 'en,es', 'en"']) await assert.rejects(run(value), { code: 2 });
  assert.equal(writes, 4);
});
