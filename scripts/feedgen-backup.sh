#!/bin/bash
# Nightly feedgen backup, with a hard cap on the disk the history may occupy.
#
# Wraps scripts/backupAll.sh, which does the actual work — a consistent database
# snapshot taken while the service stays up, the project including .env, the
# data directory, the published feed records and the PLC document.
#
# Pruning walks newest-first and drops everything past the cap, which keeps the
# retained history CONTIGUOUS rather than leaving gaps. The newest bundle is
# never pruned, even if it alone exceeds the limit.
#
# Runs on the HOST, one copy per box, and finds its own paths: living in
# <somewhere>/cron-tasks/ it backs up <somewhere>/feedgen into
# <somewhere>/backups. That is what lets the file stay byte-identical on every
# box, with per-box differences supplied by cron — the same arrangement
# auto-purge.sh uses for its ntfy topic.
#
# BACKUPS CONTAIN .env, AND THEREFORE THE TUNNEL TOKEN. The directory is forced
# to mode 700 below, and these bundles must never be copied anywhere public.
set -uo pipefail

STATE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

PROJECT="${FEEDGEN_BACKUP_PROJECT:-$(cd "$STATE_DIR/../feedgen" 2>/dev/null && pwd)}"
BACKUP_DIR="${FEEDGEN_BACKUP_DIR:-$STATE_DIR/../backups}"
# 300 MB is roughly two months of ~5 MB dailies. A box with disk to spare can
# raise it from cron rather than by editing this file — see the header.
LIMIT_MB="${FEEDGEN_BACKUP_LIMIT_MB:-300}"
LOG="${FEEDGEN_BACKUP_LOG:-$STATE_DIR/feedgen-backup.log}"

exec >> "$LOG" 2>&1
echo "=== $(date -u "+%Y-%m-%dT%H:%M:%SZ") start ==="

if [ -z "$PROJECT" ] || ! cd "$PROJECT"; then
    echo "!! no project at '$PROJECT'"
    exit 1
fi

# The bundles carry .env. Enforced here rather than assumed, because a
# world-readable backup directory is not a thing anyone notices by looking.
mkdir -p "$BACKUP_DIR" || { echo "!! cannot create $BACKUP_DIR"; exit 1; }
BACKUP_DIR="$(cd "$BACKUP_DIR" && pwd)"
if [ "$(stat -c %a "$BACKUP_DIR")" != "700" ]; then
    echo "tightening $BACKUP_DIR to 700 (it holds .env)"
    chmod 700 "$BACKUP_DIR"
fi

if ! ./scripts/backupAll.sh "$BACKUP_DIR"; then
    echo "!! backup FAILED - existing bundles left untouched"
    # A nightly that stops working is invisible: the log says so and nobody
    # reads the log. Same throttle-free one-liner auto-purge.sh uses, and the
    # same rule — an ntfy topic is public to whoever knows its name, so this
    # says what happened and never where. No topic set = log only.
    if [ -n "${NTFY_TOPIC:-}" ]; then
        curl -fsS -m 20 -H "Title: feedgen backup" \
             -d "nightly backup FAILED - check the log on the box" \
             "https://ntfy.sh/$NTFY_TOPIC" >/dev/null 2>&1 \
          || echo "!! could not send the failure notification either"
    fi
    exit 1
fi

cd "$BACKUP_DIR" || { echo "!! no backup dir"; exit 1; }

total=0
newest=1
while IFS= read -r d; do
    # Only ever delete directories whose names are exactly a backup stamp.
    #
    # This also, deliberately, leaves anything else alone AND out of the running
    # total: hand-made bundles from before backupAll.sh existed do not carry the
    # trailing Z, and on the primary one of them is the only surviving copy of
    # the pre-migration SkyFeed avatar blobs. Nothing here may put a cap on the
    # disk ahead of that.
    [[ "$d" =~ ^feedgen-[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{6}Z$ ]] || continue
    sz=$(du -sm -- "$d" | cut -f1)
    total=$((total + sz))
    if [ "$total" -gt "$LIMIT_MB" ] && [ "$newest" -eq 0 ]; then
        echo "prune $d (${sz} MB; cumulative ${total} MB over ${LIMIT_MB} MB cap)"
        rm -rf -- "$d"
    fi
    newest=0
done < <(ls -1d feedgen-* 2>/dev/null | sort -r)

echo "kept $(ls -1d feedgen-* 2>/dev/null | wc -l) bundle(s), $(du -sm "$BACKUP_DIR" | cut -f1) MB, $(df -h --output=avail / | tail -1 | tr -d " ") free on /"
echo "=== $(date -u "+%Y-%m-%dT%H:%M:%SZ") done ==="

# keep the log from growing without bound
tail -n 500 "$LOG" > "$LOG.tmp" && mv "$LOG.tmp" "$LOG"
