#!/bin/bash
# Usage: prune-releases.sh APP_DIR. Deletes old releases under APP_DIR/releases, keeping
# the releases current and previous point into, the newest other release (a spare to roll
# back to) and any release a running process uses. Only direct children named
# release.<8 alphanumerics> (the controller's mktemp pattern) are ever removed.
# Unreadable evidence is retried with sudo -n. Deletes nothing when current does not resolve into a release, or when a process owned by
# this user cannot be inspected (the service runs as pi, the same user as the controller;
# other users' processes are skipped, since they cannot be inspected and don't run pi's
# releases). PROC_DIR is overridable for tests only.
set -euo pipefail
app=${1:?app directory}
proc=${PROC_DIR:-/proc}
releases="$app/releases"
[[ -d "$releases" && ! -L "$releases" ]] || { echo 'No releases directory; nothing to prune.'; exit 0; }
releases=$(cd -P "$releases" && pwd)

# Prints the enclosing release directory of a link's resolved target, or fails.
enclosing_release() {
  local target rest name
  target=$(cd -P "$app/$1" 2>/dev/null && pwd) || return 1
  [[ "$target" == "$releases"/* ]] || return 1
  rest=${target#"$releases"/}
  name=${rest%%/*}
  [[ "$name" =~ ^release\.[A-Za-z0-9]{8}$ ]] || return 1
  printf '%s\n' "$releases/$name"
}

keep=()
[[ -L "$app/current" ]] || { echo 'current is not a link; not pruning.' >&2; exit 0; }
cur=$(enclosing_release current) || { echo 'current does not resolve into a release; not pruning.' >&2; exit 0; }
keep+=("$cur")
if [[ -L "$app/previous" ]] && prev=$(enclosing_release previous); then keep+=("$prev"); fi

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

# Non-dumpable processes (ssh-agent) show root-owned /proc files to their own user, so a
# failed read is retried through passwordless sudo; only a failure of both refuses.
read_link() { readlink "$1" 2>/dev/null || sudo -n readlink "$1" 2>/dev/null; }
mentions() { # exit 0 match, 1 no match, 2 unreadable
  local rc=0
  grep -aqF -- "$1" "$2" 2>/dev/null || rc=$?
  [[ $rc -le 1 ]] && return "$rc"
  rc=0; sudo -n grep -aqF -- "$1" "$2" 2>/dev/null || rc=$?
  [[ $rc -le 1 ]] && return "$rc"
  return 2
}

# Releases a process uses: cwd, exe, mapped files or a path on its command line.
for p in "$proc"/[0-9]*; do
  [[ -d "$p" ]] || continue
  [[ -O "$p" ]] || continue
  texts=()
  for field in cwd exe; do
    if t=$(read_link "$p/$field"); then texts+=("$t")
    elif [[ -d "$p" ]]; then echo "Cannot read $p/$field; not pruning." >&2; exit 1; fi
  done
  for dir in ${candidates[@]+"${candidates[@]}"}; do
    in_keep "$dir" && continue
    for t in ${texts[@]+"${texts[@]}"}; do
      case "$t" in "$dir"|"$dir"/*) keep+=("$dir"); continue 2 ;; esac
    done
    for field in maps cmdline; do
      rc=0; mentions "$dir" "$p/$field" || rc=$?
      if [[ $rc -eq 0 ]]; then keep+=("$dir"); continue 2; fi
      if [[ $rc -eq 2 && -d "$p" ]]; then echo "Cannot read $p/$field; not pruning." >&2; exit 1; fi
    done
  done
done

for dir in ${candidates[@]+"${candidates[@]}"}; do
  if in_keep "$dir"; then continue; fi
  echo "Pruning old release: $dir"
  rm -rf -- "$dir"
done
