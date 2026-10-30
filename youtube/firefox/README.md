# Van TV Firefox extension

Cast YouTube videos and their playback position to the [receiver](../receiver/README.md),
or control playback from the toolbar-opened sidebar. Requires a reachable receiver with
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
- Right-click a YouTube video link or watch-page background for
  **Van TV: Cast Now (Shift: Add to Queue)**. A plain click casts now, replacing
  playback and preserving a link's timestamp or the page's playhead; page
  playback pauses after acceptance. **Shift-click** adds to the queue instead:
  it inserts next from the beginning and leaves the tab playing, and starts
  immediately when the receiver is idle or stopped. Both open the sidebar.
  **Save on Van TV** saves the page or link's video without interrupting playback.
  Firefox groups these two items into a submenu. The queue and played history persist across Stop and restarts;
  they never start by themselves.
- Cast and queue requests include a title when one is available, so updated receivers
  show it while the stream loads. Player/tab casts prefer the watch page's title,
  falling back to the tab title without YouTube's suffix or notification count;
  tab queueing uses that cleaned tab title. Link menus use link text, ignoring
  blank or duration-only thumbnail labels. Titles are plain text capped at 200
  characters; older receivers can ignore the optional field.
- **Info** expands playback diagnostics, action messages and watch-history issues.
  A warning symbol remains visible when collapsed. Buffering is confirmed from
  mpv; bandwidth is described as a suspicion only after repeated low-rate samples.
  Rendering/decoding drops and unknown buffering causes have separate messages.
  Measurements show buffered seconds, incoming rate and estimated demand. Older
  receivers get an explicit update message instead of invented diagnostics.
- The sidebar's title opens the video on YouTube; under it, the channel's avatar,
  name, verified badge and subscriber count link to the channel.
  The toolbar button toggles the full-height browser sidebar; the queue uses the remaining height
  and scrolls only when its entries do not fit. Routine polling updates changed
  values without flashing the activity indicator or rebuilding unchanged rows.
- The sidebar shows state, title and a scrubber. Drag or use arrow keys
  to seek; click total time to toggle remaining time. Controls include previous/next,
  play/pause, ±20 seconds and stop. Previous walks backward through played videos,
  putting each departed video next in the queue so Next returns to it. It restarts
  the video when nothing came before it. A full upcoming queue prevents moving
  backward until an entry is removed. Next is disabled when there is no next video in the cast or
  phone queue (including enabled phone autoplay). Older receivers fall back to
  the cast queue. Previous, available Next and Stop remain usable during loading; a newer
  navigation cancels unfinished loading. The playhead stops advancing during buffering.
  **Cast this tab** also accepts short links, shorts, live and embed URLs;
  without a content script, it uses the URL's start time and cannot pause the page.
- The download icon beside CC saves the loaded video. Hover for download progress,
  saving, saved or error details; click again to retry an error. It is hidden when
  no video is loaded or the library is unavailable.
- **Saved** expands channel groups (alphabetical), with title, duration and size.
  **Play** casts from the beginning, **Queue** adds the video, and **Delete** asks
  for a second inline confirmation. The section refreshes on opening and after
  actions, and while open downloads are active, not on every playback poll.
  **Info** also shows the current source: saved copy, disk cache or YouTube.
  The Mac CLI has `vantv download [youtube-url|id]` (default: loaded video) and
  `vantv saved` (list by channel).
