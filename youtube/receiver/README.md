# YouTube receiver

YouTube DIAL/Lounge receiver for a Raspberry Pi with an HDMI display. Phones
control playback and the queue; yt-dlp resolves streams for mpv. SponsorBlock
skips `sponsor` and `selfpromo` segments when available. The receiver appears as
**Van TV**. This is not a general Google Cast or AirPlay receiver.

## Requirements and configuration

The Pi needs Node >= 20, npm, mpv, Python 3 with venv/pip, curl, `xset`,
`dbus-send`, and an active `pi` X session on `:0`. The deployment machine needs
Node, SSH and SCP. The controller checks prerequisites without installing OS
packages. On Debian-based systems, the media prerequisites include:

```sh
sudo apt-get install mpv python3-venv python3-pip x11-xserver-utils dbus-bin
```

From this directory, copy the shared example and edit its `receiver` section:

```sh
cp ../local.example.json ../local.json
```

`../local.json` is gitignored. Keep machine-specific values out of source:

- `sshTarget`: SSH host or `user@host` used by `deploy.sh`.
- `hostnames`: extra trusted HTTP Host names, without ports. Loopback names and
  `lanAddress` are always trusted.
- `lanAddress`: Pi IPv4 LAN address for discovery and status binding.
  `YOUTUBE_CAST_LAN_ADDRESS` overrides it at runtime.
- `audioDevice`: mpv audio-device value; inspect devices with `mpv --audio-device=help`.
- `roomCommand`: optional argv array, run once per cast session with an
  18-second timeout. Each video also wakes the screen. `null` skips room
  preparation; the screen wake still runs. Preparation failures do not block playback.
  If the command sets an amplifier's volume, give it a level suited to YouTube's
  loudness-normalized audio (louder than most films) and trim from there with
  the receiver's own volume.
- `videoLibrary`: `null` disables playback handoff. Otherwise set `controlUrl`
  to a bookmarking HTTP stop endpoint and `unit` to its systemd user service.
  The receiver checks that unit, POSTs form `action=stop`, and expects JSON
  `{"ok":true}`. If HTTP fails, it tries VLC MPRIS Quit and stops only the
  configured unit; a failed fallback prevents competing playback.

The `senders` section is used by [the shell sender](../vantv.zsh) and
[Firefox extension](../firefox/). The receiver validates only `receiver`.
Missing or invalid configuration fails startup with the affected key named.
`src/config/local-config.mjs` loads `CASTIT_LOCAL_CONFIG`, or `local.json` beside
`src/` in a deployed release. To run from this source directory:

```sh
npm ci
CASTIT_LOCAL_CONFIG=../local.json npm start
```

`src/config/receiver-config.mjs` owns fixed ports, paths and playback tuning. Its format and
video-output defaults target Pi 4 hardware; re-measure for another device.
`mpvArguments()` is the single player argv builder.

## Load path and timings

Each load resolves streams with the same yt-dlp selector, Deno runtime and hook
options while room preparation and VLC handoff run independently. mpv starts
only after handoff releases the audio device. Loading waits for room preparation
(including its existing timeout/failure tolerance), so the opening audio is not
lost while routing switches. A replacement or Stop cancels and drains old work.
mpv still closes on each replacement; its process is not reused.

`src/playback/stream-resolver.mjs` runs bounded subprocess groups at nice 10.
Simple selected HTTP(S) video/audio tracks load directly using mpv 0.35's
per-file option map, with external audio and ytdl disabled only for that file.
Extraction errors and hook-dependent results (live/fragmented streams, subtitles,
or incompatible per-track headers) use the original watch-URL/ytdl-hook path.
The in-memory cache holds at most 16 results, expiring one minute before the
earliest googlevideo URL expiration. The first upcoming cast-queue entry is
prefetched at nice 19 while playing; polling notices additions every two seconds,
never runs two prefetches at once, and never consumes or reorders the queue.
The phone's queue is not prefetched. No client/format-selection experiments are
applied, and no account cookies are added to playback extraction.

Each attempted load writes one `Video load timing` line with `handoff`, `room`,
`mpv_start` (including property setup), `resolve`, `load` and `total` milliseconds,
plus a loaded/failed/cancelled outcome. Total covers `doPlay`, not sender/network
latency or a prior base-player stop. Phases overlap, so their sum exceeds total;
`load` includes extraction on fallback. Logs contain no URLs, IDs or titles.

## Deployment and lifecycle

From this directory on the deployment machine:

```sh
bash deploy.sh prepare
bash deploy.sh install
bash deploy.sh status
```

