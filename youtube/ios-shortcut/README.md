# Van TV Shortcuts

Two iPhone share-sheet Shortcuts, **Van TV Cast** and **Van TV Queue**. From
the YouTube app, Safari or anywhere a YouTube link can be shared: **Share →
Van TV Cast** plays it now, **Share → Van TV Queue** appends it. Run directly
from the Shortcuts app, either one uses the link on the clipboard.

Each Shortcut is a straight line of actions with no menu, prompt or alert: it
sends whatever was shared, as text, to the receiver, which finds the YouTube
link inside it. That keeps the Shortcut testable on the Mac (`shortcuts run`)
and leaves link parsing to code the test suite covers. A failed request shows
the receiver's error as a notification, including a preview of what arrived.

## Build on the Mac

Requires Node.js and macOS's `/usr/bin/plutil` and `/usr/bin/shortcuts`.
There are no npm dependencies. Configure `youtube/local.json` using
[`local.example.json`](../local.example.json), then run from the repository root:

```sh
zsh youtube/ios-shortcut/build.zsh
```

The generator uses **only the first** `senders.receiverUrls` entry, including
any base path; the remaining entries are not tried as fallbacks. Put the Pi's
Tailscale URL first to use it both on and away from the van LAN. It reuses the Firefox generator's exported `readLocalConfig`
and `senderConfig`; therefore the shared config also requires `extensionId`.
`CASTIT_LOCAL_CONFIG` overrides the config path (relative paths are resolved
from `youtube/ios-shortcut/` by the build script). For an example-only build:

```sh
CASTIT_LOCAL_CONFIG=../local.example.json zsh youtube/ios-shortcut/build.zsh
```

The build empties and refills the Git-ignored `dist/` directory with, per
Shortcut:

- `<name>.plist`: inspectable XML workflow.
- `<name>.unsigned.shortcut`: binary plist for signing, **not installable**.
- **`<name>.shortcut`**: signed, installable file.

Signing runs `shortcuts sign --mode anyone`. Apple may require internet access
and a working Apple Account/iCloud setup for signing; the script stops and
prints the actual error if signing fails.

**All outputs contain the private receiver address.** Do not commit or publish
them; share the signed files only with people who should know that address.
Rebuild and reinstall if the receiver address changes. The source and tests
use no install-specific addresses.

## Install

Shortcuts sync through iCloud, so the easiest route is the Mac:

1. Open the two signed files:

   ```sh
   open "youtube/ios-shortcut/dist/Van TV Cast.shortcut"
   open "youtube/ios-shortcut/dist/Van TV Queue.shortcut"
   ```

   Click **Add Shortcut** in each window. There is no CLI import.
2. The two Shortcuts appear on the iPhone within a minute or so (open the
   Shortcuts app there to nudge the sync). Delete any older **Van TV**
   Shortcut first; a re-import never replaces one in place.
3. In the YouTube app or Safari, open a video, tap **Share**, then **Van TV
   Cast** or **Van TV Queue**. If they are missing, use the share sheet's
   **Edit Actions** to add them. Allow local network access and notifications
   if iOS asks.

AirDrop or iCloud Drive plus **Files → tap the file → Add Shortcut** on the
phone also works.

The phone **must be able to reach the receiver**. For a Tailscale URL, connect
both the phone and Pi to the same tailnet and configure the receiver's
`tailscaleAddress`. Traffic can go directly over the van LAN when both devices
are there, and work remotely otherwise. A LAN-only URL needs a reachable LAN
route and does not work when this same phone is providing the hotspot. Neither
Shortcut needs the YouTube app.

## Test on the Mac

Once installed, the same Shortcuts run headlessly here against the live
receiver; `-i` passes a file whose text is the shared link:

```sh
printf 'https://youtu.be/VIDEO_ID\n' > /tmp/link.txt
shortcuts run 'Van TV Queue' -i /tmp/link.txt
```

Success and failure both arrive as a macOS notification; `/api/status` on
the receiver shows the queue.
