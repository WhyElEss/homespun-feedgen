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
    const cfg = getFeedConfig(feedKey)
    const pinned = cfg?.pinnedPost
    const hideLabels = cfg?.moderationLabels ?? []

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

    // A post Bluesky's moderation service labelled with a value this feed
    // names is skipped here, at serve time, rather than deleted: switching the
    // value off, or the labeler withdrawing the label, brings it back. Done in
    // the query so a page still holds `limit` rows. The pin is not subject to
    // it — it is the operator's own choice for the top of the feed.
    if (hideLabels.length > 0) {
      const now = new Date().toISOString()
      builder = builder.where((eb) =>
        eb.not(
          eb.exists(
            eb
              .selectFrom('post_label')
              .select('post_label.uri')
              .whereRef('post_label.uri', '=', 'post.uri')
              .where('post_label.val', 'in', hideLabels)
              .where((e) =>
                e.or([e('post_label.exp', 'is', null), e('post_label.exp', '>', now)]),
              ),
          ),
        ),
      )
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
