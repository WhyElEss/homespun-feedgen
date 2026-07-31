import dotenv from 'dotenv'
import fs from 'node:fs'
import Database from 'better-sqlite3'
import {
  loadFiltersOnce,
  matchesFeedVerbose,
  buildHaystacks,
  MatchablePost,
  FeedConfig,
} from '../src/filter'

// Removes stored posts from a feed's table. The service only ever *adds* rows,
// and neither a filter change nor a moderation-list addition removes what is
// already indexed — so cleaning up after either is a separate job, and this is
// it.
//
// Verdicts come from src/filter.ts, exactly like scripts/whyNot.ts, so what
// this considers "no longer wanted" cannot drift from what the service does.
//
// Usage (dry run unless --apply is given):
//   yarn purgePosts --author <handle|did>
//   yarn purgePosts --uri <bsky.app url | at-uri> [--uri ...]
//   yarn purgePosts --rejected [--reason <substring>]
//   yarn purgePosts --blocked
//
//   --feed <rkey>   limit to one feed (default: every feed in filters.json)
//   --apply         actually delete; otherwise just print what would go
//
// Modes:
//   --author    every post by that account
//   --uri       named posts
//   --rejected  everything the CURRENT config would no longer accept — run this
//               after tightening a pattern or dropping an include phrase
//   --reason    narrow --rejected to verdicts whose reason contains a substring
//               (e.g. a distinctive word from the pattern you just edited)
//   --blocked   every post whose author is on the feed's moderation list; the
//               list is applied at index time only, so earlier posts linger

const API = 'https://public.api.bsky.app'
const DB_PATH = process.env.FEEDGEN_SQLITE_LOCATION ?? '/data/db.sqlite'

type Row = { uri: string; indexedAt: string; feed: string }
type Doomed = Row & { handle: string; text: string; why: string }

const arg = (name: string): string | undefined => {
  const i = process.argv.indexOf(`--${name}`)
  return i === -1 ? undefined : process.argv[i + 1]
}
const has = (name: string): boolean => process.argv.includes(`--${name}`)
const all = (name: string): string[] => {
  const out: string[] = []
  process.argv.forEach((a, i) => {
    if (a === `--${name}` && process.argv[i + 1]) out.push(process.argv[i + 1])
  })
  return out
}

const resolveDid = async (who: string): Promise<string> => {
  if (who.startsWith('did:')) return who
  const handle = who.replace(/^@/, '')
  const res = await fetch(
    `${API}/xrpc/com.atproto.identity.resolveHandle?handle=${encodeURIComponent(handle)}`,
  )
  if (!res.ok) throw new Error(`resolveHandle ${handle}: HTTP ${res.status}`)
  return ((await res.json()) as { did: string }).did
}

const toAtUri = async (input: string): Promise<string> => {
  if (input.startsWith('at://')) return input
  const m = input.match(/profile\/([^/]+)\/post\/([a-z0-9]+)/i)
  if (!m) throw new Error(`cannot parse as a post: ${input}`)
  const did = await resolveDid(m[1])
  return `at://${did}/app.bsky.feed.post/${m[2]}`
}

const listDids = async (uri: string): Promise<Set<string>> => {
  const dids = new Set<string>()
  let cursor: string | undefined
  do {
    const qs = new URLSearchParams({ list: uri, limit: '100' })
    if (cursor) qs.set('cursor', cursor)
    const res = await fetch(`${API}/xrpc/app.bsky.graph.getList?${qs}`)
    if (!res.ok) throw new Error(`getList: HTTP ${res.status}`)
    const d = (await res.json()) as { cursor?: string; items: { subject: { did: string } }[] }
    d.items.forEach((i) => dids.add(i.subject.did))
    cursor = d.cursor
  } while (cursor)
  return dids
}

// Hydrates rows from the AppView 25 at a time. Rows the AppView will not return
// (post deleted upstream) are reported, never silently dropped.
const hydrate = async (
  rows: Row[],
  onPost: (row: Row, post: any) => void,
): Promise<Row[]> => {
  const missing: Row[] = []
  const byUri = new Map(rows.map((r) => [r.uri, r]))
  for (let i = 0; i < rows.length; i += 25) {
    const batch = rows.slice(i, i + 25)
    const qs = batch.map((r) => 'uris=' + encodeURIComponent(r.uri)).join('&')
    const res = await fetch(`${API}/xrpc/app.bsky.feed.getPosts?${qs}`)
    if (!res.ok) throw new Error(`getPosts: HTTP ${res.status} (batch at ${i})`)
    const { posts } = (await res.json()) as any
    const seen = new Set<string>()
    for (const p of posts) {
      seen.add(p.uri)
      onPost(byUri.get(p.uri)!, p)
    }
    for (const r of batch) if (!seen.has(r.uri)) missing.push(r)
  }
  return missing
}

