// Diagnoses why given posts did (not) get into the feed.
// Usage: ts-node scripts/whyNot.ts <bsky.app post URL or at-uri> ...
// Fetches each post from the public AppView, replays the real filter
// pipeline (live /data/filters.json) stage by stage, and checks the DB.
import Database from 'better-sqlite3'
import {
  loadFilters,
  matchesFeed,
  getExcludeListUri,
  MatchablePost,
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

const fetchListDids = async (): Promise<Set<string>> => {
  const uri = getExcludeListUri()
  const dids = new Set<string>()
  if (!uri) return dids
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

// mirrors filter.ts internals for stage-by-stage reporting
const altTexts = (r: MatchablePost): string[] => {
  const images = r.embed?.images ?? r.embed?.media?.images ?? []
  const parts = images.map((i) => i.alt ?? '')
  const v = r.embed?.alt ?? r.embed?.media?.alt
  if (v) parts.push(v)
  return parts
}
const linkStrings = (r: MatchablePost): string[] => {
  const parts: string[] = []
  const ext = r.embed?.external ?? r.embed?.media?.external
  if (ext) parts.push(ext.uri ?? '', ext.title ?? '', ext.description ?? '')
  for (const f of r.facets ?? [])
    for (const ft of f.features ?? [])
      if (ft.$type === 'app.bsky.richtext.facet#link' && ft.uri) parts.push(ft.uri)
  return parts
}

const run = async () => {
  loadFilters()
  const raw = JSON.parse(
    require('node:fs').readFileSync(
      process.env.FEEDGEN_FILTERS_PATH ?? '/data/filters.json',
      'utf8',
    ),
  )
  const include: RegExp[] = raw.includePatterns.map(
    (p: any) => new RegExp(p.pattern, p.flags ?? 'iu'),
  )
  const exclude: { re: RegExp; comment: string }[] = raw.excludePatterns.map(
    (p: any) => ({
      re: new RegExp(p.pattern, p.flags ?? 'iu'),
      comment: p.comment ?? '?',
    }),
  )
  const listDids = await fetchListDids()
  const db = new Database('/data/db.sqlite', { readonly: true })

  for (const arg of process.argv.slice(2)) {
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
    const r = p.record as MatchablePost
    const did = uri.slice('at://'.length).split('/')[0]

    const inDb = db.prepare('select 1 from post where uri = ?').get(uri)
    console.log(`  author: ${p.author.handle}`)
    console.log(`  in DB: ${inDb ? 'YES (it IS in the feed)' : 'no'}`)
    console.log(`  createdAt: ${(r as any).createdAt}`)
    console.log(`  text: ${(r.text ?? '').slice(0, 120).replace(/\n/g, ' ')}`)
    const alts = altTexts(r)
    if (alts.length) console.log(`  alt: ${alts.join(' | ').slice(0, 120)}`)

    if (r.reply) console.log('  -> DROPPED: is a reply')
    if ((r.labels as any)?.values?.length) console.log('  -> DROPPED: has self-labels')
    if (listDids.has(did)) console.log('  -> DROPPED: author is on the exclude list')

    const embedType = r.embed?.$type ?? 'none'
    console.log(`  embed: ${embedType}`)
    if (raw.quotePosts === 'exclude' &&
        (embedType === 'app.bsky.embed.record' || embedType === 'app.bsky.embed.recordWithMedia'))
      console.log('  -> DROPPED: quote post (quotePosts=exclude)')
    const extUri = r.embed?.external?.uri ?? r.embed?.media?.external?.uri ?? ''
    if (raw.gifPosts === 'exclude' && (/\.gif(?:$|\?)/i.test(extUri) || /(?:^|\.)tenor\.com\//i.test(extUri)))
      console.log('  -> DROPPED: gif post (gifPosts=exclude)')

    const incHay = [r.text ?? '', ...alts].join('\n')
    const incHit = include.some((re) => re.test(incHay))
    console.log(`  include match (text+alt): ${incHit ? 'YES' : 'NO'}`)
    const excHay = [incHay, ...linkStrings(r)].join('\n')
    const excHits = exclude.filter((e) => e.re.test(excHay))
    for (const e of excHits) {
      const m = excHay.match(e.re)
      console.log(`  exclude HIT [${e.comment}]: "${m?.[0]}"`)
    }
    console.log(`  verdict matchesFeed(): ${matchesFeed(r)}`)
  }
}

run().catch((e) => {
  console.error(e)
  process.exit(1)
})
