#!/bin/zsh
set -eu -o pipefail
cd "${0:A:h}"
command -v node >/dev/null || { print -u2 'Van TV build requires Node.js.'; exit 1; }
mkdir -p dist
staging=$(/usr/bin/mktemp -d "$PWD/dist/.build.XXXXXX")
trap '/bin/rm -rf "$staging"' EXIT
node build/generate-config.mjs "${CASTIT_LOCAL_CONFIG:-../local.json}" "$staging"
/bin/cp config.js icon.svg "$staging/"
/bin/cp -R background popup content youtube theme "$staging/"
(
  cd "$staging"
  /usr/bin/zip -X -q -r -D van-tv.xpi manifest.json background popup content youtube theme *.js icon.svg
)
# Publish only after validation and packaging succeed; these outputs contain local config.
mkdir -p dist/extension
/bin/rm -rf dist/extension/*(N)
/bin/mv -f "$staging/van-tv.xpi" dist/van-tv.xpi
/bin/cp -R "$staging/." dist/extension/
printf '%s\n' "$PWD/dist/van-tv.xpi"
