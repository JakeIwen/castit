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
| DIAL port 8794, status/API port 8795, `/api/status`, `/api/control`, `/api/cast` | the extension, `vantv.zsh`, and the Pi shell's `vantv_*` functions (in `JakeIwen/scripts` `pi/.bashrc`) that route BTT media buttons |
| extension ID from `senders.extensionId` | installed Firefox add-on; changing it installs a separate add-on |
| `youtube/vantv.zsh` | the Mac `vantv` alias in `~/.zshrc` |

## Where things live

- `youtube/receiver/src/local-config.mjs`: the one reader/validator of
  `local.json`'s `receiver` section; `config.mjs` owns ports, player tuning and
  derived commands. `mpv-ipc`/`mpv-process`/`mpv-player` own playback,
  `process-command` bounded subprocess groups, `room-preparation` the optional
  pre-cast command and screen wake, `vlc-handoff` the optional local player
  stop, `private-data-store` screen identity and settings (volume, A/V offset),
  `stable-dial-uuid` the SSDP UUID, `video-id` the one video-id check,
  `player-controls` the `/api/control` actions, `status-server` HTTP.
  `deploy.sh` (Mac) stages a release and `controller.sh` (Pi) installs it.
- `youtube/firefox/`: `build-config.mjs` validates `senders` and generates the
  manifest (from `manifest.template.json`) and `local-config.js`; `build.zsh`
  writes `dist/van-tv.xpi` and unpacked `dist/extension/`. `config.js` owns
  shared vocabulary; `receiver-client.mjs` background-only HTTP;
  `youtube-video.mjs` URL parsing; `tab-casting.mjs` playhead handoff;
  `background-actions.mjs` messages, menus and shortcuts; `content.js` the
  player button; `popup.mjs`/`popup-state.mjs` the toolbar remote.
- `youtube/vantv.zsh`: the Mac CLI over the same HTTP API.