- Automatic closing on non-YouTube tab navigation is not available in Firefox
  Developer Edition 160: [`sidebarAction.close()` requires a user action](https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/API/sidebarAction/close),
  and the [160 API schema](https://github.com/mozilla-firefox/firefox/blob/FIREFOX_160_0b1_RELEASE/browser/components/extensions/schemas/sidebar_action.json)
  enforces `requireUserInput` for close/open/toggle. Tab events are not such
  handlers. The toolbar button still closes the sidebar directly from its click.
- **CC** toggles the receiver's saved subtitles live, including while idle.
  English is the default language; uploaded captions take priority over automatic
  captions. Hover CC for language, loading, missing-track and failure status. Change language
  on the receiver's status page or with `vantv subs <lang>`; turning CC off keeps it.
  Older receivers without subtitle support leave CC disabled.
- **Quality** selects Auto or a maximum resolution (1080p, 720p, 480p, 360p),
  with explicit choices limited to 30 fps. The receiver saves it and reloads the
  current video at its position, keeping pause and other settings. Auto retains
  the receiver's original format policy. Applying and failure states are shown;
  use Retry after a failed reload. Options come from receiver capabilities, and older
  receivers without quality support leave the selector disabled.
- **Volume** steps by 5 and mutes; **Speed** steps by 0.25× and resets to 1×.
- **A/V offset** nudges the receiver's saved offset by 50 ms or resets it.
  Use minus when voices come after lips move. Volume, speed and offset are saved
  on the receiver and work without a loaded cast.
- **Queue** is one scrolling list: played videos above the highlighted current
  video, then upcoming videos. It opens at the current video (or first upcoming
  video), with a little history peeking above. Scroll up for earlier videos;
  polling leaves your scroll position alone until the current video changes.
  Click a played title to replay from the start, or an upcoming title to play now.
  × removes any row: a played or upcoming video leaves the list, and the current
  video stops and the next queued video starts (playback stops when none is
  queued). **Jump to end** scrolls to the last queued video; **Clear** removes
  every played and upcoming video, leaving the current one playing.
  **Queue this tab** adds the active tab's video.
- Each row's external-link button opens YouTube while keeping the sidebar. **⌘/Ctrl-click**
  or **middle-click** a played/upcoming title to open YouTube in a background tab
  without changing receiver playback.
- Drag an upcoming row's grip to reorder it; the list scrolls near its edges and
  **Escape** cancels. With an upcoming row or one of its controls focused,
  **Alt+ArrowUp/Down** moves it one place instead.
- During loading, updated receivers replace the seek/time area with **Finding the
  stream**, **Starting the player** or **Buffering**, plus elapsed seconds. The clock
  advances between polls. A progress bar uses the receiver's median recent load
  time when available, stops short of completion at 95%, and pulses instead once
  that estimate is exceeded or no estimate exists. This is an estimate, not a
  countdown; the scrubber returns when loading ends. Older receivers without load
  timing keep the normal disabled scrubber.
- The state pill shows **Loading…** during a load and **Working…** while awaiting
  other user actions; reduced-motion settings keep both indicators and the load
  bar static. Older receivers without played history still show the current
  video and their upcoming queue.
- **Alt+Shift+V** (Option+Shift+V on Mac) casts the active YouTube tab.
  Reassign it in `about:addons` → gear menu → **Manage Extension Shortcuts**.
  Shortcut/menu failures put `!` on the toolbar; its tooltip gives the error.

## Permissions and network behavior

- `contextMenus`: the video-link and watch-page cast/queue actions.
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
`youtube/video-title.js` is the classic-script title cleaner shared by background
modules and the content script; it loads before the player button in the manifest.
`content/player-button.js` and `content/player-button.css` own the player button;
`popup/popup.html`, `popup/popup.mjs` and `popup/popup.css` own the sidebar remote.
`popup/queue-list.mjs` owns queue/history rendering, anchoring and drag interactions;
`popup/state.mjs` owns pure view state, load-progress labels/estimates and reorder math.
`popup/load-progress.mjs` and its CSS own the seek-area loading display and clock
interpolation; `background/receiver-client.mjs` validates optional `status.loading`
(`phase`, nonnegative `elapsed` seconds, positive `expected` seconds or `null`).
`popup/quality-selector.mjs` and its CSS own the quality menu. Shared colors and sizes
live in `theme/tokens.css`. `playback/diagnostics.mjs` validates receiver measurements;
`popup/playback-messages.mjs` and its CSS own the collapsible messages and warnings.
`popup/dom-state.mjs` avoids redundant text, attribute
and property writes during polling. `tests/` mirrors these feature folders; the receiver
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
