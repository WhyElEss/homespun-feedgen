import { Database } from './db'
import { toAtUri } from './adminResolve'
import {
  loadFiltersOnce,
  getFeedConfig,
  getFeedKeys,
  getExcludeListUris,
  matchesFeedVerbose,
  buildHaystacks,
  MatchablePost,
} from './filter'

// "Why isn't this post in the feed?" — the question that comes up most, asked
// of every feed at once instead of one at a time.
//
// This is scripts/whyNot.ts as a panel, and deliberately the same shape: the
// verdict comes from matchesFeedVerbose, so it cannot drift from what the
// ingest actually does. What it adds over the script is that all four feeds
// are answered together, which is usually the real question — a post that
// missed Vinyl often landed somewhere else.
//
// The two things it checks that the matcher alone cannot answer:
//   * the moderation list, which subscription.ts applies ON TOP of the match;
//   * whether the row is in the database right now. A post can match today and
//     still be absent because the config changed after it was seen, or because
//     retention pruned it — and that disagreement is the actual answer more
//     often than the filter is.

const API = 'https://public.api.bsky.app'
const LIST_TTL_MS = 10 * 60 * 1000

const listCache = new Map<string, { at: number; dids: Set<string> }>()

const fetchListDids = async (uri: string): Promise<Set<string>> => {
  const hit = listCache.get(uri)
  if (hit && Date.now() - hit.at < LIST_TTL_MS) return hit.dids

  const dids = new Set<string>()
  let cursor: string | undefined
  do {
    const params = new URLSearchParams({ list: uri, limit: '100' })
    if (cursor) params.set('cursor', cursor)
    const res = await fetch(`${API}/xrpc/app.bsky.graph.getList?${params}`)
    if (!res.ok) throw new Error(`getList: HTTP ${res.status}`)
    const data = (await res.json()) as any
    for (const item of data.items ?? []) {
      if (item?.subject?.did) dids.add(item.subject.did)
    }
    cursor = data.cursor
  } while (cursor)

  listCache.set(uri, { at: Date.now(), dids })
  return dids
}

export type FeedVerdict = {
  key: string
  displayName: string | null
  stored: boolean
  wouldIndex: boolean
  reason: string | null
  includeMatch: string | null
  includeTarget: string | null
  // What the exclude pattern actually matched, and which rule it belongs to.
  excludeMatch: string | null
  excludeComment: string | null
  excludeTarget: string | null
  excludePattern: string | null
  mutedByList: boolean
  disagrees: boolean
}

export type WhyNotResult = {
  uri: string
  did: string
  handle: string
  createdAt: string | null
  embed: string
  isReply: boolean
  text: string
  alt: string
  feeds: FeedVerdict[]
}

export const explainPost = async (
  db: Database,
  input: string,
): Promise<WhyNotResult> => {
  const uri = await toAtUri(input)
  const did = uri.slice('at://'.length).split('/')[0]

  const res = await fetch(
    `${API}/xrpc/app.bsky.feed.getPosts?uris=${encodeURIComponent(uri)}`,
  )
  if (!res.ok) throw new Error(`getPosts: HTTP ${res.status}`)
  const posts = ((await res.json()) as any).posts
  if (!posts?.length) {
    throw new Error(
      'the AppView does not have that post — it was deleted, or its author ' +
        'blocks the viewer. Nothing can be said about it from here.',
    )
  }

  const p = posts[0]
  const record = p.record as MatchablePost
  const hay = buildHaystacks(record)

  // The live config, not a copy: this must answer for what is running now.
  if (getFeedKeys().length === 0) loadFiltersOnce()
  const listUris = getExcludeListUris()
  const lists = new Map<string, Set<string>>()
  for (const listUri of new Set(listUris.values())) {
    try {
      lists.set(listUri, await fetchListDids(listUri))
    } catch {
      // A list that will not load must not take the whole answer with it; the
      // feed simply reports no mute rather than a wrong one.
      lists.set(listUri, new Set())
    }
  }

  const rows = await db
    .selectFrom('post')
    .select(['feed'])
    .where('uri', '=', uri)
    .execute()
  const storedIn = new Set(rows.map((r) => r.feed))

  const feeds: FeedVerdict[] = []
  for (const key of getFeedKeys()) {
    const cfg = getFeedConfig(key)
    if (!cfg) continue
    const verdict = matchesFeedVerbose(cfg, record, did, hay)
    const mutedByList =
      !!cfg.excludeListUri && !!lists.get(cfg.excludeListUri)?.has(did)
    const wouldIndex = verdict.matched && !mutedByList
    const stored = storedIn.has(key)

    // Computed whether or not the post made it. It used to be gated on
    // verdict.matched, so an EXCLUDED post told you nothing about how it got
    // as far as the exclude gate — and "came in on «vinyl», then dropped by
    // «3D»" is the whole answer, where either half alone is a riddle. When the
    // post never matched an include, find() returns undefined and this is null,
    // which is the honest answer to the same question.
    let includeMatch: string | null = null
    let includeTarget: string | null = null
    if (cfg.include.length > 0) {
      const hit = cfg.include.find((x) => x.re.test(hay[x.target]))
      if (hit) {
        includeMatch = hay[hit.target].match(hit.re)?.[0] ?? null
        includeTarget = hit.target
      }
    }

    feeds.push({
      key,
      displayName: cfg.displayName ?? null,
      stored,
      wouldIndex,
      reason: verdict.matched
        ? mutedByList
          ? "the author is on this feed's moderation list"
          : null
        : verdict.reason ?? 'no reason given',
      includeMatch,
      includeTarget,
      excludeMatch: verdict.excludeMatch ?? null,
      excludeComment: verdict.excludeComment ?? null,
      excludeTarget: verdict.excludeTarget ?? null,
      excludePattern: verdict.excludePattern ?? null,
      mutedByList,
      disagrees: stored !== wouldIndex,
    })
  }

  const altOnly = hay['text|alt_text'].slice((record.text ?? '').length).trim()
  return {
    uri,
    did,
    handle: p.author?.handle ?? '',
    createdAt: (record as any).createdAt ?? null,
    embed: record.embed?.$type ?? 'none',
    isReply: !!record.reply,
    text: (record.text ?? '').replace(/\s+/g, ' '),
    alt: altOnly.replace(/\s+/g, ' ').slice(0, 400),
    feeds,
  }
}
