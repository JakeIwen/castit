import test from 'node:test';
import assert from 'node:assert/strict';
import { unhandledMessageLogger } from '../../src/lifecycle/unhandled-message-log.mjs';

const unhandled = name => `[yt-cast-receiver] (AID: 7) (YT) Not handled: '${name}'`;

test('Only the names of unhandled sender messages are logged', () => {
  const lines = [];
  const logger = unhandledMessageLogger({ info: line => lines.push(line) });
  logger.debug(unhandled('setPlaybackSpeed'));
  logger.debug('[yt-cast-receiver] Sending message with payload:', { loungeToken: 'secret' });
  logger.error('Lounge token secret');
  logger.info('[yt-cast-receiver] Player.play(): abc');
  assert.deepEqual(lines, ['Unhandled sender message: setPlaybackSpeed']);
});

test('Each unhandled message name is logged once, so repeated keepalives stay out of the journal', () => {
  const lines = [];
  const logger = unhandledMessageLogger({ info: line => lines.push(line) });
  for (let i = 0; i < 3; i++) logger.debug(unhandled('noop'));
  logger.debug(unhandled('getDiscoveryDeviceId'));
  logger.debug(unhandled('noop'));
  assert.deepEqual(lines, ['Unhandled sender message: noop', 'Unhandled sender message: getDiscoveryDeviceId']);
  const names = Array.from({ length: 150 }, (_, i) => `name${String.fromCharCode(65 + (i % 26))}${'x'.repeat(Math.floor(i / 26))}`);
  for (const name of names) logger.debug(unhandled(name));
  assert.equal(lines.length, 100);
});