const run = async () => {
  dotenv.config()

  const modes = ['author', 'uri', 'rejected', 'blocked'].filter(has)
  if (modes.length !== 1) {
    console.error(
      'usage: purgePosts.ts (--author <handle|did> | --uri <url> ... | --rejected [--reason <s>] | --blocked)\n' +
        '                    [--feed <rkey>] [--apply]',
    )
    process.exit(2)
  }
  const mode = modes[0]
  const apply = has('apply')

  const configs = loadFiltersOnce()
  const only = arg('feed')
  if (only && !configs.has(only)) throw new Error(`no such feed in filters.json: ${only}`)
  const feeds: FeedConfig[] = only ? [configs.get(only)!] : [...configs.values()]

  const db = new Database(DB_PATH)
  db.pragma('busy_timeout = 15000')

  const doomed: Doomed[] = []
  const notes: string[] = []

  for (const cfg of feeds) {
    const rows = db
      .prepare('select uri, indexedAt, feed from post where feed = ?')
      .all(cfg.key) as Row[]
    if (!rows.length) continue

    if (mode === 'author' || mode === 'uri') {
      let want: (r: Row) => boolean
      if (mode === 'author') {
        const did = await resolveDid(arg('author')!)
        want = (r) => r.uri.startsWith(`at://${did}/`)
      } else {
        const uris = new Set(await Promise.all(all('uri').map(toAtUri)))
        want = (r) => uris.has(r.uri)
      }
      const picked = rows.filter(want)
      if (!picked.length) continue
      const missing = await hydrate(picked, (row, p) =>
        doomed.push({
          ...row,
          handle: p.author.handle,
          text: (p.record.text ?? '').replace(/\s+/g, ' ').slice(0, 80),
          why: mode === 'author' ? 'author' : 'named uri',
        }),
      )
      for (const r of missing)
        doomed.push({ ...r, handle: '(deleted upstream)', text: '', why: 'not retrievable' })
      continue
    }

    if (mode === 'blocked') {
      if (!cfg.excludeListUri) {
        notes.push(`${cfg.key}: no excludeListUri configured — skipped`)
        continue
      }
      const blocked = await listDids(cfg.excludeListUri)
      const picked = rows.filter((r) => blocked.has(r.uri.slice('at://'.length).split('/')[0]))
      if (!picked.length) continue
      await hydrate(picked, (row, p) =>
        doomed.push({
          ...row,
          handle: p.author.handle,
          text: (p.record.text ?? '').replace(/\s+/g, ' ').slice(0, 80),
          why: 'on moderation list',
        }),
      )
      continue
    }

    // --rejected: replay the live filter over everything stored
    const needle = arg('reason')
    const kept: string[] = []
    const missing = await hydrate(rows, (row, p) => {
      const rec = p.record as MatchablePost
      const v = matchesFeedVerbose(cfg, rec, p.author.did, buildHaystacks(rec))
      if (v.matched) return
      const why = v.reason ?? 'no reason given'
      if (needle && !why.includes(needle)) {
        kept.push(`@${p.author.handle} [${why.slice(0, 50)}]`)
        return
      }
      doomed.push({
        ...row,
        handle: p.author.handle,
        text: (rec.text ?? '').replace(/\s+/g, ' ').slice(0, 80),
        why: why.slice(0, 70),
      })
    })
    if (missing.length) notes.push(`${cfg.key}: ${missing.length} row(s) not retrievable from the AppView — left alone`)
    if (kept.length) {
      notes.push(`${cfg.key}: ${kept.length} row(s) rejected for other reasons — left alone`)
      kept.forEach((k) => notes.push(`    ${k}`))
    }
  }

  const feedList = feeds.map((f) => f.key).join(', ')
  console.log(`mode: --${mode}${arg('reason') ? ` --reason ${arg('reason')}` : ''}  |  feeds: ${feedList}`)
  console.log(`to delete: ${doomed.length}\n`)
  const byFeed = new Map<string, Doomed[]>()
  for (const d of doomed) byFeed.set(d.feed, [...(byFeed.get(d.feed) ?? []), d])
  for (const [feed, ds] of byFeed) {
    console.log(`  ${feed} (${ds.length})`)
    for (const d of ds) console.log(`     @${d.handle} [${d.why}] ${d.text}`)
  }
  if (notes.length) {
    console.log('\nnotes:')
    notes.forEach((n) => console.log(`  ${n}`))
  }

  if (!doomed.length) {
    console.log('\nnothing to do')
    return
  }
  if (!apply) {
    console.log('\ndry run — re-run with --apply to delete')
    return
  }

  const stamp = new Date().toISOString().replace(/[:.]/g, '').slice(0, 15)
  const dir = DB_PATH.replace(/\/[^/]+$/, '')
  fs.copyFileSync(DB_PATH, `${dir}/db-backup-purge-${stamp}.sqlite`)
  fs.writeFileSync(`${dir}/purged-${stamp}.json`, JSON.stringify(doomed, null, 2))

  const del = db.prepare('delete from post where feed = ? and uri = ?')
  db.transaction((l: Doomed[]) => l.forEach((d) => del.run(d.feed, d.uri)))(doomed)

  console.log(`\ndeleted ${doomed.length}`)
  console.log(`  db backup: ${dir}/db-backup-purge-${stamp}.sqlite`)
  console.log(`  dump:      ${dir}/purged-${stamp}.json`)
  for (const cfg of feeds) {
    const n = (db.prepare('select count(*) n from post where feed = ?').get(cfg.key) as any).n
    console.log(`  ${cfg.key}: ${n} rows remain`)
  }
}

run().catch((err) => {
  console.error(err)
  process.exit(1)
})
