#!/usr/bin/env bash
# Runs purgePosts when the things that decide what belongs in a feed change.
#
# The service only ever ADDS rows. Tightening a filter stops new junk but leaves
# what is already indexed; adding an account to the moderation list blocks its
# future posts but not its past ones. This closes both gaps without anyone
# having to remember.
#
# Two independent triggers, each running only the mode it implies — the
# --rejected sweep re-hydrates every stored post from the AppView, so it must
# not fire merely because someone was added to the blocklist:
#
#   data/filters.json changed        -> purgePosts --rejected
#   the moderation list changed      -> purgePosts --blocked
#
# SAFETY: a valid-but-wrong regex passes hot-reload validation and would delete
# the feed. So every run is a dry run first, and the deletion is applied only if
# the count is below both an absolute and a proportional limit. Over the limit,
# nothing is touched and a notification goes out for a human to look.
#
# Runs on the HOST (it drives docker), one copy per box, each watching its own
# state. No cross-box ordering: the standby fires when the synced filters reach
# it. Cheap hash checks every run; a container starts only on a real change.
set -uo pipefail

PROJECT="${AUTO_PURGE_PROJECT:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../feedgen" 2>/dev/null && pwd)}"
STATE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
STATE="$STATE_DIR/auto-purge.state"
WITHHELD="$STATE_DIR/auto-purge.withheld"
LAST_NOTIFIED="$STATE_DIR/auto-purge-last-notified"
LOG="$STATE_DIR/auto-purge.log"

NTFY_TOPIC="${NTFY_TOPIC:-}"          # unset = log only, never notify
MAX_ABS="${AUTO_PURGE_MAX_ABS:-25}"     # never auto-delete more rows than this
MAX_PCT="${AUTO_PURGE_MAX_PCT:-5}"      # ...nor more than this share of stored rows
NOTIFY_EVERY=21600                      # 6h, same throttle as the parity check

