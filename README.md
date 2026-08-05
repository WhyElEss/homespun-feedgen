# homespun-feedgen

Self-hosted [Bluesky feed generator](https://github.com/bluesky-social/feed-generator) tuned for small boxes — a Raspberry Pi is plenty. Born from migrating a live vinyl-community feed off SkyFeed without losing a single subscriber; generalized so you can do the same.

**What you get over the official starter kit:**

- **[Jetstream](https://github.com/bluesky-social/jetstream) instead of the raw firehose** — lightweight JSON over WebSocket, server-side collection filtering. A fraction of the CPU and traffic; this is what makes a Pi comfortable.
- **SQLite on disk** with a persisted cursor — restarts and reboots lose nothing.
- **Many feeds, one process** — all your feeds share a single Jetstream connection, one database and one tunnel. Each keeps its own patterns, its own moderation list and its own retention window.
- **Hot-reloadable filters in one JSON file** (`data/filters.json`) — regex include/exclude with SkyFeed-compatible semantics, author-DID feeds, GIF/quote-post toggles, moderation-list exclusion. Edit the file; the running service picks it up in ~10 seconds. A broken edit is rejected — the service keeps the previous config and logs the error.
- **Cloudflare Tunnel** in the same compose stack — HTTPS on port 443 with no port forwarding and no public IP.
- **`did:plc` service identity** — the hostname lives in a service entry, not in the DID, so moving domains keeps every feed's URI, likes and subscribers ([DOMAIN-MOVE.md](DOMAIN-MOVE.md)). Includes a script that handles email-2FA accounts.
- **A SkyFeed migration kit** — take over an existing feed in place, keeping its AT-URI, subscribers and likes. Plus a disaster-recovery script, because SkyFeed deletes the live record more readily than you would expect (see below — this one bites).
- **Diagnostics** — `whyNot.ts` explains stage-by-stage why a given post did or didn't get into your feed; `probeJetstream.js` measures the lag of all public Jetstream instances (yes, one of them can silently fall an hour behind).

Everything below assumes Docker + the compose plugin on a 64-bit host (`uname -m` → `aarch64` on a Pi).

## Quickstart (new feed)

```bash
git clone https://github.com/WhyElEss/homespun-feedgen.git
cd homespun-feedgen

cp .env.example .env        # fill in: hostname, publisher DID, service DID
chmod 600 .env
mkdir -p data
cp filters.example.json data/filters.json   # declare your feeds here

docker compose up -d --build feedgen
docker compose logs -f feedgen
# expect: "filters: my-feed (…) — N include / M exclude patterns, …"
#         "algos: serving 1 feed(s): my-feed"
#         "jetstream: connecting to wss://..."
```

Which feeds exist is decided by `data/filters.json`, not by the environment: every key under `feeds` is one feed, and the key is the record key you publish it under.

### Expose it

What the protocol needs is one thing: **a stable public HTTPS address with a valid certificate**, which Bluesky's AppView can call `getFeedSkeleton` on. Nothing here has to be reachable from your LAN, and nothing needs a public IP or a forwarded port.

That address is the only load-bearing use of `FEEDGEN_HOSTNAME`: `setupServiceDid` writes it into your DID document as the `#bsky_fg` service endpoint, and that is where Bluesky will knock. (The `/.well-known/did.json` route uses it too, but only as the `did:web` fallback — with a `did:plc` service identity, which is what this project recommends, that route deliberately answers 404.)

#### Cloudflare Tunnel — the tested path, needs a domain

1. Cloudflare dashboard → **Networking → Tunnels → Create a tunnel** (type **Cloudflared**). On the environment screen pick **Docker** and copy only the token string after `--token` into `.env` as `TUNNEL_TOKEN`.
2. `docker compose up -d cloudflared-feedgen` — the tunnel goes **Healthy**.
3. Add a route (Published application): your subdomain + domain, Service URL **`http://feedgen:3000`**.
4. Check: `curl https://feed.example.com/xrpc/app.bsky.feed.describeFeedGenerator`

A **named** tunnel needs a domain on your Cloudflare account. This is the configuration this project actually runs on, and the one the rest of the README assumes.

#### Without a domain

A domain is **not** a protocol requirement — a hostname handed to you by a provider satisfies it just as well, as long as it is stable and serves valid HTTPS. Things that fit the shape of this service (a long-running process, a SQLite file on disk, an outbound WebSocket to Jetstream):

- **Tailscale Funnel** — `machine.tailnet.ts.net`, free, stable across restarts;
- **Fly.io** — `yourapp.fly.dev`, with a volume for `data/`;
- any small VPS or PaaS that gives you a fixed subdomain and terminates TLS for you.

Drop the `cloudflared-feedgen` service from `docker-compose.yml`, put whatever that provider gives you in `FEEDGEN_HOSTNAME`, and point it at the container's port 3000. Everything else in this README is unchanged.

**Only the Cloudflare path above is tested here.** The alternatives satisfy the requirement as stated; none of them has been run against this project, so treat them as directions rather than recipes.

**What does not work: Cloudflare quick tunnels** (`*.trycloudflare.com`) and anything else with an ephemeral hostname. The address is not a runtime setting — it is written into your DID document. Changing it is a signed PLC operation needing your main account password and an emailed code, so a name that moves on every restart is unusable, not merely inconvenient.

#### Why a domain is still strongly recommended

Fifteen dollars a year buys exactly one thing, and it is the right one: **freedom to move hosting without touching your feeds' identity.**

- With `did:plc` and your own domain, moving to another machine, another country or another provider is a DNS or tunnel change. The DID does not move, the feed records do not change, and likes and subscribers — which hang off the record's AT-URI — never notice. That is what makes a hot standby on a second box a dashboard action rather than a migration.
- With a provider's hostname you are tied to that provider. Leaving means editing the PLC document: doable, yours to do, but it needs the main account password and an emailed code every time.
- With `did:web` and no domain of your own you would be stuck for good: there the hostname is baked into the DID itself, so moving means a **new DID — a new feed, with no likes and no subscribers.** This is precisely why `setupServiceDid` exists and why `did:plc` is not optional advice when you start on a borrowed hostname.

A Bluesky account is required either way, since it publishes the feed records — but the default `you.bsky.social` is fine. Using a domain as your *handle* is a separate, entirely optional thing.

#### Changing the hostname later

Possible, planned for, and undramatic — **[DOMAIN-MOVE.md](DOMAIN-MOVE.md)** is the runbook. The short version: your DID contains no hostname, so feed records, AT-URIs, likes and subscribers do not move with the domain. Only the `#bsky_fg` service endpoint does, and the trick is to serve both hostnames at once and flip the endpoint in the middle, because Bluesky caches DID documents for a while after the change.

### Service DID (recommended: your own `did:plc`)

Adds a `#bsky_fg` service entry to your account's DID document, so the feed survives future domain moves. Needs your MAIN account password (not an app password) and a code sent to the account email; email-2FA sign-in codes are handled.

```bash
docker compose run --rm feedgen yarn setupServiceDid
```

### Publish

```bash
docker compose run --rm feedgen yarn publishFeed
# recordName must equal the feed's key in data/filters.json
```

Run it once per feed. A feed whose record key has no entry in `filters.json` is not served, and a feed in `filters.json` with no published record is simply never asked for.

## Migrating a feed from SkyFeed (keep your subscribers)

Subscriptions and likes reference the feed's **AT-URI** (`at://<your-did>/app.bsky.feed.generator/<rkey>`). Keep the rkey — keep the audience. The plan:

> ### Read this before you touch SkyFeed
>
> **Two different SkyFeed actions delete your live record: the "unpublish" button, and removing the feed from the builder list.** The second one is not obvious and there is no warning. There is no safe way to "tidy up in SkyFeed first".
>
> Deleting the record also makes the PDS garbage-collect its **avatar blob**, so a later restore cannot reuse the old blob reference — it has to re-upload the image bytes. **Save the record JSON *and* the avatar image before you start.**
>
> So: repoint first, then leave the orphaned SkyFeed entry alone forever.

**Back up first** — one command per feed, before anything else:

```bash
PDS=https://<your-pds>; DID=<your-did>; RKEY=<rkey>
curl -s "$PDS/xrpc/com.atproto.repo.getRecord?repo=$DID&collection=app.bsky.feed.generator&rkey=$RKEY" \
  > data/feed-record-backup-$RKEY.json
CID=$(python3 -c "import json;print(json.load(open('data/feed-record-backup-'+'$RKEY'+'.json'))['value']['avatar']['ref']['\$link'])")
curl -s "$PDS/xrpc/com.atproto.sync.getBlob?did=$DID&cid=$CID" > data/feed-avatar-$RKEY.bin
```

Then:

1. Find your feed's record: `https://<your-pds>/xrpc/com.atproto.repo.listRecords?repo=<your-did>&collection=app.bsky.feed.generator`. The rkey is the last URI segment — SkyFeed's are 13-character TIDs rather than readable names. Use it as the feed's key in `data/filters.json`.
2. Port your SkyFeed blocks: the positive regex block → `includePatterns`, each inverted block → an entry in `excludePatterns`, a `did` input block → `includeDids`, a "remove by list" block → `excludeListUri`, `firehoseSeconds` → `retention`. Copy each block's `target` onto the pattern. Replies and reposts need nothing (dropped automatically / never indexed).
   **Strip the leading `(?i)`** from SkyFeed patterns — it is Python/Go syntax and a `SyntaxError` in JS under the `u` flag, so the service will not start. The default `iu` flags already make patterns case-insensitive.
3. Run the stack (steps above, including `setupServiceDid`) and let the database fill for a day — until then SkyFeed keeps serving the feed; there is no downtime window.
4. Flip the record: `docker compose run --rm feedgen yarn repointFeed <rkey>` — backs up the original to `./data/`, changes only its `did` to your service DID (name, description, avatar, createdAt stay), drops the `skyfeedBuilder` block, and makes you type the rkey before writing.
5. Verify: `curl "https://public.api.bsky.app/xrpc/app.bsky.feed.getFeedGenerator?feed=at://<did>/app.bsky.feed.generator/<rkey>"` → `"isOnline": true, "isValid": true`, likeCount intact.
6. Leave the feed alone in SkyFeed. Do not tidy it up.

If the record does get deleted anyway:

```bash
docker compose run --rm feedgen yarn restoreFeed <rkey>
```

It recreates the record at the same rkey from `data/feed-record-backup-<rkey>.json`, re-uploads the avatar from `data/feed-avatar-<rkey>.bin`, and points it at your service in the same write. Subscribers' pins and likes live in *their* repos and survive the outage — move fast and most of the audience never notices. Expect feed *search* to take longer to recover than the feed itself.

## Filters

`data/filters.json`, hot-reloaded. See `filters.example.json` for the shape:

```json
{ "feeds": { "<rkey>": { …config… }, "<rkey>": { … } } }
```

Per feed:

| Key | Meaning |
|---|---|
| `includePatterns` | post enters the feed if ANY pattern matches |
| `excludePatterns` | ...and NO pattern matches |
| `includeDids` | author allowlist — a feed of everything one or more accounts post. Works alone (no patterns needed) or together with them |
| `excludeListUri` | optional `at://` URI of a Bluesky list; members' posts are dropped (refreshed hourly; feeds sharing a list share the fetch) |
| `gifPosts`, `quotePosts`, `selfLabeledPosts` | `allow` \| `exclude` \| `only` |
| `pinnedPost` | optional `at://` URI of a post to serve first, with the client's **Pinned** badge — see below |
| `retention` | `{"type":"hours","value":72}` or `{"type":"count","value":500}` — how much of this feed is kept |
| `displayName` | comment only; the name users see lives in the published record |

Each pattern is `{ "pattern": "...", "target": "...", "flags": "iu", "comment": "..." }`. `target` picks what the pattern is tested against and mirrors SkyFeed's block targets:

| `target` | Matches against |
|---|---|
| `text` | the post text only |
| `text\|alt_text` | text + image/video alt text — **default for include** |
| `text\|alt_text\|link` | the above + external card URL/title/description and link facets — **default for exclude**; catches bots whose only stable signal is a link domain |

A feed needs at least one `includePattern` or one `includeDid`; one with neither is refused rather than matched against the whole firehose. Replies are always dropped. A post matching several feeds is stored once per feed, so each feed's retention prunes independently.

Adding or removing a **feed** requires a restart (the routing table is built at startup); editing an existing feed's config is picked up live. The service warns in the log if a hot reload introduces a feed it cannot route.

Test a config without touching the service:

```bash
yarn test:filters                      # runs against filters.example.json
FEEDGEN_FILTERS_PATH=./data/filters.json yarn test:filters   # ...or your real one
yarn test:gc                           # retention logic, throwaway database
yarn test:pinned                       # pinned post, throwaway database
```

### Pinned post

```json
"pinnedPost": "at://did:plc:xxxxxxxxxxxxxxxxxxxxxxxx/app.bsky.feed.post/yyyyyyyyyyyyy"
```

The post is served first on the feed's first page, tagged
`app.bsky.feed.defs#skeletonReasonPin`, which the AppView turns into
`#reasonPin` and the client draws as a **Pinned** badge. A welcome post, the
feed's rules, a link to the contributor list.

Worth knowing:

- **It is a hot-reloaded config value, not code.** The handler reads it per
  request, so changing or removing the pin takes effect on the next reload
  (~10s after saving `filters.json`) with no restart and no rebuild.
- **The post does not have to belong to the feed.** Nothing is validated
  against the filters, or against the DB — the skeleton just names a URI and
  the AppView hydrates it. A rules post that no `includePattern` would ever
  match works fine.
- **It appears exactly once.** If the post also matches the feed normally, it
  is suppressed from its chronological position while pinned, and returns
  there when the field is removed.
- **The page keeps its size.** With a pin, one fewer row is read from the
  database, so a `limit=30` request still answers with 30 items. `limit=1` is
  served without the pin, since the page would otherwise carry no row to build
  a cursor from.
- **A dead URI fails silently.** Typos in the shape (a `bsky.app` link, a wrong
  collection) are rejected on load with an error in the log and the previous
  config kept. But a well-formed URI pointing at a deleted or blocked post is
  dropped during hydration: the item just does not appear, and nothing is
  logged. If a pin does not show up, check the post is still live.

## Operations

```bash
# why is/isn't a post in the feed?
docker compose run --rm feedgen yarn whyNot "https://bsky.app/profile/<handle>/post/<rkey>"

# run the cleanup automatically whenever filters or the moderation list change
# (host cron, every 5 min; see the notes below before enabling)
*/5 * * * * NTFY_TOPIC=your-topic /bin/bash /path/to/cron-tasks/auto-purge.sh

# clean junk out of a feed (dry run unless you add --apply)
docker compose run --rm feedgen yarn purgePosts --rejected   # what the current filters would no longer accept
docker compose run --rm feedgen yarn purgePosts --blocked    # authors now on the moderation list
docker compose run --rm feedgen yarn purgePosts --author @someone.bsky.social
docker compose run --rm feedgen yarn purgePosts --uri "https://bsky.app/profile/<handle>/post/<rkey>"

# feed serves stale posts? measure Jetstream instance lag, switch instance in .env
docker compose run --rm feedgen node scripts/probeJetstream.js

# retro-capture posts after widening filters: stop, rewind cursor, start —
# Jetstream replays the window; duplicates are impossible (INSERT ... ON CONFLICT DO NOTHING).
#
# Three things to know first:
#  * The cursor belongs to the subscription endpoint, NOT to a feed. Every feed
#    this instance serves replays together. Rewinding past the point a feed's
#    own content already reaches backfills that feed with older posts. The
#    dangerous case is a count-retention feed: the backfill competes with live
#    posts for the window and can evict them.
#  * Jetstream's playback buffer is finite (order of a day). A cursor older than
#    the buffer is NOT honoured — the stream silently starts at the oldest
#    retained event, so you may backfill far less than you asked for. Verify
#    what actually landed; the cursor value alone will not tell you.
#  * Rows carry the event's own timestamp, so replayed posts land in their true
#    position in the feed rather than on top of it. Rewinding further back than
#    a feed's retention window therefore achieves nothing.
docker compose stop feedgen
docker compose run --rm --no-deps feedgen node -e "
  const db=require('better-sqlite3')('/data/db.sqlite');
  db.prepare('update sub_state set cursor=? where service=?')
    .run(Date.parse('2026-07-29T11:00:00Z')*1000,
         process.env.FEEDGEN_SUBSCRIPTION_ENDPOINT)"
docker compose start feedgen

# replace a feed's avatar (name the rkeys, or omit them for every feed that has a logo file)
cp new-logo.png data/feed-logo-<rkey>.png
docker compose run --rm feedgen yarn setFeedAvatar <rkey>

# edit a feed's description (everything else on the record is carried over)
$EDITOR data/feed-description-<rkey>.txt
docker compose run --rm feedgen yarn setFeedDescription <rkey>

# full backup: database, project (with .env), data/, feed records, PLC document,
# docker state and a checksum manifest. Service keeps running.
# NOTE: runs on the host, not inside the container — it drives docker itself.
bash scripts/backupAll.sh ~/backups

# just the database, without stopping the service (consistent snapshot of a live SQLite file)
docker compose exec feedgen node -e "
  const D=require('better-sqlite3');
  new D('/data/db.sqlite',{readonly:true}).backup('/data/_bk.sqlite')
    .then(()=>process.exit(0)).catch(e=>{console.error(e);process.exit(1)})"
mv data/_bk.sqlite ~/backup.sqlite
```

`backupAll.sh` takes everything you would need to rebuild the box: the database (through SQLite's own backup API, so the copy is consistent rather than a torn read of a live file), the project tree **including `.env`**, all of `data/` — filters, logos, avatar blobs, record backups — every feed record as currently published, the service DID's PLC document, the resolved docker state, a generated `RESTORE.md` and a `SHA256SUMS` manifest. The service stays up throughout. It picks the first compose service by default; set `FEEDGEN_SERVICE` if yours is ordered differently, and note it needs root for the parts of `data/` the container wrote as root. **The output contains secrets** — `.env` and the expanded compose config — so keep it somewhere private.

### Editing the config from outside

`validateFilters(raw)` checks a candidate and returns the compiled feeds, or throws with the offending path. `writeFilters(raw)` validates and then persists it — to a temporary file in the same directory, renamed into place, so a reader either sees the old config or the new one and never a half-written file. Hand-editing survives a torn read (the reload just fails and the previous config is kept); something saving on every keystroke would not.

Set `FEEDGEN_ADMIN_PORT` to expose a small read/validate API — `GET /admin/filters`, `POST /admin/filters/validate`. It is a **separate listener** from the feed API, bound to `127.0.0.1` unless you set `FEEDGEN_ADMIN_HOST`, and it does not exist unless you configure the port. Reach it over an SSH tunnel. There is deliberately no write endpoint: writing is available in-process through `writeFilters`, and putting it on HTTP is a decision to take deliberately rather than by accident.

### The admin UI

Set `FEEDGEN_ADMIN_UI="on"` and the service also serves a password-protected page at **`/admin` on the public app** — the same app your tunnel points at, so it is reachable wherever your feed is. It shows what the box is doing: ingest lag per Jetstream cursor, stored posts and time span per feed, the retention and pattern counts each feed is running, and the digest and mtime of `filters.json`. It is **read-only**; the config routes behind it are the same read/validate pair as above, and there is still no write endpoint.

Putting an admin surface on a public hostname is a real decision, so the guard rails are not optional:

```bash
yarn adminPassword        # prompts twice, prints the .env lines
```

* the password is stored only as a scrypt hash, and hashing is async so a login cannot stall the ingest loop it shares a process with;
* **with `FEEDGEN_ADMIN_UI=on` and no valid hash, the service refuses to start.** An unauthenticated admin page on a public hostname is the one failure this must not have, and refusing to boot is the only version of it nobody misses;
* sessions live server-side, the cookie carries a random token and nothing else, and it is `HttpOnly`, `SameSite=Strict`, scoped to `/admin`, and `Secure` whenever the request arrived over HTTPS;
* failed logins are rate limited per client address and globally — the global limiter is what still holds when someone reaches the service directly and forges `CF-Connecting-IP`;
* the page loads no external resource, so its Content-Security-Policy forbids everything but its own inline style and script, and `frame-ancestors 'none'` keeps the login form out of an iframe.

`FEEDGEN_BOX_NAME` labels the box in the UI, and `FEEDGEN_ADMIN_MODE` (`readonly` by default, or `rw`) says whether this box is the one whose config may be edited — today that only sets the label, and write endpoints will require it when they exist.

**If you run a standby, leave `FEEDGEN_ADMIN_UI` unset on it.** It runs the same image from the same tree and answers on its own hostname, so a `.env` copied from the primary is all it takes to publish a second login page — and, once writes exist, to let someone edit a config that the next sync will overwrite. `yarn test:adminauth` covers the refusals: the guard, the rate limiter, session expiry, cross-origin posts, and that the snapshot carries no secret.

`validateFilters(raw)` in `src/filter.ts` checks a candidate config and returns the compiled feeds, or throws with the offending path — `feeds["abc"].includePatterns[2]: …`. It does **not** install what it validated, so anything editing the config from outside (an admin UI, a pre-commit hook, a deploy check) can ask whether an edit is valid before writing it to disk, instead of writing it and reading the log. `yarn test:validate` covers the error messages and that property.

`auto-purge.sh` runs that cleanup for you. It watches the two things that decide what belongs in a feed — the hash of `data/filters.json`, and a hash of the DID set the moderation list actually hydrates — and when one changes it runs *only the mode that change implies*: an edited filter triggers `--rejected`, a new blocklist entry triggers `--blocked`. That split matters, because `--rejected` re-hydrates every stored post from the AppView and has no business running just because you blocked somebody. The hash checks are cheap and run on the host; a container only starts when something really changed.

**The safety limit is the point of the design.** A valid-but-wrong regex — a `.` you meant to escape, a lost anchor — passes hot-reload validation and would quietly empty the feed. So every trigger runs a dry run first, and applies only if the count is under both an absolute cap (`AUTO_PURGE_MAX_ABS`, default 25) and a proportional one (`AUTO_PURGE_MAX_PCT`, default 5% of stored rows), whichever is smaller. Over that, nothing is deleted: the run is recorded in `auto-purge.withheld` and a notification goes out for a human to look. Set `NTFY_TOPIC` to get those pushes ([ntfy.sh](https://ntfy.sh)); leave it unset and it only logs. Keep messages short — an ntfy topic is readable by anyone who knows its name. Run it on each box independently; there is no cross-machine ordering to get wrong.

`purgePosts` exists because the service only ever *adds* rows. Tightening a filter stops new junk but leaves what is already indexed; adding someone to the moderation list blocks their future posts but not their past ones. Both cleanups used to mean writing a one-off script — this is that script, kept. `--rejected` replays the live filter over everything stored and removes whatever the current config would no longer accept (narrow it with `--reason <substring>` when you have just edited one pattern and only want its casualties); `--blocked` catches up on moderation-list additions; `--author` and `--uri` are the blunt instruments. Verdicts come from `src/filter.ts`, the same code the service and `whyNot` use, so this cannot drift from what is actually being served. Every mode is a dry run that prints what it found; `--apply` snapshots the database and writes a JSON dump of the deleted rows next to it before touching anything.

`setFeedDescription` is the same idea for the description: it reads the new text from `data/feed-description-<rkey>.txt`, checks it against the lexicon's 300-grapheme / 3000-byte limits *before* asking for a password, backs the record up, shows you a before/after and makes you type the rkey to confirm, then writes with `swapRecord` so a concurrent edit fails the write instead of being silently clobbered. It retries 5xx — the PDS does occasionally return a bare 500 on a payload it has no reason to reject. Note that it changes the description and nothing else: a record update makes the AppView reingest and serve the new text within minutes, but it will **not** move the feed in feed search — ranking there is a separate structure. That was tested; don't reach for this expecting it.

`setFeedAvatar` touches only the record's `avatar` field — name, description, `createdAt` and the AT-URI are carried over, so likes and subscribers are untouched. It validates every image before asking for your password, does the whole set behind one login (email 2FA makes per-feed logins tedious), copies the outgoing record *and* its avatar blob to `data/avatar-backup-<stamp>/`, and then refreshes `data/feed-record-backup-<rkey>.json` and `data/feed-avatar-<rkey>.bin` so `restoreFeed` keeps matching what is actually live. PNG or JPEG, under 1 MB — the lexicon accepts nothing else.

> **If you write your own tooling against records with blobs, read this.** The XRPC client does not hand a record's blob back in wire shape: `record.avatar` comes back as a `BlobRef` whose `.ref` is a `CID` instance, so `record.avatar.ref.$link` is `undefined` — and an optional chain off it evaluates to nothing *without throwing*. Read the CID with `JSON.parse(JSON.stringify(blob)).ref.$link` (or `blob.ref.toString()`). Here that silence cost a real image: the blob-backup step logged no error while writing no file, and the PDS garbage-collected the displaced avatar within minutes of it losing its last reference.
>
> A second trap in the same code path: `agent.com.atproto.sync.getBlob` fails against `bsky.social`, which answers with a **302 to the account's real PDS host** that the XRPC client does not follow. Fetch the blob over plain HTTP with redirects enabled instead. Set `PDS_URL` if you are not on `bsky.social`.

## Upgrading from a single-feed install

Releases before multi-feed support ran one feed named by `FEEDGEN_SHORTNAME`. To upgrade:

1. **Keep `FEEDGEN_SHORTNAME` set to its current value** while you upgrade. Database migration `002` files every existing row under that name, and it is also the key a legacy-shaped `filters.json` is read as. Get it wrong and your posts end up filed under a feed nobody serves.
2. Rewrite `data/filters.json` into the `{"feeds": {...}}` shape, using that same value as the key. A legacy flat config still loads (with a warning), so this can happen after the upgrade rather than during it.
3. Rehearse the database migration on a copy before running it for real:
   ```bash
   cp data/db.sqlite /tmp/rehearsal.sqlite
   docker compose run --rm -e FEEDGEN_SQLITE_LOCATION=/data/../tmp/rehearsal.sqlite \
     feedgen yarn checkMigration
   ```
   It prints the resulting schema, the row count per feed, and fails loudly if the row count changed.
4. `yarn migrateFeed` and `yarn restoreFeed` were replaced by `yarn repointFeed <rkey>` and `yarn restoreFeed <rkey>`, which take the feed as an argument instead of reading `FEEDGEN_SHORTNAME`. The new `restoreFeed` re-uploads the avatar from `data/feed-avatar-<rkey>.bin` rather than reusing the old blob reference — the old reference is dead once a record has been deleted.

## Credits

Built on the official [bluesky-social/feed-generator](https://github.com/bluesky-social/feed-generator) starter kit (MIT). Jetstream event format per the [official README](https://github.com/bluesky-social/jetstream). A thank-you to [SkyFeed](https://skyfeed.app) — where the feed this project was extracted from spent its first years.

MIT, see [LICENSE](LICENSE).
