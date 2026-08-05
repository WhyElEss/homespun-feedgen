import { sql } from 'kysely'
import { Database } from './db'
import { getRetentions, Retention } from './filter'

// Each feed keeps its own window: by age (hours) or by post count. Pruning one
// feed never touches another's rows.
export const pruneFeed = async (
  db: Database,
  feed: string,
  retention: Retention,
  now: Date = new Date(),
): Promise<void> => {
  if (retention.type === 'hours') {
    const cutoff = new Date(
      now.getTime() - retention.value * 3600 * 1000,
    ).toISOString()
    await db
      .deleteFrom('post')
      .where('feed', '=', feed)
      .where('indexedAt', '<', cutoff)
      .execute()
    return
  }
  // Keep the newest N rows of this feed, drop the rest. rowid is stable for a
  // row's lifetime, which is all this needs.
  await sql`
    delete from post
    where feed = ${feed}
      and rowid not in (
        select rowid from post
        where feed = ${feed}
        order by "indexedAt" desc
        limit ${retention.value}
      )
  `.execute(db)
}

// How often the ingest runs the sweep. Declared here, next to the work it
// describes, so the status page and the scheduler cannot disagree about it.
export const GC_INTERVAL_MS = 60 * 60 * 1000

// When the last sweep finished, and whether any feed failed in it. Kept as
// module state rather than plumbed through the subscription: the status page
// wants it, and threading a field out of the ingest class to get there would
// be a bigger change to the riskiest file than the fact is worth.
let lastRunAt: number | undefined
let lastFailures = 0

export const lastGc = (): { at: number | undefined; failures: number } => ({
  at: lastRunAt,
  failures: lastFailures,
})

// Prune every configured feed. A failure on one feed is logged and does not
// stop the others.
export const pruneFeeds = async (db: Database): Promise<void> => {
  let failures = 0
  for (const [feed, retention] of getRetentions()) {
    try {
      await pruneFeed(db, feed, retention)
    } catch (err) {
      failures++
      console.error(`gc: feed ${feed} failed`, err)
    }
  }
  lastRunAt = Date.now()
  lastFailures = failures
}