The deployer reads `../local.json` and ships it as the release's `local.json`.
`prepare` validates configuration, prerequisites, JavaScript syntax and the
systemd unit without registering a service. `install` creates a release under
`/home/pi/youtube-cast/`, runs `npm ci --omit=dev`, updates a shared venv with
`yt-dlp[default]` and Deno, then switches `current` and checks health. Application
packages are never installed as root. The root-owned system unit is
`youtube-cast.service`, running as `pi` with private state and runtime directories.

Other `deploy.sh` verbs are `start`, `stop`, `restart`, `verify`, `uninstall`
and `update-ytdlp`. Stop disables boot startup; uninstall removes registration
but preserves releases, dependencies and paired screen identity. Verify kills
the main process and requires a replacement healthy PID, briefly interrupting
playback. On the Pi, use the same verbs through the installed controller:

```sh
bash /home/pi/youtube-cast/current/controller.sh status
journalctl -u youtube-cast.service -n 80 --no-pager
```

Older releases remain available; `previous` points to the last healthy one.
Failed installations print the prior path rather than automatically rolling
back the shared yt-dlp environment. A code rollback must restore that release's
`current` link and root-owned unit, reload systemd, restart and check status;
never restore an older screen identity. The yt-dlp venv is independent.

YouTube can break old extractors. Run `update-ytdlp` when needed, preferably
while idle. An optional **pi-user** crontab entry (not installed by the deployer):

```cron
0 6 * * 0 /bin/bash /home/pi/youtube-cast/current/controller.sh update-ytdlp
```

## Pairing, ports and state

On the same LAN, select **Van TV** in the YouTube app's Cast menu. Discovery
needs multicast SSDP UDP 1900 and DIAL TCP **8794**. Alternatively open the Pi's
status page on port **8795**, then enter its temporary TV code in YouTube's
Settings → Watch on TV → Enter TV code. TV-code pairing needs internet on both
devices, not direct phone-to-Pi connectivity. Codes refresh every five minutes.
Chrome's built-in Google Cast button does not discover this receiver.

The status page listens on loopback and the configured LAN address. DIAL's
upstream HTTP listener binds all interfaces; its discovery-interface setting
does not restrict that listener. Both ports are for trusted networks only:
there is no login. Do not forward them to the internet; use a host firewall if
additional isolation is needed.

Private state lives in `/home/pi/.local/state/youtube-cast/` (directory mode 700,
files 600); yt-dlp's cache uses its `cache/` subfolder, surviving service restarts.
mpv sockets and temporary files use `/run/youtube-cast/`. Keep state across updates
and restarts to preserve pairing, volume, speed and A/V offset. Corrupt identity files
fail closed. Stopping or the last sender's explicit disconnect closes mpv and
its resolver children. Starting another player later does not stop this one.

## HTTP API, settings and queue

- `GET /health`: supervisor health without pairing codes or identity.
- `GET /api/status`: receiver/player state, video, position, duration, pairing
  status, `audioDelay` in seconds, `speed`, `volume` (`{level, muted}`) and
  `queue` (`[{key, id, title}]`, title null until YouTube supplies it). `played`
  has the same entry shape: up to 20 videos that started on this receiver, oldest
  first, excluding the currently loaded video. Repeated video ids move to the
  end; titles follow mpv, falling back to the queued video's oEmbed title. Entry
  keys are unique across both lists.
- `POST /api/cast`: JSON `{"videoId":"dQw4w9WgXcQ","position":12.5}`. Position
  is optional and non-negative. Returns 202 while loading; poll status for the result.
- `POST /api/control`: JSON with `action`: `pause`, `resume`, `toggle`, `stop`,
  `next` or `previous`. Stop resets the phone's queue; the cast queue stays. Next plays the phone's next
  video (or its autoplay pick), then the cast queue; with neither it does nothing.
  `seek` requires exactly one of absolute `position` (>= 0) or relative
  `offset`, in seconds, clamped to the video.
- `POST /api/control` with `{"action":"audio_delay","delay":-0.12}` sets the
  A/V offset. Use exactly one of absolute `delay` or relative `offset`, in finite
  seconds. Values clamp to −1…+1 second and round to 0.01 second; positive values
  delay audio. Changes apply live and persist while idle and across restarts.
  The page's Sound earlier/later buttons step by 50 ms; Reset restores zero.
- `speed` takes exactly one of absolute `speed` or relative `offset`; values
  clamp to 0.25–3 and round to 0.01. mpv keeps the pitch. Faster playback needs
  proportionally more bandwidth and decoding; check for dropped frames at 1080p.
- `volume` takes exactly one of absolute `level` (0–100) or relative `offset`,
  and unmutes. `mute` takes an optional boolean `muted`; without it, it toggles.
  This is mpv's software volume, shared with the phone's volume control.
