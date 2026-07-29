import { QueryParams } from '../lexicon/types/app/bsky/feed/getFeedSkeleton'
import { AppContext, AlgoHandler } from '../config'

// One handler per feed. Every feed this instance serves is recency-sorted
// over its own slice of the shared `post` table, so a single factory covers
// all of them.
export const makeHandler =
  (feedKey: string): AlgoHandler =>
  async (ctx: AppContext, params: QueryParams) => {
    let builder = ctx.db
      .selectFrom('post')
      .selectAll()
      .where('feed', '=', feedKey)
      .orderBy('indexedAt', 'desc')
      .orderBy('cid', 'desc')
      .limit(params.limit)

    if (params.cursor) {
      const timeStr = new Date(parseInt(params.cursor, 10)).toISOString()
      builder = builder.where('post.indexedAt', '<', timeStr)
    }
    const res = await builder.execute()

    const feed = res.map((row) => ({
      post: row.uri,
    }))

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
