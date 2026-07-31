import { QueryParams } from '../lexicon/types/app/bsky/feed/getFeedSkeleton'
import { SkeletonFeedPost } from '../lexicon/types/app/bsky/feed/defs'
import { AppContext, AlgoHandler } from '../config'
import { getFeedConfig } from '../filter'

// app.bsky.feed.defs#skeletonReasonPin. The vendored lexicon predates it, but
// the `reason` union is open, so an unknown $type passes validation and is
// handed through to the AppView, which turns it into #reasonPin — that is what
// draws the "Pinned" badge in the client.
const REASON_PIN = { $type: 'app.bsky.feed.defs#skeletonReasonPin' }

// One handler per feed. Every feed this instance serves is recency-sorted
// over its own slice of the shared `post` table, so a single factory covers
// all of them.
export const makeHandler =
  (feedKey: string): AlgoHandler =>
  async (ctx: AppContext, params: QueryParams) => {
    // Read the config per request, not once at startup: filters.json is
    // hot-reloaded, so changing (or clearing) pinnedPost takes effect within
    // ~10s with no restart.
    const pinned = getFeedConfig(feedKey)?.pinnedPost

    // The pin rides on the first page only — repeating it on every page would
    // show it again each time the client scrolls. limit === 1 is skipped
    // because the page would then carry no real row to build a cursor from,
    // which would end the feed after the pin.
    const pin = !params.cursor && params.limit > 1 ? pinned : undefined
    const dbLimit = pin ? params.limit - 1 : params.limit

    let builder = ctx.db
      .selectFrom('post')
      .selectAll()
      .where('feed', '=', feedKey)
      .orderBy('indexedAt', 'desc')
      .orderBy('cid', 'desc')
      .limit(dbLimit)

    // Suppressed on every page, not just the pinned one: a pinned post that
    // also matches the feed's filters would otherwise appear twice.
    if (pinned !== undefined) {
      builder = builder.where('uri', '!=', pinned)
    }

    if (params.cursor) {
      const timeStr = new Date(parseInt(params.cursor, 10)).toISOString()
      builder = builder.where('post.indexedAt', '<', timeStr)
    }
    const res = await builder.execute()

    const feed: SkeletonFeedPost[] = res.map((row) => ({
      post: row.uri,
    }))
    if (pin) {
      feed.unshift({ post: pin, reason: REASON_PIN })
    }

    let cursor: string | undefined
    const last = res.at(-1)
    if (last) {
      cursor = new Date(last.indexedAt).getTime().toString(10)
    }

    return {
      cursor,
      feed,
    }
  }
