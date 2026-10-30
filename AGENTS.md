# castit

Public repository `JakeIwen/castit`; local checkout `~/dev/castit`. Van TV was
extracted from `JakeIwen/scripts` (`pi/projects/youtube-cast`,
`macbook/firefox/van-tv`, `macbook/scripts/vantv.zsh`) with fresh history.
Never commit private operational context: hostnames, LAN addresses, extension
IDs and personal integrations belong in the ignored `youtube/local.json`
(template `youtube/local.example.json`).

## Test suite

`zsh run_tests.sh` runs everything and exits nonzero on the first failure.
Tests use `local.example.json` through `CASTIT_LOCAL_CONFIG`, so they pass in
a clean checkout.

## Visual guide

The user guide for Van TV is `static/guides/castit-youtube.html` in
`~/dev/visual-guides` (public repo `JakeIwen/visual-guides`; follow its
AGENTS.md). Any change here that a user would notice (controls, menus, CLI
commands, API, setup or deploy steps, defaults, Sonos/room behavior) updates
that guide in the same piece of work: edit the affected section, its mock-up or
diagram if they show it, and the `Updated` date on the page and in
`static/index.html`. Then commit, push and `npm run deploy` there, as that repo
directs. Internal refactors and test-only changes don't need a guide edit. The
guides repo is public: `vanpi` host names are fine (other guides use them), but
keep IP addresses, extension IDs, cookies and other private details out.

## Contracts

| What | Caller |
|---|---|
| `/home/pi/youtube-cast/` releases, `youtube-cast.service`, state in `/home/pi/.local/state/youtube-cast/` | the live Pi install; `youtube/receiver/deploy.sh` owns them |
| `/home/pi/youtube-cast/current/controller.sh update-ytdlp` | the Pi's weekly crontab line |
| DIAL port 8794, status/API port 8795, `/api/status`, `/api/control`, `/api/cast`, `/api/queue` | the extension, `vantv.zsh`, and the Pi shell's `vantv_*` functions (in `JakeIwen/scripts` `pi/.bashrc`) that route BTT media buttons |
| `/api/library` and `receiver.videoStore` | saved-video senders; `youtube/receiver/src/video-store/video-store.mjs` owns the mounted store, with no fixed proxy port |
| the store's folder name `van-tv` at the root of the EXFAT512 drive | the Pi's daily EXFAT snapshot excludes `/van-tv/` (`JakeIwen/scripts` `pi/scripts/backup/exfat_snapshot.sh`); renaming or moving the store needs that exclusion changed too, or videos land in the hdd1tb snapshots |
| extension ID from `senders.extensionId` | installed Firefox add-on; changing it installs a separate add-on |
| `youtube/vantv.zsh` | the Mac `vantv` alias in `~/.zshrc` |
| an `mpv` process exists only while a video is loaded or playing | the Pi's labwc idle-blanking hook `~/.config/labwc/blank-when-idle.sh` (source in `JakeIwen/scripts` `pi/configs/labwc/`, installed by `pi/sync_scripts.sh`), which holds the screen on while `pgrep -x mpv` matches |

## Where things live

