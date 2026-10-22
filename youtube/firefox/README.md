# Van TV Firefox extension

Cast YouTube videos and their playback position to the [receiver](../receiver/README.md),
or control playback from the toolbar popup. Requires a reachable receiver with
`/api/status`, `/api/cast` and `/api/control`; no YouTube pairing or account is used.

## Configure and build

From this directory:

```sh
cp ../local.example.json ../local.json
```

Edit `senders` in `../local.json`:

- `receiverUrls`: non-empty array of HTTP(S) receiver base URLs, primary first.
  Additional URLs are read-failure fallbacks. Omit credentials, query strings
  and fragments; the receiver's status port is normally 8795.
- `extensionId`: non-empty Firefox extension ID. Choose your own ID for a new
  installation and keep it unchanged so later builds update the same add-on.

`local.json` is ignored by Git. To use another file, set `CASTIT_LOCAL_CONFIG`;
relative paths resolve from this directory when building.

```sh
zsh build.zsh
```

Requires Node.js and the macOS `/usr/bin/zip`; no npm packages are needed.
The builder validates the config, generates `manifest.json` from
`manifest.template.json`, and writes receiver addresses into `local-config.js`.
Only the background page needs these addresses. Outputs are:

- `dist/van-tv.xpi`: unsigned installable archive.
- `dist/extension/`: unpacked extension for temporary development loads.

Both outputs contain your local addresses and extension ID. `dist/` is ignored
by Git; review those values before sharing a build. Bump the version in
`manifest.template.json` for each published update.

## Install in Firefox Developer Edition

1. In `about:config`, set `xpinstall.signatures.required` to `false`.
   This allows unsigned extensions generally; install only add-ons you trust.
   Release Firefox does not support this installation route.
2. On macOS, open the install prompt:

   ```sh
   open -a "Firefox Developer Edition" dist/van-tv.xpi
   ```

   Alternatively, use `about:addons` → gear menu → **Install Add-on From File…**.
   Accept the permissions and optionally pin Van TV to the toolbar.
3. Reload already-open YouTube tabs after installing or updating.

The preference and confirmation dialogs have no supported Firefox CLI.
Rebuild and install the XPI again after source or configuration changes.

## Temporary development load

Build first, then open `about:debugging#/runtime/this-firefox`, choose
**Load Temporary Add-on…**, and select `dist/extension/manifest.json`.
No signature preference change is needed; this install lasts until Firefox exits.
After edits, rebuild, click **Reload** for the extension, then reload YouTube.
**Inspect** opens the background console.

## Controls

- The YouTube player's **Van TV** button casts the current playhead. Local
  playback pauses only after the receiver accepts the request. Green feedback
  means accepted, not that receiver playback has started; errors appear on hover.
- Right-click a YouTube video link or watch-page background → **Add to Queue**
  queues it from the beginning and leaves the tab playing; with nothing playing,
  it starts at once. **Cast** follows it in the menu, starting a linked video at
  its URL's timestamp (or the beginning), or casting the watch page's playhead.
- The popup's title opens the video on YouTube; under it, the channel's avatar,
  name, verified badge and subscriber count link to the channel.
- The toolbar popup shows state, title and a scrubber. Drag or use arrow keys
  to seek; click total time to toggle remaining time. Controls include
  previous/next, play/pause, ±20 seconds, ±5 minutes, restart and stop.
  **Cast this tab** also accepts short links, shorts, live and embed URLs;
  without a content script, it uses the URL's start time and cannot pause the page.
- **Volume** steps by 5 and mutes; **Speed** steps by 0.25× and resets to 1×.
- **A/V offset** nudges the receiver's saved offset by 50 ms or resets it.
  Use minus when voices come after lips move. Volume, speed and offset are saved
  on the receiver and work without a loaded cast.
