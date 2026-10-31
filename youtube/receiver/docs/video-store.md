# Video store

## Configuration and disk safety

Set `receiver.videoStore` in the private `local.json` to a directory immediately
below a removable-drive mountpoint. The example uses `/mnt/EXFAT512/van-tv`.
Omitted or `null` disables storage. The directory must be an absolute, normalized
path; the receiver checks its parent against that parent's parent using `st_dev`.
A missing mount, a symlinked mount/root, or an unreadable store never causes a
replacement directory to be created on the system disk. Playback falls back to
direct streaming. No mount or unmount command is run by the receiver.

The installed unit permits writes below `/mnt`, rather than bind-mounting the
optional drive itself. A store outside `/mnt` needs a corresponding writable
mount-parent allowance in the unit. Do not add `RequiresMountsFor`: the receiver
must still start and stream without the drive. Deployment checks `/usr/bin/ffmpeg`
when storage is configured. Install it with `sudo apt-get install ffmpeg`.

Below 2 GiB free, new cache writes and downloads are refused. Already saved or
fully cached videos can still play. If the floor is reached during proxy playback,
a subsequent HTTP request redirects to the upstream stream. A write already in
flight can fail; playback can then be retried directly. Downloads preserve their
partial cache and report an error. Muxing requires space for the output as well
as the cached inputs and the 2 GiB reserve; it also monitors free space while
ffmpeg runs. Other processes consuming space can still interrupt a download.

The drive should be excluded from backup snapshot copies of media. In particular,
exclude the store directory from an EXFAT snapshot; the receiver does not edit a
backup configuration. Verify actual unmount/remount behavior under the installed
systemd unit before relying on a nightly backup's unmount window.

## Streaming and replay

For supported direct HTTP(S) formats, mpv receives loopback proxy URLs from an
OS-assigned port. Routes have random tokens and accept only the loopback Host.
The proxy supports GET, HEAD, single byte ranges and suffix ranges. It validates
upstream Content-Range, uses bounded ranged requests (never over 10 MiB; ordinary
pieces are 1 MiB to limit startup and seek latency), and writes fetched bytes to
sparse files with persisted byte-range maps. Overlapping playback and download
requests share a per-format queue and never fetch an already recorded byte again.
A 403 or 410 forces fresh resolution; the format id and size must still match.

Entries live under `.cache/<videoId>/`, with one `.bin` per format id and an
`entry.json` containing title, channel, duration, quality selections, codec/size
metadata and ranges. Signed URLs and HTTP credentials remain in memory. Separate
quality selections can share a format only when its id is identical. Hook-only
formats and extraction failures retain the original streaming fallback; an
extraction timeout still fails rather than repeating extraction in the hook.

Before extraction, a saved file wins at every quality. Otherwise a complete cache
selection plays from its local files. Neither path invokes yt-dlp, title lookup,
subtitle extraction or queue prefetch. Captions are unavailable for these local
copies; subtitle preferences remain saved. SponsorBlock and optional account
watch-history requests remain best-effort asynchronous work and cannot block
local playback when offline.

An unmarked entry expires ten minutes after Stop, idle, or moving to another
video. Replaying it cancels that expiry. Startup deletes stale unmarked entries;
entries left by a crash use their last recorded activity time. No file descriptor
on the drive is held when neither playback nor a download is active. A saved
Download is never expired automatically.

## Download and saved files

Download marks the video to keep and fills only missing ranges, using the current
playback selection when that video is already streaming. Other ids use the saved
quality setting and the same resolver/proxy transfer code. Downloads run one at a
time, yielding between small pieces so playback seeks are not queued behind an
entire download. Repeating Download resumes an error without refetching recorded
bytes. A restart preserves marked entries but requires an explicit retry; it does
not silently begin using network bandwidth.

Before a background save starts extraction or full-track transfers, it requires
`pi.castit_saves` from the configured metered CLI. A denial keeps the same job
pending with `Waiting for metered connection permission`, without fetching track
bytes or failing the request. Pending jobs retry every 30 seconds (longer than the
15-second permission cache), then resume automatically when permitted. Repeating
Download while pending coalesces with that request. The Firefox save control and
Saved list show the wait reason and keep polling. This is admission before a save,
not mid-transfer enforcement; ordinary playback buffering is unchanged.

ffmpeg copies the video/audio codecs without re-encoding into:

```text
<root>/<Channel>/<Title> [<videoId>].mp4
<root>/<Channel>/<Title> [<videoId>].mp4.info.json
```

H.264 plus AAC uses MP4; other codecs use MKV and `.mkv.info.json`. Sidecars include
id, title, channel, duration, bytes, savedAt, quality, codecs and the media filename.
Names replace exFAT-forbidden/control characters, avoid reserved/hidden names and
trailing dots/spaces, and remain below 255 UTF-16 units including the id/extension.
The original display names remain in metadata. The saved library is discovered
from valid sidecars and existing regular media files, not from filenames alone.

The cache is removed after promotion. **Exception:** when mpv still reads those
original streams, removal waits until that playback closes; muxed-file byte
offsets cannot safely replace the live proxy's original offsets. Deleting a saved
video unlinks its media and sidecar, without interrupting an already open local
playback. A currently running download must finish before Delete is accepted.

## HTTP contract

`GET /api/status` preserves existing fields and adds:

- `source`: `"web"`, `"cache"`, `"saved"`, or `null` with no current video.
  `web` includes a stream being buffered by the proxy; `cache` means a complete
  on-disk selection; `saved` means a promoted library file.
- `download`: `null` or `{state, progress, error}` for the current video. States
  are `waiting`, `downloading`, `finalizing`, `saved`, `error`; progress is 0–1 or null
  while the size is unknown. `error` is a safe message or null; for `waiting` it
  explains the queue/permission hold rather than a failure.
- `library`: `{available: boolean}`, refreshed against the mount for each status
  request. The space floor does not make an otherwise readable library unavailable.

`POST /api/control` accepts:

- `{"action":"download"}` for the current video.
- `{"action":"download","id":"abcdefghijk"}` for any video id.
- `{"action":"delete_saved","id":"abcdefghijk"}` to delete a saved video.

Accepted controls return HTTP 200 with `{action, done}`; Download acknowledges
acceptance, not completion. Poll status/library for completion. Invalid ids return
400; missing storage returns 503; low space or no selected video returns 409 with
`{error}`. Deleting an absent saved video returns `done:false`.

`GET /api/library` returns `{available, freeBytes, channels, downloads}`. With no
mount, freeBytes is null and channels is empty. Channels are case-insensitively
sorted `{channel, videos}` objects. Videos sort newest savedAt first and contain
exactly `{id, title, channel, duration, bytes, savedAt}`. Downloads contain
`{id, title, state, progress, error}` for this process's jobs and interrupted marked
entries discovered on startup. Saved videos play or queue through the existing
cast/queue endpoints by id; there is no second playback API.