- Speed, volume and A/V offset apply live, can be set while idle, and are saved
  in `settings.json` across sessions and restarts.
- `POST /api/queue`: the cast queue, for senders without a phone session.
  `{"action":"add","videoId":"…"}` appends (up to 50); it starts at once only
  when nothing is playing and the queue was empty, so a kept queue never jumps
  ahead or starts on its own. `play` and `remove` take an entry `key` from status.
  `play` also accepts a `played` key to replay from the start; it stays in history
  until playback starts again, when it gets a new key at the end. `move` takes
  `key` and a non-negative safe integer `index`: the upcoming entry's final
  zero-based position, clamped to the queue's last position. `play`, `remove`
  and `move` return `done:false` for missing keys; played entries cannot be moved
  or removed. `clear` empties the upcoming queue. Queued videos play after the
  phone's own queue, at the end of each video or on Next. Both lists are saved
  in `queue.json` in the private state directory and survive Stop, the last
  sender's disconnect and restarts; restoring them never starts playback. Queue titles come from YouTube's
  oEmbed endpoint. The status page shows recently played videos newest first.
- The library ignores sender messages it doesn't implement. The receiver logs
  each one's name (never its payload) as `Unhandled sender message: <name>` in
  the journal, to show what a phone feature such as its speed menu sends.

POSTs require `Content-Type: application/json` and an absent, `null`, extension
or same-server Origin. Foreign Hosts and web origins are rejected; cross-origin
CORS preflight is not supported. Control responses include `action` and `done`.

## Watch history (optional)

With account cookies installed, `src/history/watch-history.mjs` requests a
YouTube watch-history mark after 20 seconds in the Player's `PLAYING` state.
Loading and paused time do not count; seeking does not advance this clock.
Each play gets one attempt, including a later replay. It runs yt-dlp separately
at low priority with a two-minute timeout, never awaiting it on the playback
path. Only one attempt runs at once; the newest qualified video replaces any
older pending attempt, without interrupting the active one.

On the Mac, sign in to YouTube in Firefox, then run from this directory:

```sh
zsh ./push-youtube-cookies.zsh
zsh ./push-youtube-cookies.zsh --remove
```

The first command exports Google/YouTube cookies from the default Firefox
profile's default container and atomically installs a mode-600
`youtube-cookies.txt` in the receiver's private state directory, using
`../local.json`'s SSH target. The second deletes it to disable history. No
restart is needed. `--profile <dir>` selects another profile; `--output <file>`
exports locally instead of contacting the receiver. Keep that file outside this
public repository; never commit or share account cookies.

Without the file, history is off. Non-regular files, symlinks, another owner's
file or any mode other than 600 are rejected. Status includes only
`watchHistory: { enabled, state, reason, lastMarkedAt }`: state is `off`, `ok`
or `failed`; reason is null, `signed-out`, `rejected-file` or `error`.
`lastMarkedAt` is an ISO timestamp of the last successful attempt this process,
not confirmation from your account's history page. No video details or yt-dlp
output are included in that record or history logs.

YouTube rotates cookies, so this can stop working. If status says `signed-out`,
further attempts wait until you re-run the exporter. yt-dlp recommends exporting
from a private window and then closing it to keep the session valid longer;
Firefox private-window cookies are memory-only, so this SQLite exporter cannot
capture those sessions. It exports the on-disk, non-private session only.

**Account risk:** yt-dlp warns that automated access with account cookies can
get an account flagged. One attempt per video play is light use, not a safety
guarantee; enabling it is your choice.

## Tests and limitations

```sh
npm ci
npm test
```

Tests use `../local.example.json`, temporary stores, local HTTP/IPC fixtures and
fake playback processes; no real room command or media handoff runs.
`src/config/local-config.mjs` validates installation settings; `src/index.mjs` wires the receiver;
`src/playback/player.mjs` implements playback, with process/IPC in `src/playback/mpv/`,
room preparation and VLC handoff in `src/host/`, and the cast queue in
`src/queue/cast-queue.mjs`. Pairing (`src/pairing/`), private persistence
(`src/storage/`), status (`src/http/`) and SponsorBlock (`src/playback/sponsor-block.mjs`)
also have dedicated modules.

`yt-cast-receiver` is pinned to 2.1.0. Security overrides pin `query-string`
9.5.1 and `uuid` 11.1.1; re-test DIAL and cloud pairing when upgrading them.
The unofficial Lounge protocol and YouTube extraction can change without notice.
Sign-in-required, private, age-restricted and regional videos are not guaranteed.
SponsorBlock is best-effort; upstream can invalidate a persisted screen identity.
