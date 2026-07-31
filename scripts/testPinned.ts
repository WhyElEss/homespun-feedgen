// Exercises the pinned-post logic against a throwaway database.
// Usage: yarn test:pinned
//
// The point of interest is the last block: the handler is built once and then
// the config is changed underneath it, the way a hot reload does. The pin must
// follow the file without the process restarting.
import fs from 'node:fs'
import { createDb, migrateToLatest, Database } from '../src/db'
import { loadFiltersOnce } from '../src/filter'
import { makeHandler } from '../src/algos/feed'
import { AppContext } from '../src/config'
import { QueryParams } from '../src/lexicon/types/app/bsky/feed/getFeedSkeleton'

const TMP_DB = '/tmp/pinned-test.sqlite'
const FILTERS = process.env.FEEDGEN_FILTERS_PATH ?? '/tmp/pinned-test-filters.json'

const PIN = 'at://did:plc:pinned/app.bsky.feed.post/welcome'
const PIN_TYPE = 'app.bsky.feed.defs#skeletonReasonPin'

const iso = (msAgo: number) => new Date(Date.now() - msAgo).toISOString()

// Only ctx.db is touched by the handler.
const ctxFor = (db: Database) => ({ db }) as AppContext

const writeFilters = (pinnedPost?: string) => {
  const feed: Record<string, unknown> = {
    displayName: 'Pinned feed',
    includePatterns: [{ pattern: 'anything' }],
  }
  if (pinnedPost !== undefined) feed.pinnedPost = pinnedPost
  fs.writeFileSync(
    FILTERS,
    JSON.stringify({
      feeds: {
        pinned: feed,
        plain: {
          displayName: 'No pin here',
          includePatterns: [{ pattern: 'anything' }],
        },
      },
    }),
  )
  loadFiltersOnce()
}

const run = async () => {
  fs.rmSync(TMP_DB, { force: true })
  const db = createDb(TMP_DB)
  await migrateToLatest(db)
  const ctx = ctxFor(db)

  let failed = 0
  const check = (name: string, got: unknown, want: unknown) => {
    const ok = got === want
    if (!ok) failed++
    console.log(
      `  ${ok ? 'PASS' : 'FAIL'}  ${name}` +
        (ok ? '' : ` (want ${want}, got ${got})`),
    )
  }

  // 10 ordinary rows per feed, newest first when read back. The pinned post is
  // deliberately also stored in the feed, to prove it is not served twice.
  for (const feed of ['pinned', 'plain']) {
    await db
      .insertInto('post')
      .values(
        Array.from({ length: 10 }, (_, i) => ({
          uri: `at://did:plc:author/app.bsky.feed.post/${feed}${i}`,
          cid: `cid-${feed}-${i}`,
          indexedAt: iso((10 - i) * 60_000),
          feed,
        })),
      )
      .execute()
  }
  await db
    .insertInto('post')
    .values([
      { uri: PIN, cid: 'cid-pin', indexedAt: iso(30_000), feed: 'pinned' },
    ])
    .execute()

  // ── first page ────────────────────────────────────────────────────────
  console.log('\n── first page of a feed with pinnedPost')
  writeFilters(PIN)
  const handler = makeHandler('pinned')
  const plainHandler = makeHandler('plain')

  const p1 = await handler(ctx, { feed: '', limit: 5 } as QueryParams)
  check('page holds exactly `limit` items', p1.feed.length, 5)
  check('pinned post is first', p1.feed[0].post, PIN)
  check('carries skeletonReasonPin', p1.feed[0].reason?.$type, PIN_TYPE)
  check('no other item carries a reason', p1.feed.slice(1).every((i) => !i.reason), true)
  check(
    'pinned post is not repeated in the page',
    p1.feed.filter((i) => i.post === PIN).length,
    1,
  )
  check('cursor is set', typeof p1.cursor, 'string')

  // ── later pages ───────────────────────────────────────────────────────
  console.log('\n── second page')
  const p2 = await handler(ctx, { feed: '', limit: 5, cursor: p1.cursor } as QueryParams)
  check('no pin on a cursored page', p2.feed.some((i) => !!i.reason), false)
  check('pinned post absent from page 2 as well', p2.feed.some((i) => i.post === PIN), false)
  check('page 2 is a full page', p2.feed.length, 5)
  check(
    'no row served twice across the two pages',
    new Set([...p1.feed, ...p2.feed].map((i) => i.post)).size,
    10,
  )

  // ── a feed that declares no pin is untouched ──────────────────────────
  console.log('\n── feed without pinnedPost')
  const plain = await plainHandler(ctx, { feed: '', limit: 5 } as QueryParams)
  check('page holds exactly `limit` items', plain.feed.length, 5)
  check('nothing is pinned', plain.feed.some((i) => !!i.reason), false)

  // ── degenerate limit ──────────────────────────────────────────────────
  console.log('\n── limit = 1')
  const one = await handler(ctx, { feed: '', limit: 1 } as QueryParams)
  check('serves a real row, not the pin', one.feed.length, 1)
  check('so the cursor still advances', typeof one.cursor, 'string')
  check('and the pin is skipped', one.feed[0].post === PIN, false)

  // ── the hot-reload property ───────────────────────────────────────────
  console.log('\n── config changes under a running handler')
  writeFilters('at://did:plc:pinned/app.bsky.feed.post/second')
  const swapped = await handler(ctx, { feed: '', limit: 5 } as QueryParams)
  check(
    'same handler now pins the new post',
    swapped.feed[0].post,
    'at://did:plc:pinned/app.bsky.feed.post/second',
  )

  writeFilters(undefined)
  const cleared = await handler(ctx, { feed: '', limit: 5 } as QueryParams)
  check('clearing the field unpins', cleared.feed.some((i) => !!i.reason), false)
  check(
    'and the post returns to its natural place',
    cleared.feed.some((i) => i.post === PIN),
    true,
  )

  // ── validation ────────────────────────────────────────────────────────
  console.log('\n── a malformed URI is rejected on load')
  let threw = false
  try {
    writeFilters('https://bsky.app/profile/alice.test/post/abc')
  } catch {
    threw = true
  }
  check('bad pinnedPost throws', threw, true)

  await db.destroy()
  fs.rmSync(TMP_DB, { force: true })
  fs.rmSync(FILTERS, { force: true })

  if (failed > 0) {
    console.error(`\n${failed} check(s) failed`)
    process.exit(1)
  }
  console.log('\nAll pinned-post checks passed')
}

run().catch((e) => {
  console.error(e)
  process.exit(1)
})
