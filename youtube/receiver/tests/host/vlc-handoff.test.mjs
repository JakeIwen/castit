import test from 'node:test';
import assert from 'node:assert/strict';
import { stopVideoLibrary } from '../../src/host/vlc-handoff.mjs';
import { config } from '../../src/config/receiver-config.mjs';

const log = { warn() {} };
const settings = { ...config, videoLibraryUrl: 'http://127.0.0.1:8789/api/control',
  vlcActiveCommand: ['/usr/bin/systemctl', '--user', 'is-active', '--quiet', 'media-player.service'],
  vlcStopCommand: ['/usr/bin/systemctl', '--user', 'stop', 'media-player.service'],
};

test('Handoff prefers the bookmarking HTTP stop route over MPRIS', async () => {
  const result = await stopVideoLibrary({ settings, log, fetcher: async (url, options) => {
    assert.equal(url, settings.videoLibraryUrl);
    assert.equal(options.method, 'POST');
    assert.equal(options.body.get('action'), 'stop');
    return Response.json({ ok: true });
  }, run: async command => {
    if (command !== settings.vlcActiveCommand) assert.fail('must not bypass library bookmark');
  } });
  assert.equal(result, 'http');
});

test('Handoff falls back to MPRIS Quit then only the library-owned user unit', async () => {
  for (const fetcher of [async () => { throw new Error('offline'); },
    async () => Response.json({ ok: false }, { status: 503 }),
    async () => new Response('bad JSON')]) {
    const commands = [];
    assert.equal(await stopVideoLibrary({ settings, log, fetcher, run: async command => {
      if (command === settings.vlcActiveCommand) return;
      commands.push(command);
      if (command === settings.vlcQuitCommand) throw new Error('VLC absent');
    } }), 'mpris');
    assert.deepEqual(commands, [settings.vlcQuitCommand, settings.vlcStopCommand]);
  }
});

test('Handoff fails closed if neither HTTP nor owned-unit stop succeeds', async () => {
  await assert.rejects(stopVideoLibrary({ settings, log,
    fetcher: async () => { throw new Error('offline'); },
    run: async command => {
      if (command !== settings.vlcActiveCommand) throw new Error('user bus unavailable');
    },
  }), /user bus unavailable/);
});

test('Handoff does nothing when the library player unit is not active', async () => {
  const commands = [];
  assert.equal(await stopVideoLibrary({ settings, log,
    fetcher: () => assert.fail('no library stop without VLC'),
    run: async command => { commands.push(command); throw new Error('Command exited 3'); },
  }), 'idle');
  assert.deepEqual(commands, [settings.vlcActiveCommand]);
});

test('Null video-library handoff skips all commands and HTTP requests', async () => {
  assert.equal(config.videoLibraryUrl, null);
  assert.equal(await stopVideoLibrary({
    run: () => assert.fail('disabled handoff must not run commands'),
    fetcher: () => assert.fail('disabled handoff must not request HTTP'),
  }), 'disabled');
});

test('Cancelled casts do not stop VLC through the fallback', async () => {
  const abort = new AbortController();
  abort.abort();
  await assert.rejects(stopVideoLibrary({ settings, log, signal: abort.signal,
    fetcher: async () => { throw new Error('aborted'); },
    run: () => assert.fail('cancelled operation'),
  }), { name: 'AbortError' });
});
