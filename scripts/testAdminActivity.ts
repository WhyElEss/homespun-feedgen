// Covers the last-24-hours view: hourly buckets from the table, and the purge
// dumps read back off the disk beside the database.
// Usage: yarn testAdminActivity  (needs FEEDGEN_FILTERS_PATH — see below)
//
// The cases worth having are the ones where the two sources disagree with each
// other or with the config: a row that is gone from the table but named in a
// dump, an hour that is empty because retention cut it rather than because
// nothing arrived, and every way the directory beside the database can be
// something other than a tidy set of dumps.
import fs from 'node:fs'
import path from 'node:path'
import { createDb, migrateToLatest } from '../src/db'
import { loadFiltersOnce } from '../src/filter'
import { collectActivity, windowHours, retentionFloor, ActivitySnapshot } from '../src/adminActivity'

// filter.ts captures this at module load, so it has to come from the
// environment — setting it here would already be too late.
const FILTERS = process.env.FEEDGEN_FILTERS_PATH
if (!FILTERS) {
  console.error('FEEDGEN_FILTERS_PATH must be set — run this as `yarn testAdminActivity`')
  process.exit(1)
}

const TMP = fs.mkdtempSync('/tmp/activity-test-')
// Read per REQUEST by the module under test, not captured at module load, so
// setting it here is in time. FEEDGEN_FILTERS_PATH is the opposite case and is
// why this script insists on getting that one from the environment.
process.env.FEEDGEN_SQLITE_LOCATION = path.join(TMP, 'db.sqlite')

// 19:34Z, so the newest bucket is a partly-filled 19:00 and the oldest is
// yesterday's 20:00. Fixed, because a test that drifts with the wall clock
// fails once a day for reasons nobody can reproduce.
const NOW = Date.parse('2026-08-09T19:34:00.000Z')

const CONFIG = {
  feeds: {
    coffee: {
      displayName: 'Coffee',
      includePatterns: [{ pattern: '\\bcoffee\\b' }],
      retention: { type: 'hours', value: 72 },
    },
    radio: {
      displayName: 'Radio',
      includeDids: ['did:plc:someone'],
      retention: { type: 'count', value: 4 },
    },
    brief: {
      displayName: 'Brief',
      includePatterns: [{ pattern: '\\bbrief\\b' }],
      retention: { type: 'hours', value: 6 },
    },
    plain: {
      includePatterns: [{ pattern: '\\bplain\\b' }],
    },
  },
}

let failed = 0
let total = 0
const check = (name: string, got: unknown, want: unknown) => {
  total++
  const ok = got === want
  if (!ok) failed++
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}` + (ok ? '' : `  (want ${want}, got ${got})`))
}
const checkTrue = (name: string, cond: boolean, detail = '') => {
  total++
  if (!cond) failed++
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${name}${detail && !cond ? `  [${detail}]` : ''}`)
}

const feedIn = (snap: ActivitySnapshot, k: string) =>
  snap.feeds.filter((f) => f.key === k)[0]

const dump = (stamp: string, rows: unknown) =>
  fs.writeFileSync(path.join(TMP, `purged-${stamp}.json`), JSON.stringify(rows))

const row = (feed: string, n: string, indexedAt: string, why: string, handle = 'someone') => ({
  uri: `at://did:plc:auth${n}/app.bsky.feed.post/rk${n}`,
  cid: `cid${n}`,
  indexedAt,
  feed,
  handle,
  text: `post ${n}`,
  why,
})

