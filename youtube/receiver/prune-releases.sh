#!/bin/bash
# Usage: prune-releases.sh APP_DIR. Deletes old releases under APP_DIR/releases, keeping
# what current and previous point at, the newest other release (a spare to roll back to),
# and any release a running process has as its working directory. Only direct children
# named release.<8 alphanumerics> (the controller's mktemp pattern) are ever removed.
# PROC_DIR is overridable for tests only.
set -euo pipefail
app=${1:?app directory}
proc=${PROC_DIR:-/proc}
releases="$app/releases"
[[ -d "$releases" && ! -L "$releases" ]] || { echo 'No releases directory; nothing to prune.'; exit 0; }
releases=$(cd -P "$releases" && pwd)

keep=()
for link in current previous; do
  if [[ -L "$app/$link" ]]; then
    target=$(cd -P "$app/$link" 2>/dev/null && pwd) || continue
    keep+=("$target")
  fi
done
# Refuse to prune when current does not resolve into releases: the keep set would be wrong.
[[ ${#keep[@]} -gt 0 ]] || { echo 'No current/previous link resolves; not pruning.' >&2; exit 0; }

candidates=()
while IFS= read -r name; do
  [[ "$name" =~ ^release\.[A-Za-z0-9]{8}$ ]] || continue
  [[ -d "$releases/$name" && ! -L "$releases/$name" ]] || continue
  candidates+=("$releases/$name")
done < <(ls -1t "$releases")

in_keep() { local k; for k in "${keep[@]}"; do [[ "$k" == "$1" ]] && return 0; done; return 1; }

# Newest candidate not already kept (ls -t order) is the spare.
for dir in ${candidates[@]+"${candidates[@]}"}; do
  if ! in_keep "$dir"; then keep+=("$dir"); break; fi
done

# Releases some process is running in (its cwd is the release or inside it).
for cwd in "$proc"/[0-9]*/cwd; do
  path=$(readlink "$cwd" 2>/dev/null) || continue
  for dir in ${candidates[@]+"${candidates[@]}"}; do
    case "$path" in "$dir"|"$dir"/*) keep+=("$dir") ;; esac
  done
done

for dir in ${candidates[@]+"${candidates[@]}"}; do
  if in_keep "$dir"; then continue; fi
  echo "Pruning old release: $dir"
  rm -rf -- "$dir"
done
