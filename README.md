# castit

Self-hosted cast receivers for a Raspberry Pi and the senders that drive them.

| Folder | What it is |
|---|---|
| [`youtube/`](youtube/README.md) | Van TV: an ad-free YouTube cast receiver (mpv on the Pi), a Firefox extension and a `vantv` CLI |

## Setup

Each project reads install-specific values (hostnames, LAN addresses, local
integrations) from an ignored `local.json`. Copy the project's
`local.example.json` and edit it before building or deploying.

## Tests

```sh
zsh run_tests.sh
```

Needs Node.js 20 or later and macOS (the extension build uses `/usr/bin/zip`).