- `youtube/receiver/src/`: `index.mjs` is the stable service entry.
  `config/local-config.mjs` is the one reader/validator of `local.json`'s
  `receiver` section; `config/receiver-config.mjs` owns ports, player tuning
  and derived commands. `playback/player.mjs` owns the MpvPlayer,
  `playback/mpv/ipc.mjs` and `playback/mpv/process.mjs` its IPC/process,
  and `playback/sponsor-block.mjs` SponsorBlock. `playback/stream-resolver.mjs`
  runs yt-dlp ahead of mpv and caches direct stream and subtitle URLs by video/language/quality until they expire,
  `playback/subtitles.mjs` owns subtitle settings, validation and track selection;
  `playback/subtitle-playback.mjs` owns live subtitle loading and status;
  `playback/quality.mjs` owns quality choices, validation and format policy,
  `playback/quality-playback.mjs` owns saved-selection changes and reload status,
  `playback/diagnostics.mjs` owns the playback diagnostics contract and cautious
  cause classification; `playback/mpv/diagnostics.mjs` samples mpv without overlapping polls,
  `playback/queue-prefetch.mjs` resolves the next queued video during
  playback, and `playback/load-timing.mjs` logs per-phase load times;
  `playback/load-progress.mjs` owns live load phases and recent successful timing estimates.
  `video-store/video-store.mjs` is the disk-video feature's public playback/API boundary;
  `contracts.mjs` owns source/download vocabulary and track/cache metadata, `store-disk.mjs`
  the mount/space/path guard, `cache-entries.mjs` sparse entry metadata, `ranges.mjs`
  interval arithmetic, `range-transfer.mjs` shared byte fetching and URL refresh,
  `caching-proxy.mjs` the ephemeral loopback HTTP adapter, `cache-retention.mjs`
  expiry, `video-downloads.mjs` background jobs, and `saved-library.mjs` muxing,
  exFAT names and saved-file discovery. Store tests use real HTTP/disk/ffmpeg;
  `docs/video-store.md` documents storage, offline limits and the API.
  `history/watch-history.mjs` marks videos watched on the signed-in account
  after real playback (opt-in via the cookie file that
  `push-youtube-cookies.zsh` installs); `history/ytdlp-history.mjs` is its
  yt-dlp adapter and failure vocabulary.
  `host/process-command.mjs` owns bounded subprocess groups (`runCommand`,
  and `runCommandOutput` for captured output), with `CommandTimeoutError`
  distinguishing an exhausted budget from ordinary command failure; playback
  must not repeat a timed-out extraction through mpv's hook. Also used by
  history; `host/room-preparation.mjs` owns the screen wake and the
  optional idempotent room check run ~1.5 s after each start and resume; `host/vlc-handoff.mjs` owns the optional local player stop.
  `storage/private-data-store.mjs` preserves screen identity and settings
  (volume, speed, quality, subtitles, A/V offset); `pairing/stable-dial-uuid.mjs` preserves the
  SSDP UUID and `pairing/pairing-codes.mjs` owns TV codes.
  `youtube/video-id.mjs` is the one video-id check; `youtube/video-url.mjs`
  parses shared YouTube links and timestamps for casting and queueing;
  `youtube/video-title.mjs` normalizes sender/queue titles and identifies mpv URL placeholders.
  `controls/player-controls.mjs` owns `/api/control` and `/api/queue` actions;
  `queue/cast-queue.mjs` owns the queue for senders without a phone session
  and its title lookup and backward/forward history entries. `MpvPlayer.playPrevious`
  coordinates history navigation and rollback; `MpvPlayer.canPlayNext` supplies
  the status/API navigation availability. `http/status-server.mjs` owns HTTP.
  `lifecycle/receiver-lifecycle.mjs` coordinates receiver lifetime;
  `lifecycle/unhandled-message-log.mjs` keeps the one library log line
  (unhandled sender message names).
  Receiver tests mirror the feature folders; playback fixtures live beside
  playback tests. `deploy.sh` (Mac) stages a release and `controller.sh`
  (Pi) installs it.
- `youtube/firefox/`: `push-youtube-cookies.zsh` runs on the Mac to install
  receiver watch-history cookies. `build/generate-config.mjs` exports `readLocalConfig`
  and `senderConfig`, the shared sender reader/validator for the extension and
  iOS Shortcut; its CLI generates the manifest (from `manifest.template.json`) and root
  `local-config.js`; `build.zsh` writes folder-preserving `dist/van-tv.xpi`
  and unpacked `dist/extension/`. Root `config.js` owns extension-wide
  vocabulary. `background/page.html` loads local config before
  `background/main.mjs`; `background/receiver-client.mjs` owns HTTP,
  `background/video-details.mjs` channel name, avatar and subscriber
  lookups, `background/tab-casting.mjs` playhead handoff, and
  `background/actions.mjs` messages, menus and shortcuts.
  `youtube/video-url.mjs` owns URL parsing for background and popup;
  `youtube/video-title.js`, a classic script, cleans sender titles for both
  the content script and background modules.
  `content/player-button.js` and `content/player-button.css` own the
  player button; `popup/popup.html`, `popup/popup.mjs` and `popup/popup.css`
  own the toolbar-opened sidebar remote. `popup/queue-list.mjs` owns its combined queue/history
  list, anchoring and drag interactions; `popup/state.mjs` owns pure popup
  state, list models and reorder math; `popup/quality-selector.mjs` and its
  colocated CSS own the capability-driven quality menu. `popup/dom-state.mjs`
  applies only changed DOM values so background polls leave the rendered UI stable.
  `playback/diagnostics.mjs` validates telemetry entering the extension;
  `popup/playback-messages.mjs` and its CSS own the collapsible Info section,
  including buffering explanations and active warning symbols.
  `popup/load-progress.mjs` and its CSS own the load phase, elapsed time and
  estimate bar that replace the seek bar while a video loads.
  `playback/video-store.mjs` validates source, download and library responses;
  `popup/saved-state.mjs` owns their pure labels/list models.
  `popup/saved-videos.mjs` and its CSS own the collapsible Saved browser,
  inline deletion confirmation and on-demand/active-download refresh;
  `popup/download-control.mjs` and its CSS own the current-video save button.
  `theme/tokens.css` owns
  shared design tokens. `tests/` mirrors the feature folders, with the
  receiver fixture beside its background tests.
- `youtube/ios-shortcut/`: `build.zsh` generates and signs one dialog-free
  share-sheet Shortcut per command (`dist/Van TV Cast.shortcut`,
  `dist/Van TV Queue.shortcut`); `workflow.mjs` owns the commands and the
  action list, `workflow-format.mjs` the Shortcuts plist vocabulary,
  `generate.mjs` the config-driven CLI. The receiver finds the link inside
  the shared text, so the Shortcut does no URL detection.
- `youtube/vantv.zsh`: the Mac CLI over the same HTTP API.
