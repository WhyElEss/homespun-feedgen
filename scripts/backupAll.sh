#!/usr/bin/env bash
# Full backup of a running feedgen: database, project (including .env), the
# data directory, every published feed record, the service DID's PLC document
# and the resolved docker state.
#
# The database is snapshotted through SQLite's own backup API while the service
# keeps running, so the copy is consistent rather than a torn file read.
#
# Runs on the HOST, not inside the container — it drives docker itself.
#
#   bash scripts/backupAll.sh [output-parent-dir]
#
#   FEEDGEN_SERVICE   compose service name (default: first service in the
#                     compose file, which is the feedgen in the shipped layout)
#   output-parent-dir default: ~/backups
#
# CONTAINS SECRETS: .env and the resolved compose config carry your tunnel
# token and any app passwords. Keep the output off anything public.
set -euo pipefail

PROJECT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$PROJECT"

# Default to the first service in the compose file — that is the feedgen itself
# in every layout shipped here; override when yours is ordered differently.
#
# Read the list once into a variable instead of piping it. Under `pipefail`, a
# consumer that stops reading early (`head -1`, `grep -q`) kills the upstream
# `docker compose` with SIGPIPE, and the pipeline then reports 141 even though
# the match succeeded. That surfaces as a bogus "no compose service named ..."
# on slower machines, where compose is still writing when the consumer is done.
SERVICES="$(docker compose config --services 2>/dev/null || true)"
SERVICE="${FEEDGEN_SERVICE:-${SERVICES%%$'\n'*}}"
if [ -z "$SERVICE" ]; then
  echo "No compose services found in $PROJECT." >&2
  echo "Run this from a project with a docker-compose.yml." >&2
  exit 1
fi
case $'\n'"$SERVICES"$'\n' in
  *$'\n'"$SERVICE"$'\n'*) ;;
  *)
    echo "No compose service named '$SERVICE'. Available:" >&2
    echo "$SERVICES" | sed 's/^/  /' >&2
    echo "Set FEEDGEN_SERVICE=<name> and re-run." >&2
    exit 1
    ;;
esac

[ -f .env ] || { echo ".env not found in $PROJECT" >&2; exit 1; }
DID="$(grep -oE '^FEEDGEN_PUBLISHER_DID=.*' .env | head -1 | sed 's/^[^=]*=//; s/^"//; s/"$//')"
[ -n "$DID" ] || { echo "FEEDGEN_PUBLISHER_DID not set in .env" >&2; exit 1; }

FILTERS="${FEEDGEN_FILTERS_PATH:-data/filters.json}"
RKEYS="$(python3 - "$FILTERS" <<'PY'
import json, os, sys
try:
    d = json.load(open(sys.argv[1]))
except Exception:
    d = {}
feeds = d.get("feeds")
# a legacy flat config describes a single feed named by FEEDGEN_SHORTNAME
print(" ".join(feeds) if feeds else os.environ.get("FEEDGEN_SHORTNAME", ""))
PY
)"

# /data is written by the container, so some of it is root-owned on the host.
run_priv() {
  if [ "$(id -u)" -eq 0 ]; then "$@"
  elif sudo -n true 2>/dev/null; then sudo "$@"
  else
    echo "  ! need root for: $*" >&2
    echo "  ! re-run as root, or grant passwordless sudo" >&2
    return 1
  fi
}

STAMP="$(date -u +%Y-%m-%dT%H%M%SZ)"
OUT="${1:-$HOME/backups}/feedgen-$STAMP"
mkdir -p "$OUT/records" "$OUT/docker"

# A failed run must not leave behind something that LOOKS like a bundle. The
# pruner identifies bundles by directory name, so a half-written one would
# occupy the retention cap while being unrestorable, and the only sign would be
# a missing SHA256SUMS that nobody thinks to check. Observed for real: tar
# exited 1 because the live database moved under it, `set -e` stopped the
# script here, and the stump was left on disk.
cleanup_partial() {
  local code=$?
  [ "$code" -eq 0 ] && return 0
  if [ -d "$OUT" ] && [ ! -f "$OUT/SHA256SUMS" ]; then
    echo "!! aborted (exit $code) — removing partial bundle $OUT" >&2
    run_priv rm -rf -- "$OUT"
  fi
}
trap cleanup_partial EXIT

