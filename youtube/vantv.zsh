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
  print -u2 '       vantv quality [auto|1080|720|480|360]   show or set saved maximum resolution'
  print -u2 '       vantv subs [on|off|<lang>]   show or set saved subtitles (default language: en)'
  print -u2 '       vantv delay [+ms|-ms|ms]   show, nudge or set the audio offset (+ plays sound later)'
  print -u2 '       vantv vol [+n|-n|n|mute|unmute]   show, nudge or set the volume (0-100, saved)'
  print -u2 '       vantv speed [+x|-x|x]   show, nudge or set the playback speed (0.25-3, saved)'
  print -u2 '       vantv queue [youtube-url|list|clear]   add a video (default: as for casting), list or clear'
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

# Reads one field of the receiver's status JSON (given on stdin) as text.
status_field() { /usr/bin/plutil -extract "$1" raw -o - - 2>/dev/null }

show_volume() {
  local state level
  state=$(curl -fsS -m 10 "$VAN_TV/api/status")
  level=$(status_field volume.level <<< "$state") || { print -u2 'Van TV did not report a volume.'; exit 1 }
  [[ $(status_field volume.muted <<< "$state") == true ]] && print "Volume: ${level%.*} (muted)" || print "Volume: ${level%.*}"
}

set_volume() {
  case $1 in
    mute) post control '{"action":"mute","muted":true}' >/dev/null ;;
    unmute) post control '{"action":"mute","muted":false}' >/dev/null ;;
    [+-][0-9]*) [[ $1 =~ '^[+-][0-9]+$' ]] || usage; post control "{\"action\":\"volume\",\"offset\":${1#+}}" >/dev/null ;;
    <0-100>) post control "{\"action\":\"volume\",\"level\":$(( 10#$1 ))}" >/dev/null ;;
    *) usage ;;
  esac
}

show_speed() {
  local speed
  speed=$(curl -fsS -m 10 "$VAN_TV/api/status" | status_field speed) || { print -u2 'Van TV did not report a speed.'; exit 1 }
  printf 'Speed: %gx\n' $speed
}

# A signed value nudges the speed; an unsigned one sets it.
set_speed() {
  [[ $1 =~ '^([+-]?)[0-9]+(\.[0-9]+)?$' ]] || usage
  if [[ -n $match[1] ]]; then post control "{\"action\":\"speed\",\"offset\":${1#+}}" >/dev/null
  else post control "{\"action\":\"speed\",\"speed\":$1}" >/dev/null
  fi
}

show_quality() {
  local state selected loading failed
  state=$(curl -fsS -m 10 "$VAN_TV/api/status")
  selected=$(status_field quality.selected <<< "$state") || { print -u2 'Van TV did not report quality support.'; exit 1 }
  loading=$(status_field quality.loading <<< "$state") || loading=false
  failed=$(status_field quality.error <<< "$state") || failed=false
  [[ $selected == auto ]] && selected=Auto || selected="${selected}p maximum"
  if [[ $failed == true ]]; then print -r -- "Quality: $selected, change failed; select again"; return 1
  elif [[ $loading == true ]]; then print -r -- "Quality: $selected, applying"
  else print -r -- "Quality: $selected"
  fi
}

set_quality() {
  local reply
  case $1 in auto|1080|720|480|360) ;; *) usage ;; esac
  reply=$(post control "{\"action\":\"quality\",\"quality\":\"$1\"}")
  [[ $(status_field done <<< "$reply") == true ]] || { print -u2 'Van TV could not save quality.'; exit 1 }
}

show_subtitles() {
  local state enabled language available loading failed
  state=$(curl -fsS -m 10 "$VAN_TV/api/status")
  enabled=$(status_field subtitles.enabled <<< "$state") || { print -u2 'Van TV did not report subtitles.'; exit 1 }
  language=$(status_field subtitles.language <<< "$state")
  if [[ $enabled != true ]]; then print -r -- "Subtitles: off ($language)"; return; fi
  available=$(status_field subtitles.available <<< "$state") || available=unknown
  loading=$(status_field subtitles.loading <<< "$state") || loading=false
  failed=$(status_field subtitles.error <<< "$state") || failed=false
  if [[ $loading == true ]]; then print -r -- "Subtitles: on ($language), loading"
  elif [[ $failed == true ]]; then print -r -- "Subtitles: on ($language), failed to load; toggle off/on to retry"
  elif [[ $available == false ]]; then print -r -- "Subtitles: on ($language), no matching track"
  else print -r -- "Subtitles: on ($language)"
  fi
}

set_subtitles() {
  local body reply
  case $1 in
    on) body='{"action":"subtitles","enabled":true}' ;;
    off) body='{"action":"subtitles","enabled":false}' ;;
    *)
      [[ $1 != [aA][lL][lL] && $1 =~ '^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8}){0,3}$' ]] || usage
      body="{\"action\":\"subtitles\",\"language\":\"$1\"}" ;;
  esac
  reply=$(post control "$body")
  [[ $(status_field done <<< "$reply") == true ]] || { print -u2 'Van TV could not save subtitles.'; exit 1 }
}

list_queue() {
  local state count i title
  state=$(curl -fsS -m 10 "$VAN_TV/api/status")
  count=$(status_field queue <<< "$state") || { print -u2 'Van TV did not report a queue.'; exit 1 }
  (( count )) || { print 'Queue is empty.'; return }
  for (( i = 0; i < count; i++ )); do
    title=$(status_field queue.$i.title <<< "$state") || title=$(status_field queue.$i.id <<< "$state")
    print -r -- "$(( i + 1 )). $title"
  done
}

queue_video() {
  local url=${1:-$(front_tab_url)} id start reply
  is_youtube "$url" || usage
  read -r id start <<< "$(video_id "$url")" || { print -u2 "No video id in $url"; exit 1 }
  reply=$(post queue "{\"action\":\"add\",\"videoId\":\"$id\"}")
  [[ $reply == *'"done":true'* ]] || { print -u2 'Van TV did not queue the video (the queue may be full).'; exit 1 }
  print -r -- "Queued on Van TV: $url"
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
  quality) (( $# <= 2 )) || usage; if (( $# == 2 )); then set_quality "$2"; fi; show_quality; exit ;;
  subs) (( $# <= 2 )) || usage; [[ -n ${2:-} ]] && set_subtitles "$2"; show_subtitles; exit ;;
  delay) [[ -n ${2:-} ]] && set_delay $2; show_delay; exit ;;
  vol|volume) [[ -n ${2:-} ]] && set_volume $2; show_volume; exit ;;
  speed) [[ -n ${2:-} ]] && set_speed $2; show_speed; exit ;;
  queue)
    case ${2:-} in
      list) list_queue ;;
      clear) post queue '{"action":"clear"}' >/dev/null; print 'Queue cleared.' ;;
      *) queue_video ${2:-} ;;
    esac
    exit ;;
esac
url=${1:-$(front_tab_url)}
is_youtube "$url" || usage
read -r id start <<< "$(video_id "$url")" || { print -u2 "No video id in $url"; exit 1 }
post cast "{\"videoId\":\"$id\",\"position\":$start}" >/dev/null
print -r -- "Casting to Van TV: $url"