log() { printf '%s %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*" >> "$LOG"; }

# The ntfy topic is public to anyone who knows the name: short reasons only,
# never a hostname, IP or path.
notify() {
  [ -n "$NTFY_TOPIC" ] || { log "no NTFY_TOPIC set, not notifying: $*"; return; }
  local now last=0
  now=$(date +%s)
  [ -f "$LAST_NOTIFIED" ] && last=$(cat "$LAST_NOTIFIED" 2>/dev/null || echo 0)
  if [ $((now - last)) -lt "$NOTIFY_EVERY" ]; then
    log "notify suppressed (throttled): $*"
    return
  fi
  if curl -fsS -m 20 -H "Title: feedgen auto-purge" -d "$*" "https://ntfy.sh/$NTFY_TOPIC" >/dev/null 2>&1; then
    echo "$now" > "$LAST_NOTIFIED"
  else
    log "notify FAILED to send: $*"
  fi
}

[ -d "$PROJECT" ] || { log "ERROR project dir not found: $PROJECT"; exit 1; }
cd "$PROJECT" || exit 1

# ---- cheap change detection, no container ----------------------------------

filters_hash() { sha256sum data/filters.json 2>/dev/null | cut -d' ' -f1; }

# Hash the DIDs the AppView actually hydrates — that set is what blocks posts.
# listItemCount is not usable: it counts records whose accounts may be gone.
list_hash() {
  local uris
  uris=$(python3 -c "
import json
d=json.load(open('data/filters.json'))
print('\n'.join(sorted({f['excludeListUri'] for f in d['feeds'].values() if f.get('excludeListUri')})))
" 2>/dev/null) || return 1
  [ -n "$uris" ] || { echo "no-list"; return 0; }
  local all=""
  while IFS= read -r uri; do
    local cursor="" page dids
    while :; do
      page=$(curl -fsS -m 30 --get \
        --data-urlencode "list=$uri" --data-urlencode "limit=100" \
        ${cursor:+--data-urlencode "cursor=$cursor"} \
        "https://public.api.bsky.app/xrpc/app.bsky.graph.getList") || return 1
      dids=$(printf '%s' "$page" | python3 -c "
import sys,json
d=json.load(sys.stdin)
print('\n'.join(i['subject']['did'] for i in d['items']))
print('CURSOR:'+(d.get('cursor') or ''))
") || return 1
      all+=$(printf '%s' "$dids" | grep -v '^CURSOR:')$'\n'
      cursor=$(printf '%s' "$dids" | sed -n 's/^CURSOR://p')
      [ -n "$cursor" ] || break
    done
  done <<< "$uris"
  printf '%s' "$all" | tr -d ' ' | grep -v '^$' | sort -u | sha256sum | cut -d' ' -f1
}

FH="$(filters_hash)"
[ -n "$FH" ] || { log "ERROR cannot hash data/filters.json"; exit 1; }
LH="$(list_hash)" || { log "WARN moderation list unreachable, skipping this run"; exit 0; }

PREV_FH=""; PREV_LH=""
[ -f "$STATE" ] && { PREV_FH=$(sed -n '1p' "$STATE"); PREV_LH=$(sed -n '2p' "$STATE"); }

# First ever run: record the baseline and do nothing. Otherwise a fresh install
# would sweep the whole feed on its first tick.
if [ -z "$PREV_FH" ]; then
  printf '%s\n%s\n' "$FH" "$LH" > "$STATE"
  log "baseline recorded, no action on first run"
  exit 0
fi

MODES=()
[ "$FH" != "$PREV_FH" ] && MODES+=("rejected")
[ "$LH" != "$PREV_LH" ] && MODES+=("blocked")

if [ ${#MODES[@]} -eq 0 ]; then
  exit 0
fi

log "change detected: ${MODES[*]}"

# ---- act -------------------------------------------------------------------

SERVICE="${FEEDGEN_SERVICE:-$(docker compose config --services 2>/dev/null | head -1)}"

purge() { # mode, extra args...
  local m="$1"; shift
  docker compose run --rm -T "$SERVICE" yarn purgePosts "--$m" --json "$@" 2>/dev/null \
    | grep -E '^\{' | tail -1
}

for m in "${MODES[@]}"; do
  DRY="$(purge "$m")"
  if [ -z "$DRY" ]; then
    log "ERROR --$m dry run produced no JSON"
    notify "auto-purge failed: no output from $m"
    continue
  fi

  COUNT=$(printf '%s' "$DRY" | python3 -c "import sys,json;print(json.load(sys.stdin)['count'])" 2>/dev/null)
  STORED=$(printf '%s' "$DRY" | python3 -c "import sys,json;print(json.load(sys.stdin)['stored'])" 2>/dev/null)
  if [ -z "$COUNT" ] || [ -z "$STORED" ]; then
    log "ERROR --$m returned unparsable JSON"
    notify "auto-purge failed: bad output from $m"
    continue
  fi

  if [ "$COUNT" -eq 0 ]; then
    log "--$m: nothing to delete"
    continue
  fi

  LIMIT_PCT=$(( STORED * MAX_PCT / 100 ))
  LIMIT=$(( LIMIT_PCT < MAX_ABS ? LIMIT_PCT : MAX_ABS ))
  [ "$LIMIT" -lt 1 ] && LIMIT=1

  if [ "$COUNT" -gt "$LIMIT" ]; then
    log "--$m: WITHHELD, would delete $COUNT of $STORED (limit $LIMIT)"
    printf '%s %s count=%s stored=%s limit=%s\n' \
      "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$m" "$COUNT" "$STORED" "$LIMIT" >> "$WITHHELD"
    notify "withheld $m purge: $COUNT of $STORED rows, over limit $LIMIT - check manually"
    continue
  fi

  OUT="$(purge "$m" --apply)"
  APPLIED=$(printf '%s' "$OUT" | python3 -c "import sys,json;print(json.load(sys.stdin)['count'])" 2>/dev/null)
  if [ -z "$APPLIED" ]; then
    log "ERROR --$m apply produced no usable JSON"
    notify "auto-purge failed while applying $m"
    continue
  fi
  log "--$m: deleted $APPLIED of $STORED"
done

printf '%s\n%s\n' "$FH" "$LH" > "$STATE"
