#!/bin/zsh
set -eu -o pipefail
cd "${0:A:h}"
command -v node >/dev/null || { print -u2 'Van TV build requires Node.js.'; exit 1; }
mkdir -p dist
staging=$(/usr/bin/mktemp -d "$PWD/dist/.build.XXXXXX")
trap '/bin/rm -f "$staging"/*(N.); /bin/rmdir "$staging"' EXIT
node build-config.mjs "${CASTIT_LOCAL_CONFIG:-../local.json}" "$staging"
/bin/cp background.html popup.html config.js content.js *.css icon.svg "$staging/"
for file in *.mjs; do
  [[ $file == build-config.mjs ]] && continue
  /bin/cp "$file" "$staging/"
done
(
  cd "$staging"
  /usr/bin/zip -X -q van-tv.xpi manifest.json background.html popup.html *.mjs *.js *.css icon.svg
)
# Publish only after validation and packaging succeed; these outputs contain local config.
mkdir -p dist/extension
/bin/rm -f dist/extension/*(N.)
/bin/mv -f "$staging/van-tv.xpi" dist/van-tv.xpi
/bin/cp "$staging"/* dist/extension/
printf '%s\n' "$PWD/dist/van-tv.xpi"
