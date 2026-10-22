// A classic script lets content scripts share these constants without exposing
// extension modules as web-accessible resources. ES modules import it for effect.
globalThis.VAN_TV_CONFIG = Object.freeze({
  // Only the background page loads generated receiver addresses before this script.
  receiverUrls: Object.freeze(globalThis.VAN_TV_LOCAL?.receiverUrls ?? []),
  requestTimeoutMs: 3000,
  pollIntervalMs: 2000,
  progressIntervalMs: 250,
  feedbackDurationMs: 3500,
  youtube: Object.freeze({
    origin: 'https://www.youtube.com',
    hosts: Object.freeze(['www.youtube.com', 'youtube.com', 'm.youtube.com']),
    shortHosts: Object.freeze(['youtu.be', 'www.youtu.be']),
    contentMatches: Object.freeze(['*://www.youtube.com/*']),
    watchPath: '/watch',
    videoPaths: Object.freeze(['/shorts/', '/live/', '/embed/']),
    videoIdPattern: /^[A-Za-z0-9_-]{11}$/,
  }),
  message: Object.freeze({
    cast: 'cast', castTab: 'cast-tab', tabVideo: 'tab-video',
    status: 'status', control: 'control', getVideo: 'get-video',
    castAccepted: 'cast-accepted', queue: 'queue', queueTab: 'queue-tab',
    videoDetails: 'video-details',
  }),
  player: Object.freeze({
    idle: 'IDLE', loading: 'LOADING', playing: 'PLAYING',
    paused: 'PAUSED', stopped: 'STOPPED',
  }),
  control: Object.freeze({
    pause: 'pause', resume: 'resume', toggle: 'toggle', stop: 'stop',
    next: 'next', previous: 'previous', seek: 'seek', audioDelay: 'audio_delay',
    speed: 'speed', volume: 'volume', mute: 'mute',
  }),
  queue: Object.freeze({ add: 'add', remove: 'remove', play: 'play', clear: 'clear' }),
  // Seconds per lip-sync nudge; positive plays sound later.
  audioDelayStep: 0.05,
  speedStep: 0.25,
  volumeStep: 5,
  skipOffsets: Object.freeze({
    backwardFiveMinutes: -300, backwardTwentySeconds: -20,
    forwardTwentySeconds: 20, forwardFiveMinutes: 300,
  }),
  command: 'cast-active-tab',
});
