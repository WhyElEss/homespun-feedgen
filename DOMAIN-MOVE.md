# Moving to another domain

Changing the hostname your feeds are served from — `feed.example.com` →
`feed.example.net` — without losing subscribers, likes, or a minute of uptime.

This is a planned procedure, not a repair. Read it through before starting: the
order matters more than any individual step, and one step is signed and
emailed, so it is not something to improvise at midnight.

## What actually depends on the hostname

Less than people expect. Fetch your DID document and look at it:

```bash
curl -s https://plc.directory/did:plc:YOURDID | python3 -m json.tool
```

```jsonc
{
  "id": "did:plc:xxxxxxxxxxxxxxxxxxxxxxxx",      // no hostname anywhere in it
  "alsoKnownAs": ["at://example.com"],            // your HANDLE
  "service": [
    { "id": "#bsky_fg",    "serviceEndpoint": "https://feed.example.com" },
    { "id": "#atproto_pds","serviceEndpoint": "https://….host.bsky.network" }
  ]
}
```

**The DID contains no hostname.** That is the whole reason this project insists
on a `did:plc` service identity. Your feed records point at the DID; likes and
subscriptions hang off each feed's AT-URI, which is the DID plus the record key.
None of that moves when the domain does.

So exactly two things reference your domain, and they are independent:

| | what it is | must change? |
|---|---|---|
| `#bsky_fg` `serviceEndpoint` | where Bluesky calls your service | **yes** |
| `alsoKnownAs` | your account handle | no — optional, see below |

Things that do **not** change: feed records, record keys, AT-URIs, likes,
subscribers, `data/filters.json`, your database.

## The one rule that makes this seamless

**Serve both hostnames at once, and flip the endpoint in the middle.**

The PLC write itself is atomic, but Bluesky's AppView caches DID documents, so
for a while after the flip some requests still arrive at the old name. If the
old name is still routed to the same container, nobody notices anything. If you
retire it the moment you flip, those requests 404 and readers see an empty feed.

Keep the old hostname routed for a couple of weeks. It costs nothing.

## Steps

**1. Back up first.**

```bash
./scripts/backupAll.sh
```

The bundle contains your DID document as it is right now, which is what you
would consult if step 4 went sideways.

**2. Point the new domain at the same tunnel.** Add the domain to your
Cloudflare account, then in the *existing* tunnel add a Public Hostname:
`feed.example.net` → Service `http://feedgen:3000`. Leave the old hostname in
place. Both names now reach the same container.

If you run a standby ([FAILOVER.md](FAILOVER.md)), give its tunnel a hostname on
the new domain too — otherwise your failover target is stranded on a domain you
are retiring.

**3. Verify the new name before touching your identity.**

```bash
curl -s "https://feed.example.net/xrpc/app.bsky.feed.getFeedSkeleton?feed=at://did:plc:YOURDID/app.bsky.feed.generator/YOURFEED&limit=5"
```

Do not proceed until this returns posts. Everything up to here is reversible by
deleting a DNS route; the next step is not.

**4. Move the service endpoint.** Set `FEEDGEN_HOSTNAME` to the new name in
`.env`, then:

```bash
docker compose run --rm feedgen yarn setupServiceDid
```

It reads your current services from `plc.directory`, replaces only `bsky_fg`,
and leaves `atproto_pds` alone. It needs your **main account password** — not an
app password — and a confirmation code sent to your account email. That is the
protocol's design: a PLC operation is signed by the account's rotation key.

**5. Confirm the document changed.**

```bash
curl -s https://plc.directory/did:plc:YOURDID | grep -A2 bsky_fg
```

**6. Bring the rest of your boxes in line.** Update `FEEDGEN_HOSTNAME` in the
standby's `.env` as well. Editing `.env` makes compose recreate the service,
which costs a couple of minutes of ingest that Jetstream replays. This value is
cosmetic on a `did:plc` install — it only feeds the unused `did:web` fallback
and the admin status page — but leaving it stale makes every later diagnosis
harder.

**7. Update your own runbooks.** `FAILOVER.md` names hostnames throughout; so
does whatever you have bookmarked.

**8. Weeks later, retire the old route.** Not before.

## Rolling back

Until step 4 there is nothing to roll back — remove the new route.

After step 4, re-run `setupServiceDid` with the old hostname in
`FEEDGEN_HOSTNAME`. It is the same operation in the other direction, and it
needs another emailed code. This is why step 2 says to leave the old hostname
routed: a rollback into a name that no longer resolves fixes nothing.

## The handle is a separate decision

`alsoKnownAs: at://example.com` is your Bluesky handle, not your service
address. Changing the domain does **not** require changing it, and changing it
does not affect your feeds: the DID stays the same, so records, likes and
subscribers are untouched either way.

If you do want `@example.net`, that is `com.atproto.identity.updateHandle` plus a
`_atproto` TXT record (or `/.well-known/atproto-did`) on the new domain. Bear in
mind the visible cost: your old handle stops resolving, every `@`-mention of it
breaks, and the handle is what clients show as the feed's author.

## If you are not on a domain of your own

The same procedure applies to moving between provider hostnames — `*.ts.net`,
`*.fly.dev` — with step 2 replaced by whatever that provider calls a hostname.
The difference is that you will be doing this every time you change provider,
and each time costs a signed PLC operation with an emailed code. That is the
argument for a domain, spelled out in the README.
