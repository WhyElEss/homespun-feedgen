import { Worker } from 'node:worker_threads'
import { Database } from './db'
import {
  FeedConfig,
  MatchablePost,
  Haystacks,
  buildHaystacks,
  matchesFeedVerbose,
  getFeedConfig,
  validateFilters,
} from './filter'

// "What would this edit actually remove?" — answered against the posts this box
// has already stored, before the edit is saved.
//
// It is purgePosts --rejected as a dry run over a config that is not live yet:
// the same question, asked early. Verdicts come from matchesFeedVerbose, so the
// lab cannot drift from what the service does.
//
// TWO THINGS IT CANNOT DO, both forced by what is on disk:
//
//   * it cannot show what a WIDENED include would let in. The post table holds
//     only uri/cid/indexedAt/feed — no text — so the only corpus available is
//     the posts a feed already has. Posts that a broader pattern would newly
//     match were never stored, and app.bsky.feed.searchPosts is 403 without
//     auth, so there is nowhere to look them up;
//   * it cannot see the author handle. buildHaystacks() never gets one, so a
//     pattern aimed at an account rather than at words is invisible here — that
//     is what the moderation list is for.

const API = 'https://public.api.bsky.app'
const CACHE_TTL_MS = 10 * 60 * 1000
// A pattern is user input arriving over HTTP, and this process also ingests the
// firehose. Catastrophic backtracking in the main thread would stall the feed
// for every reader, so candidates are proved against the corpus in a worker
// that can be killed. Five seconds is far more than a sane pattern needs over a
// few thousand short strings.
const PROBE_TIMEOUT_MS = 5000

export type StoredPost = {
  uri: string
  did: string
  handle: string
  text: string
  indexedAt: string
  hay: Haystacks
  record: MatchablePost
}

type CacheEntry = { at: number; posts: StoredPost[]; missing: number }
const cache = new Map<string, CacheEntry>()

export const clearLabCache = (): void => cache.clear()

// Test seam. The corpus normally comes from the AppView, which a test has no
// business calling: the measurement logic and the fetching are separate
// concerns and only the first one is worth asserting on. Same reasoning that
// left handleMessage() reachable in subscription.ts.
export const seedCorpus = (feed: string, posts: StoredPost[], missing = 0): void => {
  cache.set(feed, { at: Date.now(), posts, missing })
}

// Hydrates a feed's stored rows from the AppView, 25 at a time — the same
// endpoint and batch size purgePosts uses. Rows the AppView will not return
// (deleted upstream) are counted, never silently treated as non-matching.
const hydrateFeed = async (db: Database, feed: string): Promise<CacheEntry> => {
  const rows = await db
    .selectFrom('post')
    .select(['uri', 'indexedAt'])
    .where('feed', '=', feed)
    .orderBy('indexedAt', 'desc')
    .execute()

  const posts: StoredPost[] = []
  let missing = 0
  for (let i = 0; i < rows.length; i += 25) {
    const batch = rows.slice(i, i + 25)
    const qs = batch.map((r) => 'uris=' + encodeURIComponent(r.uri)).join('&')
    const res = await fetch(`${API}/xrpc/app.bsky.feed.getPosts?${qs}`)
    if (!res.ok) throw new Error(`getPosts: HTTP ${res.status} (batch at ${i})`)
    const { posts: got } = (await res.json()) as any
    const seen = new Set<string>()
    for (const p of got ?? []) {
      seen.add(p.uri)
      const record = p.record as MatchablePost
      posts.push({
        uri: p.uri,
        did: p.author?.did ?? '',
        handle: p.author?.handle ?? '',
        text: (record?.text ?? '').replace(/\s+/g, ' '),
        indexedAt: batch.find((r) => r.uri === p.uri)?.indexedAt ?? '',
        hay: buildHaystacks(record ?? {}),
        record: record ?? {},
      })
    }
    missing += batch.length - seen.size
  }
  return { at: Date.now(), posts, missing }
}

export const loadCorpus = async (
  db: Database,
  feed: string,
  refresh = false,
): Promise<CacheEntry> => {
  const hit = cache.get(feed)
  if (!refresh && hit && Date.now() - hit.at < CACHE_TTL_MS) return hit
  const fresh = await hydrateFeed(db, feed)
  cache.set(feed, fresh)
  return fresh
}

