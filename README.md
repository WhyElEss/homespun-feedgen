# homespun-feedgen

Self-hosted [Bluesky feed generator](https://github.com/bluesky-social/feed-generator) tuned for small boxes — a Raspberry Pi is plenty. Born from migrating a live vinyl-community feed off SkyFeed without losing a single subscriber; generalized so you can do the same.

**What you get over the official starter kit:**

- **[Jetstream](https://github.com/bluesky-social/jetstream) instead of the raw firehose** — lightweight JSON over WebSocket, server-side collection filtering. A fraction of the CPU and traffic; this is what makes a Pi comfortable.
- **SQLite on disk** with a persisted cursor — restarts and reboots lose nothing.
- **Hot-reloadable filters in one JSON file** (`data/filters.json`) — regex include/exclude with SkyFeed-compatible semantics, GIF/quote-post toggles, moderation-list exclusion. Edit the file; the running service picks it up in ~10 seconds. A broken edit is rejected — the service keeps the previous config and logs the error.
- **Cloudflare Tunnel** in the same compose stack — HTTPS on port 443 with no port forwarding and no public IP.
- **`did:plc` service identity** (survives domain changes), with a script that handles email-2FA accounts.
- **A SkyFeed migration kit** — take over an existing feed in place, keeping its AT-URI, subscribers and likes. Plus a disaster-recovery script for the classic "unpublish" accident.
- **Diagnostics** — `whyNot.ts` explains stage-by-stage why a given post did or didn't get into your feed; `probeJetstream.js` measures the lag of all public Jetstream instances (yes, one of them can silently fall an hour behind).

Everything below assumes Docker + the compose plugin on a 64-bit host (`uname -m` → `aarch64` on a Pi).

## Quickstart (new feed)

```bash
git clone https://github.com/WhyElEss/homespun-feedgen.git
cd homespun-feedgen

cp .env.example .env        # fill in: hostname, publisher DID, shortname
chmod 600 .env
mkdir -p data
cp filters.example.json data/filters.json   # put your regexes here

docker compose up -d --build feedgen
docker compose logs -f feedgen
# expect: "filters: loaded N include / M exclude patterns"
#         "jetstream: connecting to wss://..."
```

### Expose it: Cloudflare Tunnel

1. Cloudflare dashboard → **Networking → Tunnels → Create a tunnel** (type **Cloudflared**). On the environment screen pick **Docker** and copy only the token string after `--token` into `.env` as `TUNNEL_TOKEN`.
2. `docker compose up -d cloudflared-feedgen` — the tunnel goes **Healthy**.
3. Add a route (Published application): your subdomain + domain, Service URL **`http://feedgen:3000`**.
4. Check: `curl https://feed.example.com/xrpc/app.bsky.feed.describeFeedGenerator`

### Service DID (recommended: your own `did:plc`)

Adds a `#bsky_fg` service entry to your account's DID document, so the feed survives future domain moves. Needs your MAIN account password (not an app password) and a code sent to the account email; email-2FA sign-in codes are handled.

```bash
docker compose run --rm feedgen yarn setupServiceDid
```

### Publish

```bash
docker compose run --rm feedgen yarn publishFeed
# recordName must equal FEEDGEN_SHORTNAME
```

## Migrating a feed from SkyFeed (keep your subscribers)

Subscriptions and likes reference the feed's **AT-URI** (`at://<your-did>/app.bsky.feed.generator/<rkey>`). Keep the rkey — keep the audience. The plan:

1. Find your feed's record: `https://<your-pds>/xrpc/com.atproto.repo.listRecords?repo=<your-did>&collection=app.bsky.feed.generator`. The rkey is the last URI segment (SkyFeed rkeys look like `aaakbsi6aireu`). Set it as `FEEDGEN_SHORTNAME` in `.env`.
2. Port your SkyFeed blocks into `data/filters.json`: the positive regex block → `includePatterns`, each inverted block → an entry in `excludePatterns`, a "remove by list" block → `excludeListUri`. Replies and reposts need nothing (dropped automatically / never indexed). Note: JS RegExp has no inline `(?i)` — case-insensitivity comes from the default `iu` flags.
3. Run the stack (steps above, including `setupServiceDid`) and let the database fill for a day — until then SkyFeed keeps serving the feed; there is no downtime window.
4. **Remove the feed from SkyFeed's builder.** Do this BEFORE the next step, while the record is still SkyFeed's. The builder's **unpublish button deletes the live record** — with the feed listed there, one click nukes it.
5. Flip the record: `docker compose run --rm feedgen yarn migrateFeed` — backs up the original record to `./data/`, changes only its `did` to your service DID (name, description, avatar, createdAt stay), drops the `skyfeedBuilder` block, and confirms before writing.
6. Verify: `curl "https://public.api.bsky.app/xrpc/app.bsky.feed.getFeedGenerator?feed=at://<did>/app.bsky.feed.generator/<rkey>"` → `"isOnline": true, "isValid": true`, likeCount intact.

If the record does get deleted anyway (step 4 skipped, button pressed): `yarn restoreFeed` recreates it at the same rkey from the backup. Subscribers' pins and likes live in *their* repos and survive the outage — move fast and most of the audience never notices. Expect feed *search* to take longer to recover than the feed itself.

## Filters

`data/filters.json`, hot-reloaded. See `filters.example.json` for the shape.

| Key | Meaning |
|---|---|
| `includePatterns` | post enters the feed if ANY pattern matches **text + image/video alt text** |
| `excludePatterns` | ...and NO pattern matches **text + alt + links** (external card URL/title/description + link facets) — catches bots whose only stable signal is a link domain |
| `excludeListUri` | optional `at://` URI of a Bluesky list; members' posts are dropped (refreshed hourly) |
| `gifPosts`, `quotePosts` | `allow` \| `exclude` \| `only` |

Each pattern is `{ "pattern": "...", "flags": "iu", "comment": "..." }` (flags optional, default `iu`). Replies and self-labeled posts are always dropped; posts older than 72 h are garbage-collected (`KEEP_HOURS` in `src/subscription.ts`).

Test a config without touching the service:

```bash
yarn test:filters                      # runs against filters.example.json
```

## Operations

```bash
# why is/isn't a post in the feed?
docker compose run --rm feedgen yarn whyNot "https://bsky.app/profile/<handle>/post/<rkey>"

# feed serves stale posts? measure Jetstream instance lag, switch instance in .env
docker compose run --rm feedgen node scripts/probeJetstream.js

# retro-capture posts after widening filters: stop, rewind cursor, start —
# Jetstream replays the window; duplicates are impossible (INSERT ... ON CONFLICT DO NOTHING)
docker compose stop feedgen
docker compose run --rm --no-deps feedgen node -e "
  const db=require('better-sqlite3')('/data/db.sqlite');
  db.prepare('update sub_state set cursor=?').run(Date.parse('2026-07-29T11:00:00Z')*1000)"
docker compose start feedgen

# backup
docker compose stop feedgen && cp data/db.sqlite ~/backup.sqlite && docker compose start feedgen
```

## Credits

Built on the official [bluesky-social/feed-generator](https://github.com/bluesky-social/feed-generator) starter kit (MIT). Jetstream event format per the [official README](https://github.com/bluesky-social/jetstream). A thank-you to [SkyFeed](https://skyfeed.app) — where the feed this project was extracted from spent its first years.

MIT, see [LICENSE](LICENSE).
