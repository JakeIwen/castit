import { join } from 'node:path';
import { loadLocalConfig } from './local-config.mjs';

const local = loadLocalConfig();

export const config = Object.freeze({
  name: 'Van TV',
  lanAddress: process.env.YOUTUBE_CAST_LAN_ADDRESS || local.lanAddress,
  hostnames: local.hostnames,
  dialPort: 8794,
  statusPort: 8795,
  stateDirectory: '/home/pi/.local/state/youtube-cast',
  runtimeDirectory: '/run/youtube-cast',
  installDirectory: '/home/pi/youtube-cast',
  videoLibraryUrl: local.videoLibrary?.controlUrl ?? null,
  sponsorBlockUrl: 'https://sponsor.ajay.app/api/skipSegments',
  sponsorBlockCategories: ['sponsor', 'selfpromo'],
  sessionEnvironment: {
    DISPLAY: ':0',
    XDG_RUNTIME_DIR: '/run/user/1000',
    DBUS_SESSION_BUS_ADDRESS: 'unix:path=/run/user/1000/bus',
  },
  roomCommand: local.roomCommand,
  wakeCommand: ['/usr/bin/xset', '-display', ':0', 'dpms', 'force', 'on'],
  vlcQuitCommand: ['/usr/bin/dbus-send', '--session', '--type=method_call',
    '--print-reply', '--dest=org.mpris.MediaPlayer2.vlc', '/org/mpris/MediaPlayer2',
    'org.mpris.MediaPlayer2.Quit'],
  vlcActiveCommand: local.videoLibrary === null ? null
    : ['/usr/bin/systemctl', '--user', 'is-active', '--quiet', local.videoLibrary.unit],
  vlcStopCommand: local.videoLibrary === null ? null
    : ['/usr/bin/systemctl', '--user', 'stop', local.videoLibrary.unit],
  roomTimeoutMs: 18_000,
  loadTimeoutMs: 90_000,
  pairingLifetimeMs: 300_000,
  pairingRetryMs: 30_000,
  // Titles for queued videos; YouTube's oEmbed endpoint needs no key.
  titleLookupUrl: 'https://www.youtube.com/oembed',
  titleLookupTimeoutMs: 5000,
  queueLimit: 50,
});

// PLAYER TUNING BLOCK: xv and bounded H.264 formats reduce dropped frames on
// the Pi 4. Re-measure for other hardware; the audio device is installation-specific.
// yt-dlp needs Node >= 22 or Deno for YouTube's JS challenges; the venv ships Deno.
export const playback = Object.freeze({
  mpv: '/usr/bin/mpv',
  ytdlp: join(config.installDirectory, 'venv/bin/yt-dlp'),
  format: 'bv*[vcodec^=avc1][height=1080][fps<=25]+ba[acodec^=mp4a]/'
    + 'bv*[vcodec^=avc1][height<=720][fps<=30]+ba[acodec^=mp4a]/'
    + 'bv*[vcodec^=avc1][height<=480]+ba[acodec^=mp4a]/'
    + 'bv*[vcodec^=vp9][height<=720][fps<=30]+ba/b[height<=720]/best',
  args: ['--no-config', '--fullscreen', '--idle=yes', '--force-window=no',
    '--keep-open=no', '--no-terminal', '--osd-level=0', '--no-osc',
    '--no-input-default-bindings', '--hwdec=v4l2m2m-copy', '--vo=xv', '--ao=alsa',
    `--audio-device=${local.audioDevice}`, '--cache=yes',
    '--demuxer-readahead-secs=20', '--demuxer-max-bytes=96MiB'],
  ytdlpOptions: `no-playlist=,js-runtimes=deno:${join(config.installDirectory, 'venv/bin/deno')}`,
});

export function mpvArguments(socketPath) {
  return [...playback.args, `--input-ipc-server=${socketPath}`,
    `--ytdl-format=${playback.format}`,
    `--script-opts=ytdl_hook-ytdl_path=${playback.ytdlp}`,
    `--ytdl-raw-options=${playback.ytdlpOptions}`];
}
