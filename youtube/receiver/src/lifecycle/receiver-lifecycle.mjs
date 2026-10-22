import { Constants } from 'yt-cast-receiver';
import { randomUUID } from 'node:crypto';
import { config } from '../config/receiver-config.mjs';
import { PairingCodes } from '../pairing/pairing-codes.mjs';
import { listenStatus } from '../http/status-server.mjs';
import { PlayerStatus } from '../playback/player.mjs';
import { createPlayerControls, createQueueControls } from '../controls/player-controls.mjs';
import { WatchHistory } from '../history/watch-history.mjs';

export async function runReceiver({ receiver, player, store, log = console,
  watchHistory = new WatchHistory({ log }), statusListener = listenStatus }) {
  const instance = randomUUID();
  const pairing = new PairingCodes(receiver.getPairingCodeRequestService(), { log });
  let stopping = false;
  let closeStatus;
  let stopPromise;
  const snapshot = () => ({
    ok: !stopping && receiver.status === Constants.STATUSES.RUNNING,
    name: config.name, pid: process.pid, instance, receiver: receiver.status,
    player: Object.keys(PlayerStatus).find(key => PlayerStatus[key] === player.status) || 'UNKNOWN',
    video: player.video, position: player.position, duration: player.duration, audioDelay: player.audioDelay,
    speed: player.speed, volume: player.volume, queue: player.castQueue.snapshot(),
    played: player.castQueue.playedSnapshot(player.video),
    senders: receiver.getConnectedSenders().length,
    watchHistory: watchHistory.snapshot(),
  });
  const stop = (code = 0) => {
    if (stopPromise) return stopPromise;
    stopping = true;
    stopPromise = (async () => {
      const deadline = setTimeout(() => process.exit(code || 1), 18_000);
      try {
        pairing.stop();
        watchHistory.stop();
        await player.endSession();
        await receiver.stop();
        await closeStatus?.();
        await store.writes;
      } catch { code = 1; log.error('Receiver shutdown failed'); }
      clearTimeout(deadline);
      process.exit(code);
    })();
    return stopPromise;
  };
  process.once('SIGTERM', () => void stop());
  process.once('SIGINT', () => void stop());
  receiver.on('error', () => log.warn('Receiver connection error'));
  receiver.on('terminate', () => { log.error('Receiver terminated; supervisor will retry'); void stop(1); });
  receiver.on('senderDisconnect', (_sender, implicit) => {
    if (!implicit && receiver.getConnectedSenders().length === 0) {
      void player.endSession().catch(() => log.warn('Player disconnect cleanup failed'));
    }
  });
  try {
    await store.initialize();
    await player.initialize();
    watchHistory.start(player);
    const controls = createPlayerControls(player);
    const queueControls = createQueueControls(player, { log });
    const cast = async (videoId, position) => {
      if (receiver.status !== Constants.STATUSES.RUNNING) throw new Error('Receiver not running');
      void player.play({ id: videoId, client: Constants.CLIENTS.YT }, position)
        .catch(() => log.warn('Direct cast failed'));
    };
    closeStatus = await statusListener({ snapshot, pairing, cast,
      control: (action, fields) => controls[action](fields),
      queue: (action, fields) => queueControls[action](fields) });
    const startup = setTimeout(() => { log.error('Receiver startup timeout'); void stop(1); }, 60_000);
    try { await receiver.start(); } finally { clearTimeout(startup); }
    if (!stopping) pairing.start();
    log.info(`Van TV ready; status port ${config.statusPort}, DIAL port ${config.dialPort}`);
  } catch { log.error('Receiver startup failed'); await stop(1); }
}
