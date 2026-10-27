#!/bin/zsh
set -eu -o pipefail
cd "${0:A:h}"
# Start clean so a renamed or failed build cannot leave a stale installable file.
/bin/mkdir -p dist
/bin/rm -f dist/*.plist(N) dist/*.shortcut(N)
command -v node >/dev/null || { print -u2 'Van TV Shortcut build requires Node.js.'; exit 1; }
[[ -x /usr/bin/shortcuts ]] || { print -u2 'Signing requires macOS with Shortcuts.'; exit 1; }
node generate.mjs
for plist in dist/*.plist(N); do
  name=${${plist:t}%.plist}
  /usr/bin/plutil -lint "$plist"
  /usr/bin/plutil -convert binary1 -o "dist/$name.unsigned.shortcut" "$plist"
  /usr/bin/shortcuts sign --mode anyone --input "dist/$name.unsigned.shortcut" --output "dist/$name.shortcut"
  printf '%s\n' "$PWD/dist/$name.shortcut"
done
