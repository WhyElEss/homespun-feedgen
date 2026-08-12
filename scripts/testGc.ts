// Exercises the retention logic against a throwaway database.
// Usage: ts-node scripts/testGc.ts
import { createDb, migrateToLatest } from '../src/db'
import { pruneFeed } from '../src/gc'
import fs from 'node:fs'

const TMP = '/tmp/gc-test.sqlite'

const iso = (msAgo: number) => new Date(Date.now() - msAgo).toISOString()

const run = async () => {
  fs.rmSync(TMP, { force: true })
  const db = createDb(TMP)
  await migrateToLatest(db)

  let failed = 0
  const check = (name: string, got: unknown, want: unknown) => {
    const ok = got === want
    if (!ok) failed++
    console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}` + (ok ? '' : ` (want ${want}, got ${got})`))
  }
  const count = async (feed: string) =>
    Number(
      (
        await db
          .selectFrom('post')
          .select((eb) => eb.fn.countAll().as('c'))
          .where('feed', '=', feed)
          .executeTakeFirstOrThrow()
      ).c,
    )

  // ── count-based retention (a single-account feed: keep 500) ───────────
  console.log('\n── retention {type: count, value: 500}')
  const rows = Array.from({ length: 640 }, (_, i) => ({
    uri: `at://did:plc:vo/app.bsky.feed.post/p${String(i).padStart(4, '0')}`,
    cid: `cid${i}`,
    // p0000 is the oldest, p0639 the newest
    indexedAt: iso((640 - i) * 60_000),
    feed: 'obscura',
  }))
  // a second feed that must be left completely alone
  const other = rows.slice(0, 30).map((r) => ({ ...r, feed: 'other' }))
  for (let i = 0; i < rows.length; i += 100) {
    await db.insertInto('post').values(rows.slice(i, i + 100)).execute()
  }
  await db.insertInto('post').values(other).execute()

  check('inserted', await count('obscura'), 640)
  await pruneFeed(db, 'obscura', { type: 'count', value: 500 })
  check('kept exactly 500', await count('obscura'), 500)
  check('neighbouring feed untouched', await count('other'), 30)

  const kept = await db
    .selectFrom('post')
    .selectAll()
    .where('feed', '=', 'obscura')
    .orderBy('indexedAt', 'asc')
    .execute()
  check('oldest kept is p0140', kept[0].uri.endsWith('p0140'), true)
  check('newest kept is p0639', kept[kept.length - 1].uri.endsWith('p0639'), true)

  await pruneFeed(db, 'obscura', { type: 'count', value: 500 })
  check('second run is a no-op', await count('obscura'), 500)

  // ── age-based retention (the firehose feeds) ──────────────────────────
  console.log('\n── retention {type: hours, value: 72}')
  await db
    .insertInto('post')
    .values([
      { uri: 'at://x/1', cid: 'c1', indexedAt: iso(1 * 3600_000), feed: 'aged' },
      { uri: 'at://x/2', cid: 'c2', indexedAt: iso(71 * 3600_000), feed: 'aged' },
      { uri: 'at://x/3', cid: 'c3', indexedAt: iso(73 * 3600_000), feed: 'aged' },
      { uri: 'at://x/4', cid: 'c4', indexedAt: iso(200 * 3600_000), feed: 'aged' },
    ])
    .execute()
  check('inserted', await count('aged'), 4)
  await pruneFeed(db, 'aged', { type: 'hours', value: 72 })
  check('dropped the two older than 72h', await count('aged'), 2)

  // ── the same post in two feeds is pruned independently ────────────────
  console.log('\n── shared post across feeds')
  await db
    .insertInto('post')
    .values([
      { uri: 'at://shared/1', cid: 'c', indexedAt: iso(100 * 3600_000), feed: 'shortWindow' },
      { uri: 'at://shared/1', cid: 'c', indexedAt: iso(100 * 3600_000), feed: 'longWindow' },
    ])
    .execute()
  await pruneFeed(db, 'shortWindow', { type: 'hours', value: 72 })
  check('pruned from the short-window feed', await count('shortWindow'), 0)
  check('still present in the long-window feed', await count('longWindow'), 1)

  await db.destroy()
  fs.rmSync(TMP, { force: true })

  if (failed > 0) {
    console.error(`\n${failed} check(s) failed`)
    process.exit(1)
  }
  console.log('\nAll retention checks passed')
}

run().catch((e) => {
  console.error(e)
  process.exit(1)
})