echo "backing up $PROJECT -> $OUT"
echo "  service:       $SERVICE"
echo "  publisher DID: $DID"
echo "  feeds:         ${RKEYS:-(none found)}"

echo "==> database snapshot (service stays up)"
docker compose exec -T "$SERVICE" node -e "
  const D=require('better-sqlite3');
  new D(process.env.FEEDGEN_SQLITE_LOCATION||'/data/db.sqlite',{readonly:true})
    .backup('/data/_bk.sqlite')
    .then(()=>process.exit(0)).catch(e=>{console.error(e);process.exit(1)})"
run_priv mv data/_bk.sqlite "$OUT/db.sqlite"
run_priv chown "$(id -u):$(id -g)" "$OUT/db.sqlite"

echo "==> project tarball (includes .env)"
tar czf "$OUT/project.tar.gz" \
  --exclude=./node_modules --exclude=./data --exclude=./.git --exclude=./dist \
  -C "$PROJECT" .

echo "==> data directory"
# Everything EXCEPT purgePosts' own database snapshots. Each applied sweep
# copies the whole database beside it, and those copies are never cleaned up:
# by 2026-08-09 there were 38 of them, 24 MB against a 648 KB database, and
# every one was going into every nightly bundle. This bundle already carries a
# consistent db.sqlite taken through SQLite's backup API a few lines above, so
# the excluded files are backups of a backup — and their weight was quietly
# eating the standby's 300 MB retention: dailies had grown 5 -> 12 MB and the
# cap that was meant to hold two months was down to about three weeks.
# The purged-*.json dumps stay: they are small, and the admin page reads them.
#
# The LIVE database and its sidecars are excluded too, and that is a fix, not a
# saving. SQLite creates and deletes `db.sqlite-journal` constantly under an
# ingest that never stops, so tar kept exiting 1 with "File removed before we
# read it" — under `set -e` that aborted the whole backup. It failed on the
# primary the first time this ran there. What was being copied was a TORN read
# of a file the bundle already carries a consistent snapshot of, taken through
# SQLite's backup API a few lines up, and RESTORE.md has always overwritten the
# torn one with it. So the exclusion removes a race and a booby trap at once.
#
# AND tar's exit 1 is tolerated here, which is the other half of the fix.
# tar returns 1 for "some files differ" — over a directory a running service
# writes to, that means a journal file appeared or vanished mid-read, not that
# the archive is unusable. 2 is a real error. Under `set -e` the 1 was aborting
# the entire backup, and since it depends on whether the ingest happened to
# touch data/ inside the tar window, it is a COIN FLIP: the nightly had been
# succeeding on luck, and a night it lost would have left only a line in a log.
# Both boxes reproduced it within minutes of each other on 2026-08-09.
data_rc=0
run_priv tar czf "$OUT/data.tar.gz" \
  --exclude='data/db-backup-purge-*.sqlite' \
  --exclude='data/db.sqlite*' \
  -C "$PROJECT" data || data_rc=$?
if [ "$data_rc" -gt 1 ]; then
  echo "tar failed with status $data_rc" >&2
  exit 1
fi
# The `|| true` is load-bearing under `set -e`: a bare `[ ] && echo` is the last
# command of an and-or list, so a FALSE test would abort the backup here — the
# same class of bug as the one being fixed three lines up.
if [ "$data_rc" -eq 1 ]; then
  echo "    (data/ changed while reading — normal on a live box; the database is snapshotted separately above)"
fi
run_priv chown "$(id -u):$(id -g)" "$OUT/data.tar.gz"

echo "==> feed records"
for rkey in $RKEYS; do
  if curl -sS --fail \
    "https://public.api.bsky.app/xrpc/com.atproto.repo.getRecord?repo=$DID&collection=app.bsky.feed.generator&rkey=$rkey" \
    -o "$OUT/records/$rkey.json"; then echo "    $rkey"
  else echo "    $rkey — NOT FOUND (is it published?)" >&2; fi
done

echo "==> PLC document"
curl -sS --fail "https://plc.directory/$DID" -o "$OUT/plc.json" || echo "    PLC fetch failed" >&2

