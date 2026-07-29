// Diagnoses why given posts did (not) get into each feed.
// Usage: ts-node scripts/whyNot.ts <bsky.app post URL or at-uri> ...
//        ts-node scripts/whyNot.ts --feed <rkey> <url> ...   (one feed only)
//
// Fetches each post from the public AppView and replays the real filter
// pipeline against the live /data/filters.json, then checks the DB. The
// verdict comes from filter.ts itself — this script deliberately holds no
// copy of the matching logic, so it cannot drift from what the service does.
import Database from 'better-sqlite3'
import {
  loadFiltersOnce,
  matchesFeedVerbose,
  buildHaystacks,
  getExcludeListUris,
  MatchablePost,
  FeedConfig,
} from '../src/filter'

const API = 'https://public.api.bsky.app'

const toAtUri = async (input: string): Promise<string> => {
  if (input.startsWith('at://')) return input
  const m = input.match(/profile\/([^/]+)\/post\/([a-z0-9]+)/i)
  if (!m) throw new Error(`cannot parse: ${input}`)
  let [, actor, rkey] = m
  if (!actor.startsWith('did:')) {
    const res = await fetch(
      `${API}/xrpc/com.atproto.identity.resolveHandle?handle=${actor}`,
    )
    if (!res.ok) throw new Error(`resolveHandle ${actor}: HTTP ${res.status}`)
    actor = ((await res.json()) as { did: string }).did
  }
  return `at://${actor}/app.bsky.feed.post/${rkey}`
}

const fetchListDids = async (uri: string): Promise<Set<string>> => {
  const dids = new Set<string>()
  let cursor: string | undefined
  do {
    const params = new URLSearchParams({ list: uri, limit: '100' })
    if (cursor) params.set('cursor', cursor)
    const res = await fetch(`${API}/xrpc/app.bsky.graph.getList?${params}`)
    if (!res.ok) throw new Error(`getList: HTTP ${res.status}`)
    const data = (await res.json()) as {
      cursor?: string
      items: { subject: { did: string } }[]
    }
    data.items.forEach((i) => dids.add(i.subject.did))
    cursor = data.cursor
  } while (cursor)
  return dids
}

const run = async () => {
  const argv = process.argv.slice(2)
  let onlyFeed: string | undefined
  const flag = argv.indexOf('--feed')
  if (flag !== -1) {
    onlyFeed = argv[flag + 1]
    argv.splice(flag, 2)
  }
  if (argv.length === 0) {
    console.error('usage: whyNot.ts [--feed <rkey>] <post url or at-uri> ...')
    process.exit(2)
  }

  const configs = loadFiltersOnce()
  let feeds: FeedConfig[] = [...configs.values()]
  if (onlyFeed) {
    const one = configs.get(onlyFeed)
    if (!one) throw new Error(`no such feed in filters.json: ${onlyFeed}`)
    feeds = [one]
  }

  // Moderation lists, fetched once per distinct URI
  const listDids = new Map<string, Set<string>>()
  for (const uri of new Set(getExcludeListUris().values())) {
    listDids.set(uri, await fetchListDids(uri))
  }

  const db = new Database('/data/db.sqlite', { readonly: true })
  const inFeed = db.prepare('select 1 from post where uri = ? and feed = ?')

  for (const arg of argv) {
    const uri = await toAtUri(arg)
    console.log(`\n=== ${uri}`)
    const res = await fetch(
      `${API}/xrpc/app.bsky.feed.getPosts?uris=${encodeURIComponent(uri)}`,
    )
    const posts = ((await res.json()) as any).posts
    if (!posts?.length) {
      console.log('  !! post not found (deleted or invisible)')
      continue
    }
    const p = posts[0]
    const record = p.record as MatchablePost
    const did = uri.slice('at://'.length).split('/')[0]
    const hay = buildHaystacks(record)

    console.log(`  author:    ${p.author.handle} (${did})`)
    console.log(`  createdAt: ${(record as any).createdAt}`)
    console.log(`  embed:     ${record.embed?.$type ?? 'none'}`)
    console.log(`  text:      ${(record.text ?? '').slice(0, 120).replace(/\n/g, ' ')}`)
    if (hay['text|alt_text'] !== hay.text) {
      console.log(
        `  alt:       ${hay['text|alt_text'].slice(hay.text.length).trim().slice(0, 120).replace(/\n/g, ' ')}`,
      )
    }

    for (const cfg of feeds) {
      const label = `${cfg.key} (${cfg.displayName ?? '?'})`
      const stored = !!inFeed.get(uri, cfg.key)
      const muted =
        !!cfg.excludeListUri && !!listDids.get(cfg.excludeListUri)?.has(did)

      const verdict = matchesFeedVerbose(cfg, record, did, hay)
      // The service applies the moderation list on top of the match
      const wouldIndex = verdict.matched && !muted

      console.log(`\n  --- ${label}`)
      console.log(`      in DB:    ${stored ? 'YES — it IS in this feed' : 'no'}`)
      console.log(`      verdict:  ${wouldIndex ? 'MATCHES' : 'dropped'}`)
      if (!verdict.matched) console.log(`      reason:   ${verdict.reason}`)
      else if (muted) console.log(`      reason:   author is on this feed's exclude list`)

      // Which include pattern fired, for the matching case
      if (verdict.matched && cfg.include.length > 0) {
        const hit = cfg.include.find((x) => x.re.test(hay[x.target]))
        if (hit) {
          const m = hay[hit.target].match(hit.re)
          console.log(`      include:  matched "${m?.[0]}" on ${hit.target}`)
        }
      }
      if (stored !== wouldIndex) {
        console.log(
          `      NOTE: DB and current filters disagree — the config likely ` +
            `changed after this post was seen, or retention pruned it.`,
        )
      }
    }
  }
}

run().catch((e) => {
  console.error(e)
  process.exit(1)
})
