# Van TV Shortcut

From iPhone Safari (or another app), **Share → Van TV → Cast / Add to Queue**.
No YouTube app is needed. The Shortcut accepts URLs, Safari pages and shared
text, extracts the first URL and sends it to the receiver. Running Van TV
directly asks for a link, with the clipboard as the suggested answer. With no
URL it shows an alert and stops without sending a request.

## Build on the Mac

Requires Node.js and macOS's `/usr/bin/plutil` and `/usr/bin/shortcuts`.
There are no npm dependencies. Configure `youtube/local.json` using
[`local.example.json`](../local.example.json), then run from the repository root:

```sh
zsh youtube/ios-shortcut/build.zsh
```

The generator uses **only the first** `senders.receiverUrls` entry, including
any base path. It reuses the Firefox generator's exported `readLocalConfig`
and `senderConfig`; therefore the shared config also requires `extensionId`.
`CASTIT_LOCAL_CONFIG` overrides the config path (relative paths are resolved
from `youtube/ios-shortcut/` by the build script). For an example-only build:

```sh
CASTIT_LOCAL_CONFIG=../local.example.json zsh youtube/ios-shortcut/build.zsh
```

The build writes to the already Git-ignored `dist/` directory:

- `Van TV.plist`: inspectable XML workflow.
- `Van TV.unsigned.shortcut`: binary plist for signing, **not installable**.
- **`Van TV.shortcut`**: signed, installable file.

Signing runs `shortcuts sign --mode anyone`. Apple may require internet access
and a working Apple Account/iCloud setup for signing; the script stops and
prints the actual error if signing fails. An older signed output is removed
before signing so a failed rebuild cannot leave a stale installable file.

**All outputs contain the private receiver address.** Do not commit or publish
them; share the signed file only with people who should know that address.
Rebuild and reinstall if the receiver address changes. The source and tests
use no install-specific addresses.

## Install on the iPhone

1. Send `youtube/ios-shortcut/dist/Van TV.shortcut` to the iPhone with AirDrop,
   or put it in iCloud Drive and open it from the iPhone's Files app. Another
   file-transfer method that makes the file available in Files also works.
2. Tap the file, review the actions, then tap **Add Shortcut**. Installation
   requires the phone's Shortcuts UI; there is no supported CLI route.
3. In Safari, open a YouTube video, tap **Share**, then **Van TV**. If it is
   missing, use the share sheet's **Edit Actions** to enable/add Van TV. The
   Shortcut's details should have **Show in Share Sheet** enabled.
4. Choose **Cast** to play now or **Add to Queue** to append. Allow local
   network/receiver access, clipboard access (direct runs) and notifications
   if iOS asks.

The phone **must be able to reach the receiver**, normally on the van Wi-Fi.
This does **not** work when this same phone is providing the hotspot. It does
not add remote access, a tunnel, authentication or an internet-facing endpoint.
The receiver must include the URL-input API support described in its
[HTTP API docs](../receiver/README.md#http-api-settings-and-queue).

## Outcomes and limitations

- Cast sends `POST /api/cast` with `{"url":"<first URL>"}`. A response containing
  `videoId` produces **Casting on Van TV**; this acknowledges acceptance, not
  that playback has already started.
- Add to Queue sends `POST /api/queue` with
  `{"action":"add","url":"<first URL>"}`. `done:true` produces **Added to the
  Van TV queue**; `done:false` produces **The Van TV queue is full**.
- Both use `Content-Type: application/json`, with no `Origin` header. A returned
  JSON `error` is shown in a notification, then execution stops. Missing result
  fields produce **Van TV returned an unexpected response**, not success.
- **Native Shortcuts cannot catch Get Contents of URL transport failures.**
  DNS failure, timeout, refused connection or denied network permission stops
  execution with Apple's error rather than a custom notification. Interpret
  that as **Van TV unreachable — are you on the van Wi-Fi?** This hint is also
  in the workflow's opening comment. An iOS version that raises an action error
  for HTTP 4xx/5xx instead of returning the JSON body likewise shows Apple's
  error. There is no fabricated continue-on-error parameter or extra app.

## Verification

From the repository root:

```sh
zsh run_tests.sh
```

The Node tests build in a clean temporary checkout with `local.example.json`,
validate the generated workflow's share-sheet types, input/URL/menu ordering,
POST bodies and variable references, error/success branches, primary config
selection and rejection of invalid configs. They round-trip XML → binary →
XML with plutil. **The suite never signs or runs the Shortcut** and needs no
Apple Account, phone or live receiver.

Signing proves the file can be signed, not that every action works on iOS.
Phone checks still needed: import/name/icon; Safari share sheet and shared text
with multiple links; direct input with and without a clipboard link; no URL;
Cast and Add to Queue on the receiver; queue-full and JSON-error responses;
notifications/permissions and an unreachable receiver. Only the first extracted
URL is used, even if a later URL is the YouTube link.

## Format references

The generator emits Apple's `WFWorkflow` plist format, not a third-party
runtime. The native action identifiers all use `is.workflow.actions.`:
`conditional`, `getvariable`, `getclipboard`, `ask`, `detect.link`,
`getitemfromlist`, `alert`, `exit`, `choosefrommenu`, `downloadurl`,
`getvalueforkey`, `notification`, and `comment`.

References used to check the serialized action parameters:

- [Shortcuts format reference](https://github.com/sebj/iOS-Shortcuts-Reference):
  workflow metadata, share-sheet input types and RGBA icon colors.
- [Cherri web actions](https://github.com/electrikmilk/cherri/blob/main/actions/web.cherri):
  `detect.link` with `WFInput`; `downloadurl` with `WFURL`, `WFHTTPMethod`,
  `WFHTTPBodyType`, `WFJSONValues` and `WFHTTPHeaders`.
- [Cherri basic actions](https://github.com/electrikmilk/cherri/blob/main/actions/basic.cherri):
  first-item selection, dictionary lookup, alert, notification and exit keys.
- [Cherri workflow serialization](https://github.com/electrikmilk/cherri/blob/main/shortcutgen.go)
  and [types/condition codes](https://github.com/electrikmilk/cherri/blob/main/shortcut.go):
  menu and conditional grouping with `WFControlFlowMode` 0/1/2, equality 4,
  has-value 100 and no-value 101; `WFTextTokenString`, action-output attachments
  and `WFDictionaryFieldValue` JSON bodies. The [glyph map](https://github.com/electrikmilk/cherri/blob/main/glyphs.go)
  supplies TV glyph 59851; the icon is red (4282601983).
- [ScPL Get Contents of URL](https://docs.scpl.dev/actions/getcontentsofurl)
  and [Choose from Menu](https://docs.scpl.dev/actions/choosefrommenu): independent
  action-identifier and parameter cross-checks.

The Ask for Input and If action shapes were additionally compared with
read-only decoded action plists from an existing Mac Shortcuts library. No
library changes, imports or GUI launches are part of the build.