echo "==> docker state"
docker compose config > "$OUT/docker/compose-resolved.yml" 2>/dev/null || true
docker inspect "$(docker compose ps -q "$SERVICE")" > "$OUT/docker/container.json" 2>/dev/null || true
IMAGES="$(docker compose config --images 2>/dev/null || true)"   # see the SIGPIPE note above
docker image inspect "${IMAGES%%$'\n'*}" \
  > "$OUT/docker/image.json" 2>/dev/null || true

# Row counts straight from the snapshot, so the file says how fresh it is
# without anyone having to open the database.
ACTIVE_ENDPOINT="$(grep -oE '^FEEDGEN_SUBSCRIPTION_ENDPOINT=.*' .env | head -1 | sed 's/^[^=]*=//; s/^"//; s/"$//')"
STATE="$(python3 - "$OUT/db.sqlite" "$ACTIVE_ENDPOINT" <<'PY'
import datetime, sqlite3, sys
try:
    c = sqlite3.connect(f"file:{sys.argv[1]}?mode=ro", uri=True)
    active = sys.argv[2] if len(sys.argv) > 2 else ""
    print("| feed | rows | newest entry |")
    print("|---|---|---|")
    for feed, n, mx in c.execute(
        "select feed, count(*), max(indexedAt) from post group by feed order by feed"
    ):
        print(f"| `{feed}` | {n} | {mx} |")
    print()
    # A previous endpoint leaves its row behind; only one of these is live.
    for svc, cur in c.execute("select service, cursor from sub_state order by cursor desc"):
        when = datetime.datetime.fromtimestamp(cur / 1e6, datetime.timezone.utc)
        tag = " **(active)**" if svc == active else " (stale — a previously used endpoint)"
        print(f"- `{svc}`{tag} at `{when.isoformat().replace('+00:00', 'Z')}`")
except Exception as e:
    print(f"(could not read the snapshot: {e})")
PY
)"

cat > "$OUT/RESTORE.md" <<EOF
# feedgen backup — $STAMP

Taken from \`$PROJECT\` while the service was running.

> **Contains secrets.** \`project.tar.gz\` includes \`.env\`, and
> \`docker/compose-resolved.yml\` has its values expanded inline. Keep this
> directory off anything public.

Publisher DID: \`$DID\`
Feeds: ${RKEYS:-(none)}

## State at capture

$STATE

## Restore the whole box

\`\`\`bash
mkdir -p ~/feedgen && cd ~/feedgen
tar xzf project.tar.gz
tar xzf data.tar.gz          # recreates ./data, WITHOUT the database
cp db.sqlite data/db.sqlite  # <- not optional: the tarball has no db.sqlite
docker compose build && docker compose up -d
\`\`\`

The live database is deliberately not inside \`data.tar.gz\`: copying it while
the service writes to it produces a torn file, and the \`db.sqlite\` beside this
file is a consistent snapshot taken through SQLite's own backup API. The
per-sweep \`db-backup-purge-*.sqlite\` copies are left out for size.

\`.env\` comes back with the tarball, so the tunnel and service DID work with
no further setup.

## Restore only the database

Stop the service first — do not swap the file under a live writer.

\`\`\`bash
docker compose stop $SERVICE
cp db.sqlite data/db.sqlite
docker compose start $SERVICE
\`\`\`

The subscription cursor lives in this file, so the service resumes from the
snapshot and replays the gap. Duplicates are impossible, but Jetstream only
retains about a day of playback — a longer gap stays missing.

## Restore a deleted feed record

\`yarn restoreFeed <rkey>\` needs both halves, carried in \`data.tar.gz\`:
\`data/feed-record-backup-<rkey>.json\` and \`data/feed-avatar-<rkey>.bin\`.
The copies in \`records/\` here were fetched live and are useful for diffing
against what is published now.

## Verify

\`\`\`bash
sha256sum -c SHA256SUMS          # shasum -a 256 -c SHA256SUMS on macOS
python3 -c "import sqlite3;print(sqlite3.connect('db.sqlite').execute('pragma integrity_check').fetchone()[0])"
\`\`\`
EOF

echo "==> checksums"
( cd "$OUT" && find . -type f ! -name SHA256SUMS -print0 | sort -z | xargs -0 sha256sum > SHA256SUMS )

echo
echo "done: $OUT"
du -sh "$OUT"
