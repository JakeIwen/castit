#!/bin/zsh
# vantv: cast a YouTube video from the Mac to the Van TV receiver (./receiver)
# over its LAN status server. The Firefox extension (./firefox) speaks the same
# /api/cast and /api/control endpoints.
set -euo pipefail

if [[ -z ${VAN_TV:-} ]]; then
  local_config=${CASTIT_LOCAL_CONFIG:-${0:A:h}/local.json}
  [[ -f $local_config ]] || {
    print -u2 -- "Van TV local config not found: $local_config. Copy local.example.json to local.json or set CASTIT_LOCAL_CONFIG."
    exit 1
  }
  VAN_TV=$(/usr/bin/plutil -extract senders.receiverUrls.0 raw -expect string -o - "$local_config" 2>/dev/null) || {
    print -u2 'Van TV config must contain senders.receiverUrls with an HTTP(S) base URL first.'
    exit 1
  }
  [[ $VAN_TV == http://?* || $VAN_TV == https://?* ]] || {
    print -u2 'Van TV senders.receiverUrls[0] must be an HTTP(S) base URL.'
    exit 1
  }
  VAN_TV=${VAN_TV%/}
fi

usage() {
  print -u2 'usage: vantv [youtube-url]   cast a link (default: front Chrome/Safari YouTube tab, then clipboard)'
  print -u2 '       vantv pause|resume|stop|status'
  print -u2 '       vantv delay [+ms|-ms|ms]   show, nudge or set the audio offset (+ plays sound later)'
  exit 2
}

post() {
  curl -fsS -m 10 -X POST -H 'Content-Type: application/json' -d "$2" "$VAN_TV/api/$1"
  print
}

# Prints the receiver's saved audio offset in ms, e.g. "+120 ms".
show_delay() {
  local state
  state=$(curl -fsS -m 10 "$VAN_TV/api/status")
  [[ $state =~ '"audioDelay": *(-?[0-9.eE+-]+)' ]] || { print -u2 'Van TV did not report an audio offset.'; exit 1 }
  printf 'Audio offset: %+.0f ms\n' $(( $match[1] * 1000 ))
}

# A signed value nudges the offset; an unsigned one sets it.
set_delay() {
  [[ $1 =~ '^([+-]?)([0-9]+)$' ]] || usage
  local seconds=$(printf '%.3f' $(( $1 / 1000.0 )))
  if [[ -n $match[1] ]]; then post control "{\"action\":\"audio_delay\",\"offset\":$seconds}" >/dev/null
  else post control "{\"action\":\"audio_delay\",\"delay\":$seconds}" >/dev/null
  fi
}

is_youtube() { [[ $1 =~ '^https://(((www|m|music)\.)?youtube\.com|youtu\.be)/' ]] }

# Prints "<id> <start seconds>" for watch, youtu.be, shorts, live and embed links.
video_id() {
  local url=$1 id='' start=0
  if [[ $url =~ '[?&]v=([A-Za-z0-9_-]{11})' ]]; then id=$match[1]
  elif [[ $url =~ 'youtu\.be/([A-Za-z0-9_-]{11})' ]]; then id=$match[1]
  elif [[ $url =~ '/(shorts|live|embed)/([A-Za-z0-9_-]{11})' ]]; then id=$match[2]
  fi
  [[ -n $id ]] || return 1
  [[ $url =~ '[?&#](t|start)=([0-9]+)s?' ]] && start=$match[2]
  print -r -- "$id $start"
}

front_tab_url() {
  local url
  if pgrep -xq 'Google Chrome'; then
    url=$(osascript -e 'tell application "Google Chrome" to get URL of active tab of front window' 2>/dev/null || true)
    is_youtube "$url" && { print -r -- "$url"; return }
  fi
  if pgrep -xq Safari; then
    url=$(osascript -e 'tell application "Safari" to get URL of current tab of front window' 2>/dev/null || true)
    is_youtube "$url" && { print -r -- "$url"; return }
  fi
  url=$(pbpaste)
  is_youtube "$url" && { print -r -- "$url"; return }
  print -u2 'No YouTube link given, in the front Chrome/Safari tab, or on the clipboard.'
  print -u2 'In Firefox, use the Van TV extension button instead.'
  exit 1
}

case ${1:-} in
  -h|--help) usage ;;
  pause|resume|stop) post control "{\"action\":\"$1\"}"; exit ;;
  status) curl -fsS -m 10 "$VAN_TV/api/status"; print; exit ;;
  delay) [[ -n ${2:-} ]] && set_delay $2; show_delay; exit ;;
esac
url=${1:-$(front_tab_url)}
is_youtube "$url" || usage
read -r id start <<< "$(video_id "$url")" || { print -u2 "No video id in $url"; exit 1 }
post cast "{\"videoId\":\"$id\",\"position\":$start}" >/dev/null
print -r -- "Casting to Van TV: $url"