- **Queue** is one scrolling list: played videos above the highlighted current
  video, then upcoming videos. It opens at the current video (or first upcoming
  video), with a little history peeking above. Scroll up for earlier videos;
  polling leaves your scroll position alone until the current video changes.
  Click a played title to replay from the start, or an upcoming title to play now.
  × removes an upcoming video; **Clear** removes upcoming videos only.
  **Queue this tab** adds the active tab's video.
- Each row's external-link button opens YouTube and closes the popup. **⌘/Ctrl-click**
  or **middle-click** a played/upcoming title to open YouTube in a background tab
  without closing the popup or changing receiver playback.
- Drag an upcoming row's grip to reorder it; the list scrolls near its edges and
  **Escape** cancels. With an upcoming row or one of its controls focused,
  **Alt+ArrowUp/Down** moves it one place instead.
- The state pill shows animated **Working…** while loading or awaiting a request;
  reduced-motion settings keep the indicator static. Older receivers without
  played history still show the current video and their upcoming queue.
- **Alt+Shift+V** (Option+Shift+V on Mac) casts the active YouTube tab.
  Reassign it in `about:addons` → gear menu → **Manage Extension Shortcuts**.
  Shortcut/menu failures put `!` on the toolbar; open the popup for details.

## Permissions and network behavior

- `contextMenus`: video-link and watch-page cast and queue menus.
- `tabs`: active-tab URL for casting and URL-only fallback; no saved history.
- `https://www.youtube.com/*`: the background page reads the playing video's
  channel (oEmbed for name and link, the channel page once per channel for
  avatar, subscriber count and verified badge) without cookies. The avatar
  image loads from YouTube's image host.
- Receiver host permissions are derived from `receiverUrls`, preserving HTTP
  or HTTPS. Firefox host patterns cannot restrict access to a particular port;
  requests use only the configured base URLs.
- Content scripts run on `*://www.youtube.com/*` and send extension messages,
  not HTTP requests. No web-accessible resources, cookies, storage, downloads,
  scripting or notification permission is declared.

Only the background page performs HTTP. Failed reads can try another configured
URL; an ambiguous POST failure is never retried, preventing duplicate writes.
Requests omit cookies, reject redirects and time out. Receiver text is never
rendered as HTML. The receiver must allow absent, `null` or `moz-extension://`
origins for JSON POSTs. These unauthenticated endpoints belong on a trusted
network, not the public internet.

## Files and tests

`build/generate-config.mjs` owns config validation and generation; root `config.js`
owns extension-wide YouTube patterns, messages and controls. `background/page.html`
loads the generated root `local-config.js` before `background/main.mjs`.
`background/receiver-client.mjs` owns HTTP, `background/video-details.mjs` owns
YouTube channel lookups, `background/tab-casting.mjs` handles playhead handoff and
tab queuing, and `background/actions.mjs` handles messages, menus and shortcuts.
`youtube/video-url.mjs` parses URLs for the background and popup contexts.
`content/player-button.js` and `content/player-button.css` own the player button;
`popup/popup.html`, `popup/popup.mjs` and `popup/popup.css` own the toolbar popup.
`popup/queue-list.mjs` owns queue/history rendering, anchoring and drag interactions;
`popup/state.mjs` owns pure view state and reorder math. Shared colors and sizes
live in `theme/tokens.css`. `tests/` mirrors these feature folders; the receiver
fixture lives beside its background tests.
`build.zsh` keeps the same feature folders in both packaged outputs.

```sh
node --test 'tests/**/*.test.mjs'
```

Tests need no private `local.json` or running receiver. Packaging tests set
`CASTIT_LOCAL_CONFIG` themselves and build in temporary checkouts; HTTP tests
use loopback servers. They cover menu titles/order, history decoding, move
validation/message routing, combined list models, working state and reorder math.
For Firefox acceptance, check the player button across YouTube navigation,
playhead handoff, popup controls, history anchoring, drag/autoscroll/Escape,
Alt+Arrow reordering, modified/middle-click links, keyboard shortcut, read
failover and unreachable-receiver errors on your network.
