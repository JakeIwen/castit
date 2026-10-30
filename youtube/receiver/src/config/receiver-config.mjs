import { join } from 'node:path';
import { qualityFormat, DEFAULT_QUALITY } from '../playback/quality.mjs';
import { SUBTITLE_FORMATS } from '../playback/subtitles.mjs';
import { loadLocalConfig } from './local-config.mjs';

const local = loadLocalConfig();

export const config = Object.freeze({
  name: 'Van TV',
  lanAddress: process.env.YOUTUBE_CAST_LAN_ADDRESS || local.lanAddress,
  tailscaleAddress: local.tailscaleAddress,
  hostnames: local.hostnames,
  dialPort: 8794,
  statusPort: 8795,
  stateDirectory: '/home/pi/.local/state/youtube-cast',
  runtimeDirectory: '/run/youtube-cast',
  installDirectory: '/home/pi/youtube-cast',
  videoLibraryUrl: local.videoLibrary?.controlUrl ?? null,
  videoStore: local.videoStore,
  sponsorBlockUrl: 'https://sponsor.ajay.app/api/skipSegments',
  sponsorBlockCategories: ['sponsor', 'selfpromo'],
  sessionEnvironment: {
    DISPLAY: ':0',
    WAYLAND_DISPLAY: 'wayland-0',
    XDG_RUNTIME_DIR: '/run/user/1000',
    DBUS_SESSION_BUS_ADDRESS: 'unix:path=/run/user/1000/bus',
  },
  roomCommand: local.roomCommand,
  // The desktop is labwc (Wayland); xset on Xwayland can't power the output on.
  wakeCommand: ['/usr/bin/wlopm', '--on', '*'],
  vlcQuitCommand: ['/usr/bin/dbus-send', '--session', '--type=method_call',
    '--print-reply', '--dest=org.mpris.MediaPlayer2.vlc', '/org/mpris/MediaPlayer2',
    'org.mpris.MediaPlayer2.Quit'],
  vlcActiveCommand: local.videoLibrary === null ? null
    : ['/usr/bin/systemctl', '--user', 'is-active', '--quiet', local.videoLibrary.unit],
  vlcStopCommand: local.videoLibrary === null ? null
    : ['/usr/bin/systemctl', '--user', 'stop', local.videoLibrary.unit],
  roomTimeoutMs: 18_000,
  roomCheckDelayMs: 1500,
  loadTimeoutMs: 90_000,
  pairingLifetimeMs: 300_000,
  pairingRetryMs: 30_000,
  // Titles for queued videos; YouTube's oEmbed endpoint needs no key.
  titleLookupUrl: 'https://www.youtube.com/oembed',
  titleLookupTimeoutMs: 5000,
  queueLimit: 50,
});

const ytdlpRawOptions = [
  ['no-playlist', ''],
  ['js-runtimes', `deno:${join(config.installDirectory, 'venv/bin/deno')}`],
];

// Sizes are scaled from mpv's 720p reference height; borders keep text legible on video.
export const subtitleStyle = Object.freeze({
  'sub-font': 'sans-serif', 'sub-font-size': 42, 'sub-color': '#FFFFFFFF',
  'sub-border-color': '#FF000000', 'sub-border-size': 2.5,
  'sub-shadow-offset': 1, 'sub-pos': 94, 'sub-ass-override': 'force',
});

// PLAYER TUNING BLOCK: OpenGL ES avoids xv's video backlog and A/V drift on
// the Pi 4's rotated X screen; bounded H.264 formats reduce dropped frames.
// Re-measure for other hardware; the audio device is installation-specific.
// yt-dlp needs Node >= 22 or Deno for YouTube's JS challenges; the venv ships Deno.
export const playback = Object.freeze({
  mpv: '/usr/bin/mpv',
  mpvStopGraceMs: 500,
  ytdlp: join(config.installDirectory, 'venv/bin/yt-dlp'),
  nice: '/usr/bin/nice',
  resolveNice: 10,
  prefetchNice: 19,
  // Allow a slow network/JS challenge to finish once instead of restarting it in mpv.
  resolveTimeoutMs: 60_000,
  subtitleLoadTimeoutMs: 20_000,
  resolveMaxBytes: 8 * 1024 * 1024,
  resolveExpiryMarginMs: 60_000,
  resolveCacheEntries: 16,
  prefetchIntervalMs: 2000,
  format: qualityFormat(),
  args: ['--no-config', '--fullscreen', '--idle=yes', '--force-window=no',
    '--keep-open=no', '--no-terminal', '--osd-level=0', '--no-osc',
    '--no-input-default-bindings', '--hwdec=v4l2m2m-copy', '--vo=gpu',
    '--gpu-context=x11egl', '--opengl-es=yes', '--ao=alsa',
    `--audio-device=${local.audioDevice}`, '--cache=yes',
    '--demuxer-readahead-secs=20', '--demuxer-max-bytes=96MiB'],
  ytdlpOptions: ytdlpRawOptions.map(([name, value]) => `${name}=${value}`).join(','),
});

export const watchUrl = videoId => `https://www.youtube.com/watch?v=${videoId}`;

export function resolverArguments(videoId, { prefetch = false, language = null, quality = DEFAULT_QUALITY } = {}) {
  return [playback.nice, '-n', String(prefetch ? playback.prefetchNice : playback.resolveNice),
    playback.ytdlp, '--no-warnings', '-J', '--flat-playlist',
    '--format', qualityFormat(quality),
    ...ytdlpRawOptions.flatMap(([name, value]) => value ? [`--${name}`, value] : [`--${name}`]),
    ...(language ? ['--write-subs', '--write-auto-subs', '--sub-langs', language,
      '--sub-format', SUBTITLE_FORMATS.join('/')] : ['--no-write-subs', '--no-write-auto-subs']),
    '--', watchUrl(videoId)];
}

export function mpvArguments(socketPath) {
  return [...playback.args, '--sid=no', '--sub-auto=no',
    ...Object.entries(subtitleStyle).map(([name, value]) => `--${name}=${value}`),
    `--input-ipc-server=${socketPath}`,
    `--ytdl-format=${playback.format}`,
    `--script-opts=ytdl_hook-ytdl_path=${playback.ytdlp}`,
    `--ytdl-raw-options=${playback.ytdlpOptions},no-write-subs=,no-write-auto-subs=`];
}
