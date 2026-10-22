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

## Contracts

| What | Caller |
|---|---|
| `/home/pi/youtube-cast/` releases, `youtube-cast.service`, state in `/home/pi/.local/state/youtube-cast/` | the live Pi install; `youtube/receiver/deploy.sh` owns them |
| `/home/pi/youtube-cast/current/controller.sh update-ytdlp` | the Pi's weekly crontab line |
| DIAL port 8794, status/API port 8795, `/api/status`, `/api/control`, `/api/cast`, `/api/queue` | the extension, `vantv.zsh`, and the Pi shell's `vantv_*` functions (in `JakeIwen/scripts` `pi/.bashrc`) that route BTT media buttons |
| extension ID from `senders.extensionId` | installed Firefox add-on; changing it installs a separate add-on |
| `youtube/vantv.zsh` | the Mac `vantv` alias in `~/.zshrc` |

## Where things live

- `youtube/receiver/src/`: `index.mjs` is the stable service entry.
  `config/local-config.mjs` is the one reader/validator of `local.json`'s
  `receiver` section; `config/receiver-config.mjs` owns ports, player tuning
  and derived commands. `playback/player.mjs` owns the MpvPlayer,
  `playback/mpv/ipc.mjs` and `playback/mpv/process.mjs` its IPC/process,
  and `playback/sponsor-block.mjs` SponsorBlock.
  `host/process-command.mjs` owns bounded subprocess groups, also used by
  playback; `host/room-preparation.mjs` owns the optional pre-cast command
  and screen wake; `host/vlc-handoff.mjs` owns the optional local player stop.
  `storage/private-data-store.mjs` preserves screen identity and settings
  (volume, speed, A/V offset); `pairing/stable-dial-uuid.mjs` preserves the
  SSDP UUID and `pairing/pairing-codes.mjs` owns TV codes.
  `youtube/video-id.mjs` is the one video-id check.
  `controls/player-controls.mjs` owns `/api/control` and `/api/queue` actions;
  `queue/cast-queue.mjs` owns the queue for senders without a phone session
  and its title lookup; `http/status-server.mjs` owns HTTP.
  `lifecycle/receiver-lifecycle.mjs` coordinates receiver lifetime;
  `lifecycle/unhandled-message-log.mjs` keeps the one library log line
  (unhandled sender message names).
  Receiver tests mirror the feature folders; playback fixtures live beside
  playback tests. `deploy.sh` (Mac) stages a release and `controller.sh`
  (Pi) installs it.
- `youtube/firefox/`: `build/generate-config.mjs` validates `senders` and
  generates the manifest (from `manifest.template.json`) and root
  `local-config.js`; `build.zsh` writes folder-preserving `dist/van-tv.xpi`
  and unpacked `dist/extension/`. Root `config.js` owns extension-wide
  vocabulary. `background/page.html` loads local config before
  `background/main.mjs`; `background/receiver-client.mjs` owns HTTP,
  `background/video-details.mjs` channel name, avatar and subscriber
  lookups, `background/tab-casting.mjs` playhead handoff, and
  `background/actions.mjs` messages, menus and shortcuts.
  `youtube/video-url.mjs` owns URL parsing for background and popup.
  `content/player-button.js` and `content/player-button.css` own the
  player button; `popup/popup.html`, `popup/popup.mjs`, `popup/state.mjs`
  and `popup/popup.css` own the toolbar remote. `theme/tokens.css` owns
  shared design tokens. `tests/` mirrors the feature folders, with the
  receiver fixture beside its background tests.
- `youtube/vantv.zsh`: the Mac CLI over the same HTTP API.
