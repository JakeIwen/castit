#!/bin/zsh
set -eu -o pipefail
cd "${0:A:h}"
command -v node >/dev/null || { print -u2 'Van TV Shortcut build requires Node.js.'; exit 1; }
[[ -x /usr/bin/shortcuts ]] || { print -u2 'Signing requires macOS with Shortcuts.'; exit 1; }
node generate.mjs
/usr/bin/plutil -lint 'dist/Van TV.plist'
/usr/bin/plutil -convert binary1 -o 'dist/Van TV.unsigned.shortcut' 'dist/Van TV.plist'
# Do not leave an older signed file looking like the result of a failed rebuild.
/bin/rm -f 'dist/Van TV.shortcut'
/usr/bin/shortcuts sign --mode anyone --input 'dist/Van TV.unsigned.shortcut' --output 'dist/Van TV.shortcut'
printf '%s\n' "$PWD/dist/Van TV.shortcut"
