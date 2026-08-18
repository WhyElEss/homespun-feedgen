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

# ---- keep purgePosts' database snapshots from growing without limit --------
#
# Every applied sweep copies the WHOLE database beside its dump, and nothing
# ever removed those copies. By 2026-08-09 there were 38 — 24 MB against a
# 648 KB database — and backupAll.sh was packing all of them into every nightly
# bundle, so dailies had grown 5 -> 12 MB and the standby's 300 MB cap held
# about three weeks instead of the two months its own comment claims.
#
# A snapshot is the undo for ONE sweep. It stops meaning anything once
# retention has aged those rows out of the live database anyway, which at 72 h
# is long before the twentieth-newest of them.
#
# Runs before the change detection below, not after the sweep, so a snapshot
# left by a purgePosts run made BY HAND is cleaned up on the next tick too.
KEEP_SNAPSHOTS="${AUTO_PURGE_KEEP_SNAPSHOTS:-20}"
prune_snapshots() {
  [ -d data ] || return 0
  # Newest first; everything past the keep count goes. The case re-checks each
  # name before deleting: this runs as root every five minutes, and the cost of
  # being wrong about one glob is the database sitting in the same directory.
  ls -1t data/db-backup-purge-*.sqlite 2>/dev/null \
    | tail -n +"$((KEEP_SNAPSHOTS + 1))" \
    | while IFS= read -r snap; do
        case "$snap" in
          data/db-backup-purge-*.sqlite)
            rm -f -- "$snap" && log "pruned old snapshot ${snap#data/}"
            ;;
        esac
      done
}
prune_snapshots || true

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

# EVERY SWEEP IS SCOPED TO ONE FEED, and the cap is judged against that feed's
# own stored rows. This is not a refinement; the box-wide version was broken.
#
# A box-wide sweep reports one count against one total, so the cap saw 103 of
# 1635 and refused. Those 103 were 99 rows in one feed — left over from a toggle
# its owner had deliberately changed — plus 4 in a DIFFERENT feed from the edit
# that had just been made on purpose. The 4 could not be applied until the 99
# aged out of retention, which is days, and until then no edit to any feed would
# apply anything: the page would say saved and the sweep would silently do
# nothing. A cap that turns one feed's backlog into a freeze on every other feed
# protects nobody.
#
# Per feed the same numbers decide correctly: 4 of 251 is under that feed's own
# cap and goes; 99 of 871 is over its own and is still held for a human. The
# cap's purpose is unchanged — only what it is measured against.
feed_keys() {
  python3 -c "
import json
d = json.load(open('data/filters.json'))
print(' '.join(k for k in d.get('feeds', {})))
" 2>/dev/null
}

FEEDS="$(feed_keys)"
if [ -z "$FEEDS" ]; then
  log "ERROR cannot read the feed list from data/filters.json"
  notify "auto-purge failed: cannot read the feed list"
  exit 1
fi

for m in "${MODES[@]}"; do
  for feed in $FEEDS; do
    DRY="$(purge "$m" --feed "$feed")"
    if [ -z "$DRY" ]; then
      log "ERROR --$m $feed: dry run produced no JSON"
      notify "auto-purge failed: no output from $m"
      continue
    fi

    COUNT=$(printf '%s' "$DRY" | python3 -c "import sys,json;print(json.load(sys.stdin)['count'])" 2>/dev/null)
    STORED=$(printf '%s' "$DRY" | python3 -c "import sys,json;print(json.load(sys.stdin)['stored'])" 2>/dev/null)
    if [ -z "$COUNT" ] || [ -z "$STORED" ]; then
      log "ERROR --$m $feed: unparsable JSON"
      notify "auto-purge failed: bad output from $m"
      continue
    fi

    # Silent when there is nothing to do. This now runs once per feed, and a
    # line per feed per trigger would bury the runs that did something.
    [ "$COUNT" -eq 0 ] && continue

    LIMIT_PCT=$(( STORED * MAX_PCT / 100 ))
    LIMIT=$(( LIMIT_PCT < MAX_ABS ? LIMIT_PCT : MAX_ABS ))
    [ "$LIMIT" -lt 1 ] && LIMIT=1

    if [ "$COUNT" -gt "$LIMIT" ]; then
      log "--$m $feed: WITHHELD, would delete $COUNT of $STORED (limit $LIMIT)"
      printf '%s %s feed=%s count=%s stored=%s limit=%s\n' \
        "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$m" "$feed" "$COUNT" "$STORED" "$LIMIT" >> "$WITHHELD"
      # The same fact into data/, which IS mounted into the container — this
      # file is the only way a refused sweep can reach the admin page. An
      # applied sweep at least leaves a dump beside the database; a withheld one
      # deletes nothing and so leaves nothing, which made the most interesting
      # thing this script does the one thing nobody could see afterwards.
      # `feed` is in the record because the sweep is scoped to one now: without
      # it the page showed the row under whichever feed happened to be selected,
      # reporting a box-wide total as though it belonged to that feed.
      printf '{"at":"%s","mode":"%s","feed":"%s","count":%s,"stored":%s,"limit":%s}\n' \
        "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$m" "$feed" "$COUNT" "$STORED" "$LIMIT" \
        >> data/auto-purge-withheld.jsonl \
        || log "WARN could not append to data/auto-purge-withheld.jsonl"
      notify "withheld $m purge: $COUNT of $STORED rows in one feed, over limit $LIMIT - check manually"
      continue
    fi

    OUT="$(purge "$m" --apply --feed "$feed")"
    APPLIED=$(printf '%s' "$OUT" | python3 -c "import sys,json;print(json.load(sys.stdin)['count'])" 2>/dev/null)
    if [ -z "$APPLIED" ]; then
      log "ERROR --$m $feed: apply produced no usable JSON"
      notify "auto-purge failed while applying $m"
      continue
    fi
    log "--$m $feed: deleted $APPLIED of $STORED"
  done
done

printf '%s\n%s\n' "$FH" "$LH" > "$STATE"
