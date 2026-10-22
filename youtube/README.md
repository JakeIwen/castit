# Van TV

Cast YouTube videos to a Raspberry Pi that plays them in mpv, without ads.
Phones and the YouTube site pair with it like a TV (DIAL/Lounge), and a small
HTTP API on port 8795 lets other senders cast and control playback directly.

| Path | Role |
|---|---|
| [`receiver/`](receiver/README.md) | The Pi service: pairing, mpv playback, SponsorBlock skips, A/V offset, status page |
| [`firefox/`](firefox/README.md) | Firefox extension: cast button on YouTube, context menu, toolbar remote |
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

## `vantv`

```sh
vantv [youtube-url]          # cast a link; default: front Chrome/Safari tab, then clipboard
vantv pause|resume|stop|status
vantv delay [+ms|-ms|ms]     # show, nudge or set the A/V offset (+ plays sound later)
```

Alias it to `youtube/vantv.zsh`; it reads `local.json` beside itself, or the
URL in `VAN_TV`.
