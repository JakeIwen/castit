import test from 'node:test';
import assert from 'node:assert/strict';
import { unhandledMessageLogger } from '../src/unhandled-message-log.mjs';

test('Only the names of unhandled sender messages are logged', () => {
  const lines = [];
  const logger = unhandledMessageLogger({ info: line => lines.push(line) });
  logger.debug("[yt-cast-receiver] (AID: 7) (YT) Not handled: 'setPlaybackSpeed'");
  logger.debug('[yt-cast-receiver] Sending message with payload:', { loungeToken: 'secret' });
  logger.error('Lounge token secret');
  logger.info('[yt-cast-receiver] Player.play(): abc');
  assert.deepEqual(lines, ['Unhandled sender message: setPlaybackSpeed']);
});
