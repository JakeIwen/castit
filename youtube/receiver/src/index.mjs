import YouTubeCastReceiver, { Constants } from 'yt-cast-receiver';
import { config } from './config/receiver-config.mjs';
import { PrivateDataStore } from './storage/private-data-store.mjs';
import { MpvPlayer } from './playback/player.mjs';
import { CastQueue, fetchTitle } from './queue/cast-queue.mjs';
import { StreamResolver } from './playback/stream-resolver.mjs';
import { VideoStore } from './video-store/video-store.mjs';
import { runReceiver } from './lifecycle/receiver-lifecycle.mjs';
import { useStableDialUuid } from './pairing/stable-dial-uuid.mjs';
import { unhandledMessageLogger } from './lifecycle/unhandled-message-log.mjs';

process.umask(0o077);
const store = new PrivateDataStore(config.stateDirectory);
await store.initialize();
await useStableDialUuid(store);
const resolver = new StreamResolver();
const videoStore = new VideoStore({ root: config.videoStore, resolver });
const castQueue = new CastQueue({ store,
  lookupTitle: async id => (await videoStore.local(id))?.title ?? fetchTitle(id) });
const player = new MpvPlayer({ store, castQueue, resolver, videoStore });
const receiver = new YouTubeCastReceiver(player, {
  device: { name: config.name, screenName: config.name },
  dial: { port: config.dialPort, prefix: '/ytcr',
    bindToAddresses: [config.lanAddress], corsAllowOrigins: false },
  dataStore: store,
  // Upstream debug/error objects can contain lounge tokens and pairing data;
  // only the names of unhandled sender messages get through.
  logLevel: Constants.LOG_LEVELS.NONE, logger: unhandledMessageLogger(),
  // Like a TV, keep playing when a remote just goes away (ytcast exits, phone
  // sleeps); only an explicit disconnect from every sender ends the session.
  app: { resetPlayerOnDisconnectPolicy: Constants.RESET_PLAYER_ON_DISCONNECT_POLICIES.ALL_EXPLICITLY_DISCONNECTED },
});
await runReceiver({ receiver, player, store });
