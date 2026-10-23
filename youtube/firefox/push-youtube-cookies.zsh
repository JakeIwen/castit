#!/bin/zsh
# Run on the Mac. Cookie values travel only through private files, never argv.
set -eu -o pipefail
unsetopt xtrace
umask 077
here=${0:A:h}
profile=''
output=''
remove=0
work=''
remote_temp=''
output_temp=''

fail() { print -u2 -- "$1"; exit 1; }
usage() {
  print 'Usage: push-youtube-cookies.zsh [--profile <dir>] [--output <file>] | --remove'
}
while (( $# )); do
  case $1 in
    --profile|--output)
      (( $# >= 2 )) && [[ -n $2 ]] || { usage >&2; exit 2; }
      if [[ $1 == --profile ]]; then profile=$2; else output=$2; fi
      shift 2 ;;
    --remove) remove=1; shift ;;
    --help|-h) usage; exit 0 ;;
    *) usage >&2; exit 2 ;;
  esac
done
if (( remove )) && [[ -n $profile || -n $output ]]; then usage >&2; exit 2; fi

cleanup() {
  [[ -z $output_temp ]] || rm -f -- "$output_temp"
  [[ -z $work ]] || rm -rf -- "$work"
  if [[ -n $remote_temp ]]; then
    ssh -o BatchMode=yes -o ConnectTimeout=10 "$target" \
      "rm -f -- ${(q)remote_temp}" >/dev/null 2>&1 || true
  fi
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM HUP

load_remote_config() {
  local local_config="$here/../local.json"
  target=$(node --input-type=module -e '
    const {loadLocalConfig}=await import(process.argv[1]);
    console.log(loadLocalConfig(process.argv[2]).sshTarget);
  ' "$here/../receiver/src/config/local-config.mjs" "$local_config")
  state_dir=$(CASTIT_LOCAL_CONFIG="$local_config" node --input-type=module -e '
    const {config}=await import(process.argv[1]); console.log(config.stateDirectory);
  ' "$here/../receiver/src/config/receiver-config.mjs")
}

if (( remove )); then
  load_remote_config
  ssh -o BatchMode=yes -o ConnectTimeout=10 "$target" \
    "/bin/bash -s -- ${(q)state_dir}" <<'REMOTE'
set -eu -o pipefail
[[ ! -L $1 && -d $1 && $(stat -c %u "$1") == $(id -u) ]] || exit 1
rm -f -- "$1/youtube-cookies.txt"
REMOTE
  print 'Watch history disabled (cookie file removed).'
  exit 0
fi

work=$(mktemp -d "${TMPDIR:-/tmp}/castit-cookies.XXXXXXXX")
chmod 700 "$work"
# A SQLite backup includes committed WAL data, unlike a plain copy of the DB.
# All subsequent queries use only this private snapshot; a busy DB fails closed.
snapshot_profile() {
  local source=${1:A}/cookies.sqlite
  [[ -f $source ]] || return 1
  rm -f -- "$work/cookies.sqlite"
  (cd "$work"; /usr/bin/sqlite3 -readonly -cmd '.timeout 5000' "$source" \
    '.backup cookies.sqlite') >/dev/null 2>&1 || return 1
  # A backup inherits WAL journal mode. Normalize only the private copy before
  # opening it read-only (macOS SQLite cannot initialize its WAL that way).
  /usr/bin/sqlite3 "$work/cookies.sqlite" 'PRAGMA journal_mode=DELETE;' >/dev/null 2>&1
}

domains="(host = 'youtube.com' OR host LIKE '%.youtube.com' OR host = 'google.com' OR host LIKE '%.google.com')"
valid="($domains AND originAttributes = '' AND (expiry = 0 OR expiry > strftime('%s','now')))"
has_youtube() {
  local count
  count=$(/usr/bin/sqlite3 -readonly "$work/cookies.sqlite" \
    "SELECT count(*) FROM moz_cookies WHERE $valid AND (host = 'youtube.com' OR host LIKE '%.youtube.com');" \
    2>/dev/null) || return 1
  [[ $count == <1-> ]]
}

if [[ -n $profile ]]; then
  snapshot_profile "$profile" || fail 'Could not privately snapshot the selected Firefox cookie database.'
  has_youtube || fail 'The selected Firefox profile has no current YouTube cookies in its default container.'
else
  # Install defaults take precedence. Remaining profiles are candidates only if
  # their private snapshot actually contains YouTube cookies (no values read here).
  candidates=$(node --input-type=module - "$HOME/Library/Application Support/Firefox/profiles.ini" <<'NODE'
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
try {
  const file = process.argv[2];
  const sections = [];
  let section;
  for (const raw of readFileSync(file, 'utf8').split(/\r?\n/)) {
    const line = raw.trim();
    if (/^\[.*\]$/.test(line)) { section = { name: line.slice(1, -1) }; sections.push(section); }
    else if (section && line && !/^[;#]/.test(line) && line.includes('=')) {
      const at = line.indexOf('='); section[line.slice(0, at)] = line.slice(at + 1);
    }
  }
  const defaults = sections.filter(s => s.name.startsWith('Install') && s.Default).map(s => s.Default);
  const others = sections.filter(s => s.name.startsWith('Profile') && s.Path).map(s => s.Path);
  for (const path of new Set([...defaults, ...others].map(p => resolve(dirname(file), p)))) {
    if (/[\r\n\0]/.test(path)) throw new Error();
    console.log(path);
  }
} catch { console.error('Could not read Firefox profile configuration. Use --profile.'); process.exit(1); }
NODE
  )
  found=0
  for candidate in "${(@f)candidates}"; do
    if snapshot_profile "$candidate" && has_youtube; then found=1; break; fi
  done
  (( found )) || fail 'No Firefox profile with current YouTube cookies was found. Use --profile.'
fi

session_count=$(/usr/bin/sqlite3 -readonly "$work/cookies.sqlite" \
  "SELECT count(*) FROM moz_cookies WHERE $valid AND name IN ('SID','__Secure-1PSID','__Secure-3PSID') AND length(value) > 0;" \
  2>/dev/null) || fail 'Could not inspect the private cookie snapshot.'
(( session_count > 0 )) || fail 'No signed-in session cookies (SID or secure PSID) were found; sign in to YouTube first.'
# Netscape cookies are tab-delimited. Reject unrepresentable fields, not silently
# truncated or injected rows. No SQL error or cookie contents reach the terminal.
bad_count=$(/usr/bin/sqlite3 -readonly "$work/cookies.sqlite" \
  "SELECT count(*) FROM moz_cookies WHERE $valid AND (instr(host || path || name || value, char(9)) OR instr(host || path || name || value, char(10)) OR instr(host || path || name || value, char(13)) OR instr(host || path || name || value, char(0)));" \
  2>/dev/null) || fail 'Could not validate the private cookie snapshot.'
(( bad_count == 0 )) || fail 'The cookie snapshot contains fields that cannot be exported safely.'
print '# Netscape HTTP Cookie File' > "$work/cookies.txt"
/usr/bin/sqlite3 -readonly "$work/cookies.sqlite" \
  "SELECT (CASE WHEN isHttpOnly THEN '#HttpOnly_' ELSE '' END) || host || char(9) || (CASE WHEN substr(host,1,1) = '.' THEN 'TRUE' ELSE 'FALSE' END) || char(9) || path || char(9) || (CASE WHEN isSecure THEN 'TRUE' ELSE 'FALSE' END) || char(9) || expiry || char(9) || name || char(9) || value FROM moz_cookies WHERE $valid ORDER BY host,path,name;" \
  >> "$work/cookies.txt" 2>/dev/null || fail 'Could not export the private cookie snapshot.'
chmod 600 "$work/cookies.txt"

if [[ -n $output ]]; then
  output=${output:a}
  [[ ! -L $output && ( ! -e $output || -f $output ) ]] || fail 'Output must be a regular file, not a directory or symlink.'
  output_temp=$(mktemp "${output}.XXXXXXXX")
  cp "$work/cookies.txt" "$output_temp"
  chmod 600 "$output_temp"
  mv -f -- "$output_temp" "$output"
  output_temp=''
  print 'Cookie file written privately; no receiver was contacted.'
else
  load_remote_config
  remote_candidate=$(ssh -o BatchMode=yes -o ConnectTimeout=10 "$target" \
    "/bin/bash -s -- ${(q)state_dir}" <<'REMOTE'
set -eu -o pipefail
umask 077
[[ ! -L $1 && -d $1 && $(stat -c %u "$1") == $(id -u) && $(stat -c %a "$1") == 700 ]] || exit 1
mktemp "$1/.youtube-cookies.XXXXXXXX"
REMOTE
  )
  [[ $remote_candidate == "$state_dir"/.youtube-cookies.* && $remote_candidate != *$'\n'* ]] \
    || fail 'Receiver did not return a safe temporary cookie path.'
  remote_temp=$remote_candidate
  scp -q "$work/cookies.txt" "$target:$remote_temp"
  ssh -o BatchMode=yes -o ConnectTimeout=10 "$target" \
    "/bin/bash -s -- ${(q)state_dir} ${(q)remote_temp}" <<'REMOTE'
set -eu -o pipefail
[[ ! -L $1 && -d $1 && $(stat -c %u "$1") == $(id -u) ]] || exit 1
[[ $2 == "$1"/.youtube-cookies.* && ! -L $2 && -f $2 && $(stat -c %u "$2") == $(id -u) ]] || exit 1
chmod 600 "$2"
mv -f -- "$2" "$1/youtube-cookies.txt"
REMOTE
  remote_temp=''
  print 'Cookie file installed privately. Watch history is enabled; no restart is needed.'
fi
