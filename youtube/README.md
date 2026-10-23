# Van TV

Cast YouTube videos to a Raspberry Pi that plays them in mpv, without ads.
Phones and the YouTube site pair with it like a TV (DIAL/Lounge), and a small
HTTP API on port 8795 lets other senders cast and control playback directly.

| Path | Role |
|---|---|
| [`receiver/`](receiver/README.md) | The Pi service: pairing, mpv playback, SponsorBlock skips, volume, speed, A/V offset, queue, status page |
| [`firefox/`](firefox/README.md) | Firefox extension: cast button on YouTube, cast and queue menus, toolbar remote |
| `vantv.zsh` | Mac CLI: cast a link or the front Chrome/Safari tab, control playback |

## Configure

```sh
cp local.example.json local.json
```

`receiver` holds the Pi's SSH target, trusted hostnames, LAN address, audio
device and optional integrations (a command run before each cast session, a
local video player to stop first); see the receiver README. `senders` holds the
receiver URLs the extension and CLI use, primary first, and the extension ID.
`local.json` is ignored by Git; the deploy script copies it to the Pi.

## Build and deploy

From `youtube/` or `youtube/receiver/`:

```sh
npm run depf
npm run depr
```

`depf` builds the Firefox extension and opens its install prompt in Firefox
Developer Edition. Accept the Firefox confirmation, then reload YouTube tabs.
The confirmation has no supported CLI.

`depr` deploys the receiver through `receiver/deploy.sh install` using
`local.json`: it stages a release on the Pi, installs dependencies there,
restarts the service and waits for health. The receiver runs JavaScript directly,
so it has no separate compilation step.

`npm test` from `youtube/` runs the whole repository suite.

## `vantv`

```sh
vantv [youtube-url]          # cast a link; default: front Chrome/Safari tab, then clipboard
vantv pause|resume|stop|status
vantv delay [+ms|-ms|ms]     # show, nudge or set the A/V offset (+ plays sound later)
vantv vol [+n|-n|n|mute|unmute]  # show, nudge or set the volume (0-100)
vantv speed [+x|-x|x]        # show, nudge or set the playback speed (0.25-3)
vantv queue [youtube-url|list|clear]  # queue a video (same default as casting), list or clear
```

Alias it to `youtube/vantv.zsh`; it reads `local.json` beside itself, or the
URL in `VAN_TV`.