// Runs every candidate pattern over every haystack inside a worker, purely to
// find out whether it terminates. Nothing here decides anything about a post —
// the verdicts come from filter.ts afterwards, on the main thread. If the same
// regexes over the same strings finish here, running them there is safe.
const probePatterns = (patterns: { pattern: string; flags: string }[], hay: string[]) =>
  new Promise<void>((resolve, reject) => {
    if (patterns.length === 0) return resolve()
    const src = `
      const { parentPort, workerData } = require('node:worker_threads')
      for (const p of workerData.patterns) {
        const re = new RegExp(p.pattern, p.flags)
        for (const h of workerData.hay) re.test(h)
      }
      parentPort.postMessage('ok')
    `
    const worker = new Worker(src, { eval: true, workerData: { patterns, hay } })
    const timer = setTimeout(() => {
      worker.terminate()
      reject(
        new Error(
          'a pattern took longer than 5s over the stored posts and was stopped — ' +
            'this is what catastrophic backtracking looks like (nested quantifiers ' +
            'like (a+)+ are the usual cause). The config was not changed.',
        ),
      )
    }, PROBE_TIMEOUT_MS)
    worker.on('message', () => {
      clearTimeout(timer)
      worker.terminate()
      resolve()
    })
    worker.on('error', (err) => {
      clearTimeout(timer)
      reject(err)
    })
  })

export type LabSample = {
  uri: string
  handle: string
  text: string
  indexedAt: string
  reason: string
}

export type LabResult = {
  feed: string
  stored: number
  unretrievable: number
  keptNow: number
  keptAfter: number
  removed: number
  removedPct: number
  wouldExceedAutoPurgeCap: boolean
  samples: LabSample[]
  cachedAt: string
  note: string
}

// The cap auto-purge applies to its own sweeps. Mirrored here so the lab can
// warn that a change this large will be WITHHELD rather than applied — the
// posts would sit in the feed until someone looks, which is a surprise worth
// having in advance. Keep in step with scripts/auto-purge.sh.
const AUTO_PURGE_MAX_ABS = 25
const AUTO_PURGE_MAX_PCT = 5

export const measureCandidate = async (
  db: Database,
  feed: string,
  candidateFilters: unknown,
  opts: { refresh?: boolean; sampleLimit?: number } = {},
): Promise<LabResult> => {
  const live = getFeedConfig(feed)
  if (!live) throw new Error(`feed "${feed}" is not in the live config`)

  // Compile the candidate through the service's own validator: a config the
  // service could not load must not be measurable either.
  const compiled = validateFilters(candidateFilters)
  const next: FeedConfig | undefined = compiled.get(feed)
  if (!next) throw new Error(`the candidate config has no feed "${feed}"`)

  const corpus = await loadCorpus(db, feed, opts.refresh)
  const hay = corpus.posts.map((p) => p.hay['text|alt_text|link'])
  await probePatterns(
    [...next.include, ...next.exclude].map((p) => ({
      pattern: p.re.source,
      flags: p.re.flags,
    })),
    hay,
  )

  const samples: LabSample[] = []
  const limit = opts.sampleLimit ?? 25
  let keptNow = 0
  let keptAfter = 0
  let removed = 0

  for (const p of corpus.posts) {
    const before = matchesFeedVerbose(live, p.record, p.did, p.hay)
    const after = matchesFeedVerbose(next, p.record, p.did, p.hay)
    if (before.matched) keptNow++
    if (after.matched) keptAfter++
    if (before.matched && !after.matched) {
      removed++
      if (samples.length < limit) {
        samples.push({
          uri: p.uri,
          handle: p.handle,
          text: p.text.slice(0, 160),
          indexedAt: p.indexedAt,
          reason: after.reason ?? 'no reason given',
        })
      }
    }
  }

  const stored = corpus.posts.length
  const removedPct = stored === 0 ? 0 : (removed / stored) * 100
  return {
    feed,
    stored,
    unretrievable: corpus.missing,
    keptNow,
    keptAfter,
    removed,
    removedPct: Math.round(removedPct * 10) / 10,
    wouldExceedAutoPurgeCap:
      removed > AUTO_PURGE_MAX_ABS || removedPct > AUTO_PURGE_MAX_PCT,
    samples,
    cachedAt: new Date(corpus.at).toISOString(),
    note:
      'Measured against posts this feed already holds. A widened include cannot ' +
      'be measured — posts it would newly match were never stored.',
  }
}