const run = async () => {
  fs.writeFileSync(FILTERS, JSON.stringify(CONFIG))
  loadFiltersOnce()

  const db = createDb(process.env.FEEDGEN_SQLITE_LOCATION as string)
  await migrateToLatest(db)

  // ── the window ────────────────────────────────────────────────────────
  console.log('\n── window')
  const hours = windowHours(NOW)
  check('24 buckets', hours.length, 24)
  check('oldest bucket', hours[0], '2026-08-08T20')
  check('newest bucket is the hour in progress', hours[23], '2026-08-09T19')

  // ── bucketing ─────────────────────────────────────────────────────────
  const posts = [
    ['coffee', 'a', '2026-08-09T18:10:00.000Z'],
    ['coffee', 'b', '2026-08-09T18:50:00.000Z'],
    ['coffee', 'c', '2026-08-09T19:05:00.000Z'],
    ['coffee', 'd', '2026-08-08T20:30:00.000Z'],
    // Before the window opens. Present in the table, absent from the chart.
    ['coffee', 'e', '2026-08-08T19:30:00.000Z'],
    ['radio', 'f', '2026-08-09T18:40:00.000Z'],
    ['radio', 'g', '2026-08-09T17:40:00.000Z'],
    ['radio', 'h', '2026-08-09T16:40:00.000Z'],
    ['radio', 'i', '2026-08-09T15:40:00.000Z'],
  ]
  await db
    .insertInto('post')
    .values(
      posts.map(([feed, n, indexedAt]) => ({
        uri: `at://did:plc:x/app.bsky.feed.post/${n}`,
        cid: `cid-${n}`,
        indexedAt,
        feed,
      })),
    )
    .execute()

  // ── dumps ─────────────────────────────────────────────────────────────
  // Applied inside the window: two coffee rows and one radio row, all from
  // hours EARLIER than the sweep itself. That gap is the whole point of the
  // card, so it is the shape the fixture has.
  dump('20260809T191000Z', [
    row('coffee', '1', '2026-08-09T11:04:00.000Z', 'on moderation list'),
    row('coffee', '2', '2026-08-09T11:41:00.000Z', 'on moderation list'),
    row('radio', '3', '2026-08-09T14:00:00.000Z', 'on moderation list'),
  ])
  // Older than the window. Must not be read at all.
  dump('20260807T120000Z', [row('coffee', '9', '2026-08-07T11:00:00.000Z', 'on moderation list')])
  // A filter sweep, so the kinds differ between events.
  dump('20260809T160000Z', [
    row('coffee', '4', '2026-08-09T15:10:00.000Z', 'excluded by /discount/ on "discount" in text'),
  ])
  // Half-written: purgePosts writes the dump BEFORE it deletes, so a run killed
  // at the wrong moment leaves exactly this. One bad file must not cost the
  // whole view.
  fs.writeFileSync(path.join(TMP, 'purged-20260809T120000Z.json'), '[{"feed":"coff')
  // Everything else that legitimately lives beside the database. None of it is
  // a dump and none of it may be opened — the .sqlite ones are the database and
  // its per-purge snapshots, and parsing those as JSON would be both wrong and
  // expensive.
  fs.writeFileSync(path.join(TMP, 'db-backup-purge-20260809T191000Z.sqlite'), 'SQLite format 3\u0000')
  fs.writeFileSync(path.join(TMP, 'filters.json'), '{}')
  fs.mkdirSync(path.join(TMP, 'filters-backups'), { recursive: true })

  const a = await collectActivity(db, NOW)
  const feed = (k: string) => feedIn(a, k)

  console.log('\n── stored, by hour')
  const coffee = feed('coffee')
  check('coffee 18:00', coffee.stored[22], 2)
  check('coffee 19:00 (in progress)', coffee.stored[23], 1)
  check('coffee oldest bucket', coffee.stored[0], 1)
  check('a post before the window is not in the chart', coffee.stored.reduce((x, y) => x + y, 0), 4)
  check('radio 18:00', feed('radio').stored[22], 1)
  check('feeds do not bleed into each other', feed('radio').stored[0], 0)

  console.log('\n── removed, put back in the hour it ARRIVED')
  // 11:04 and 11:41 are both the 11:00 bucket: 20:00 yesterday is index 0, so
  // 11:00 today is index 15.
  check('coffee 11:00 shows two removed', coffee.purged[15], 2)
  check('...and nothing stored there', coffee.stored[15], 0)
  check('radio 14:00 shows one removed', feed('radio').purged[18], 1)
  check('the sweep hour itself gains nothing', coffee.purged[23], 0)
  check('a dump older than the window is ignored', coffee.purged[0], 0)

  console.log('\n── retention floor')
  check('72h does not reach into a 24h window', retentionFloor('coffee', 4, null, NOW), null)
  checkTrue('6h does', typeof retentionFloor('brief', 0, null, NOW) === 'string')
  check(
    'count retention at the cap reports the oldest row',
    retentionFloor('radio', 4, '2026-08-09T15:40:00.000Z', NOW),
    '2026-08-09T15:40:00.000Z',
  )
  check('...and below the cap reports nothing', retentionFloor('radio', 3, '2026-08-09T15:40:00.000Z', NOW), null)
  check('a feed with no retention has no floor', retentionFloor('plain', 999, '2026-01-01T00:00:00.000Z', NOW), null)
  check('the floor travels in the payload', feed('radio').floor, '2026-08-09T15:40:00.000Z')

  console.log('\n── events')
  check('two dumps in the window', a.events.length, 2)
  check('newest first', a.events[0].at, '2026-08-09T19:10:00.000Z')
  check('total counted', a.events[0].total, 3)
  check('mode inferred from the reason', a.events[0].kind, 'blocklist')
  check('a filter verdict reads as one', a.events[1].kind, 'filter')
  check('per-feed breakdown', a.events[0].byFeed.length, 2)
  check('...largest first', a.events[0].byFeed[0].feed, 'coffee')
  check('...with its count', a.events[0].byFeed[0].count, 2)
  check('the handle survives', a.events[0].rows[0].handle, 'someone')
  check('and so does the raw reason', a.events[1].rows[0].why.indexOf('discount') > -1, true)

  console.log('\n── what it refuses to read')
  checkTrue(
    'a half-written dump is noted, not fatal',
    a.notes.some((n) => n.indexOf('20260809T120000Z') > -1),
    a.notes.join(' | '),
  )
  checkTrue(
    'nothing mentions the database or its snapshots',
    !a.notes.some((n) => n.indexOf('sqlite') > -1),
    a.notes.join(' | '),
  )

  // ── the row cap ───────────────────────────────────────────────────────
  console.log('\n── a dump bigger than the detail list')
  const many: ReturnType<typeof row>[] = []
  for (let i = 0; i < 150; i++) {
    many.push(row('coffee', `m${i}`, '2026-08-09T09:00:00.000Z', 'author'))
  }
  dump('20260809T180000Z', many)
  const b = await collectActivity(db, NOW)
  const big = b.events.filter((e) => e.at === '2026-08-09T18:00:00.000Z')[0]
  check('the detail list is capped', big.rows.length, 100)
  check('the cap is reported, not swallowed', big.omitted, 50)
  check('the total still counts every row', big.total, 150)
  check('and so do the bars', feedIn(b, 'coffee').purged[13], 150)
  check('a targeted sweep reads as manual', big.kind, 'manual')

  // ── withheld ──────────────────────────────────────────────────────────
  console.log('\n── sweeps the safety cap refused')
  fs.writeFileSync(
    path.join(TMP, 'auto-purge-withheld.jsonl'),
    [
      '{"at":"2026-08-09T17:05:00Z","mode":"rejected","feed":"coffee","count":180,"stored":1400,"limit":25}',
      // Written before auto-purge went per-feed: box-wide counts, no feed. The
      // page has to be able to tell the two apart, so the reader keeps it.
      '{"at":"2026-08-09T16:05:00Z","mode":"rejected","count":103,"stored":1635,"limit":25}',
      // Before the window opens.
      '{"at":"2026-08-01T10:00:00Z","mode":"blocked","count":40,"stored":1400,"limit":25}',
      'not json at all',
      '',
    ].join('\n'),
  )
  const c = await collectActivity(db, NOW)
  check('two withheld events in the window', c.withheld.length, 2)
  check('...naming the feed it was scoped to', c.withheld[0].feed, 'coffee')
  check('...with its count', c.withheld[0].count, 180)
  check('...and the cap it hit', c.withheld[0].limit, 25)
  check('...and which sweep it was', c.withheld[0].mode, 'rejected')
  check('a legacy record keeps its box-wide shape, with no feed', c.withheld[1].feed, '')
  checkTrue(
    'an unreadable line is reported',
    c.notes.some((n) => n.indexOf('unreadable line') > -1),
    c.notes.join(' | '),
  )

  // ── a feed the config has forgotten ───────────────────────────────────
  console.log('\n── a feed that is only in the data')
  await db
    .insertInto('post')
    .values([
      {
        uri: 'at://did:plc:x/app.bsky.feed.post/orphan',
        cid: 'cid-orphan',
        indexedAt: '2026-08-09T18:00:00.000Z',
        feed: 'retired',
      },
    ])
    .execute()
  const d = await collectActivity(db, NOW)
  checkTrue(
    'rows under a feed nobody serves are still shown',
    d.feeds.some((f) => f.key === 'retired'),
    d.feeds.map((f) => f.key).join(','),
  )

  // ── an unreadable directory ───────────────────────────────────────────
  console.log('\n── no data directory at all')
  process.env.FEEDGEN_SQLITE_LOCATION = '/tmp/definitely-not-here/db.sqlite'
  const e = await collectActivity(db, NOW)
  check('the chart still comes back', e.hours.length, 24)
  check('with no events', e.events.length, 0)
  checkTrue('and says why', e.notes.length > 0, 'expected a note about the directory')
  process.env.FEEDGEN_SQLITE_LOCATION = path.join(TMP, 'db.sqlite')

  console.log(`\n${total - failed}/${total} checks passed`)
  fs.rmSync(TMP, { recursive: true, force: true })
  if (failed) process.exit(1)
}

run().catch((err) => {
  console.error(err)
  fs.rmSync(TMP, { recursive: true, force: true })
  process.exit(1)
})
