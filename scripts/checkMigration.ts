// One-off: runs the pending DB migrations against FEEDGEN_SQLITE_LOCATION and
// prints the resulting shape, so a schema change can be rehearsed on a copy of
// the live database before it is applied for real.
// Usage: FEEDGEN_SQLITE_LOCATION=/data/db.sqlite ts-node scripts/checkMigration.ts
import SqliteDb from 'better-sqlite3'
import { createDb, migrateToLatest } from '../src/db'

const location = process.env.FEEDGEN_SQLITE_LOCATION
if (!location) throw new Error('FEEDGEN_SQLITE_LOCATION is not set')

const run = async () => {
  const raw = new SqliteDb(location, { readonly: true })
  const before = raw.prepare('select count(*) c from post').get() as { c: number }
  console.log(`before: ${before.c} rows in post`)
  console.log(
    'before: columns =',
    (raw.pragma('table_info(post)') as any[]).map((c) => c.name).join(', '),
  )
  raw.close()

  const db = createDb(location)
  await migrateToLatest(db)
  await db.destroy()
  console.log('\nmigrations applied\n')

  const after = new SqliteDb(location, { readonly: true })
  console.log(
    'after: columns =',
    (after.pragma('table_info(post)') as any[]).map((c) => c.name).join(', '),
  )
  console.log(
    'after: primary key =',
    (after.pragma('table_info(post)') as any[])
      .filter((c) => c.pk > 0)
      .sort((a, b) => a.pk - b.pk)
      .map((c) => c.name)
      .join(' + '),
  )
  console.log(
    'after: indexes =',
    (after.pragma('index_list(post)') as any[]).map((i) => i.name).join(', '),
  )
  console.log('after: integrity =', after.pragma('integrity_check', { simple: true }))

  const perFeed = after
    .prepare('select feed, count(*) c from post group by feed order by feed')
    .all() as { feed: string; c: number }[]
  console.log('\nrows per feed:')
  for (const r of perFeed) console.log(`  ${r.feed}  ${r.c}`)
  const total = perFeed.reduce((s, r) => s + r.c, 0)
  console.log(`  total ${total} (was ${before.c})`)
  if (total !== before.c) {
    console.error('\n!! ROW COUNT CHANGED — migration lost or duplicated rows')
    process.exit(1)
  }

  const migs = after
    .prepare('select name from kysely_migration order by name')
    .all() as { name: string }[]
  console.log('\napplied migrations:', migs.map((m) => m.name).join(', '))

  // A feed query must still use the index rather than scanning.
  const sampleFeed =
    perFeed[0]?.feed ?? process.env.FEEDGEN_SHORTNAME ?? 'my-feed'
  const plan = after
    .prepare(
      'explain query plan select * from post where feed = ? order by "indexedAt" desc limit 30',
    )
    .all(sampleFeed) as any[]
  console.log(`\nquery plan (feed = ${sampleFeed}):`, plan.map((p) => p.detail).join(' | '))
  after.close()
}

run().catch((e) => {
  console.error(e)
  process.exit(1)
})
