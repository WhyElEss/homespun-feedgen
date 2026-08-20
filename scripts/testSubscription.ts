import fs from 'node:fs'
import { createDb, migrateToLatest } from '../src/db'
import { JetstreamSubscription } from '../src/subscription'
import { loadFiltersOnce } from '../src/filter'

// Covers the ingest path: what a Jetstream event does to the database.
// This is the code that decides what ends up in every feed, and until now it
// was the only substantial file with no test at all.
//
// Run against a throwaway config and an in-memory database:
//   FEEDGEN_FILTERS_PATH=/tmp/sub-test-filters.json ts-node scripts/testSubscription.ts

const FIXTURE = process.env.FEEDGEN_FILTERS_PATH ?? '/tmp/sub-test-filters.json'

fs.writeFileSync(
  FIXTURE,
  JSON.stringify(
    {
      feeds: {
        coffee: {
          includePatterns: [{ pattern: 'coffee' }],
          excludePatterns: [{ pattern: 'decaf' }],
          retention: { type: 'hours', value: 72 },
          excludeListUri: 'at://did:plc:example/app.bsky.graph.list/fake',
        },
        // Overlaps deliberately: one post can land in two feeds.
        espresso: {
          includePatterns: [{ pattern: 'coffee|espresso' }],
          retention: { type: 'count', value: 500 },
        },
        // Author feed, so the DID gate is exercised too.
        onlyBob: {
          includeDids: ['did:plc:bob'],
          retention: { type: 'hours', value: 24 },
        },
      },
    },
    null,
    2,
  ),
)
process.env.FEEDGEN_FILTERS_PATH = FIXTURE

let pass = 0
let total = 0
const check = (name: string, cond: boolean, detail = '') => {
  total++
  if (cond) pass++
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? `  [${detail}]` : ''}`)
}

const US = 1_000 // microseconds per millisecond
const at = (iso: string) => Date.parse(iso) * US

const commit = (o: {
  did?: string
  rkey?: string
  op?: 'create' | 'update' | 'delete'
  text?: string
  time?: number
  collection?: string
  kind?: string
}) =>
  JSON.stringify({
    did: o.did ?? 'did:plc:alice',
    time_us: o.time ?? at('2026-08-02T12:00:00.000Z'),
    kind: o.kind ?? 'commit',
    commit: {
      rev: '1',
      operation: o.op ?? 'create',
      collection: o.collection ?? 'app.bsky.feed.post',
      rkey: o.rkey ?? 'aaa',
      cid: 'bafyexample',
      record: o.text === undefined ? undefined : { $type: 'app.bsky.feed.post', text: o.text },
    },
  })

const run = async () => {
  // loadFiltersOnce, not watchFilters: the watcher keeps an fs.watchFile
  // handle open and the process would never exit on success.
  loadFiltersOnce()
  const db = createDb(':memory:')
  await migrateToLatest(db)
  const sub = new JetstreamSubscription(db, 'wss://example.invalid')

  const rows = async (feed?: string) => {
    let q = db.selectFrom('post').selectAll()
    if (feed) q = q.where('feed', '=', feed)
    return q.execute()
  }

  console.log('\n── a matching post is stored')
  await sub.handleMessage(commit({ text: 'fresh coffee today', rkey: 'p1' }))
  const r1 = await rows()
  check('lands in both feeds whose patterns match', r1.length === 2, r1.map((r) => r.feed).sort().join(','))
  check('not in the author-only feed', !r1.some((r) => r.feed === 'onlyBob'))

  console.log('\n── indexedAt comes from time_us, not the wall clock')
  // The regression this guards: stamping with new Date() put replayed posts at
  // the top of the feed instead of their true position.
  const t = at('2026-07-04T08:30:00.000Z')
  await sub.handleMessage(commit({ text: 'coffee again', rkey: 'p2', time: t }))
  const r2 = (await rows()).find((r) => r.uri.endsWith('p2'))!
  check('stamped from the event', r2.indexedAt === '2026-07-04T08:30:00.000Z', r2.indexedAt)

  console.log('\n── an exclude applies per feed, not globally')
  // `coffee` excludes decaf; `espresso` has no exclude list, so it keeps the
  // post. Asserting on a total row count here would be wrong.
  await sub.handleMessage(commit({ text: 'decaf coffee', rkey: 'x1' }))
  check(
    'dropped by the feed that excludes it',
    !(await rows('coffee')).some((r) => r.uri.endsWith('x1')),
  )
  check(
    'kept by a feed that does not',
    (await rows('espresso')).some((r) => r.uri.endsWith('x1')),
  )

  console.log('\n── events that must store nothing at all')
  // Each case is measured against a freshly taken count, so one failure cannot
  // cascade into the rest.
  const stores = async (name: string, msg: string) => {
    const n = (await rows()).length
    await sub.handleMessage(msg)
    check(name, (await rows()).length === n)
  }
  await stores('no include match anywhere', commit({ text: 'tea only', rkey: 'x2' }))
  await stores(
    'another collection',
    commit({ text: 'coffee', rkey: 'x3', collection: 'app.bsky.feed.like' }),
  )
  await stores('a non-commit event', commit({ text: 'coffee', rkey: 'x4', kind: 'identity' }))
  await stores('a commit with no record', commit({ rkey: 'x5' }))
  await stores('a repeated create', commit({ text: 'fresh coffee today', rkey: 'p1' }))
  await stores('an update operation', commit({ text: 'coffee now', rkey: 'p1', op: 'update' }))

  console.log('\n── the author gate')
  await sub.handleMessage(commit({ did: 'did:plc:bob', text: 'anything at all', rkey: 'b1' }))
  check('a tracked author is stored with no pattern match', (await rows('onlyBob')).length === 1)
  await sub.handleMessage(commit({ did: 'did:plc:carol', text: 'anything at all', rkey: 'c1' }))
  check('an untracked author is not', (await rows('onlyBob')).length === 1)

  console.log('\n── the moderation list')
  sub.excludedDids = new Map([['coffee', new Set(['did:plc:mallory'])]])
  await sub.handleMessage(commit({ did: 'did:plc:mallory', text: 'coffee spam', rkey: 'm1' }))
  const m = await rows()
  check('blocked for the feed that lists them', !m.some((r) => r.feed === 'coffee' && r.uri.includes('mallory')))
  check('still stored for a feed that does not', m.some((r) => r.feed === 'espresso' && r.uri.includes('mallory')))

  console.log('\n── deletes')
  await sub.handleMessage(commit({ op: 'delete', rkey: 'p1' }))
  check('a delete removes the post from every feed', !(await rows()).some((r) => r.uri.endsWith('/p1')))
  const survived = (await rows()).length
  await sub.handleMessage(commit({ op: 'delete', rkey: 'never-existed' }))
  check('deleting an unknown post is harmless', (await rows()).length === survived)

  console.log('\n── the cursor')
  const late = at('2026-08-02T23:59:00.000Z')
  await sub.handleMessage(commit({ text: 'tea', rkey: 'z1', time: late }))
  check('advances even on an event that stores nothing', (sub as any).cursor === late)

  console.log('\n── the idle watchdog')
  // The regression this guards is a real outage: a 77-second link flap on
  // 2026-08-19 left the socket half-open, no 'close' or 'error' ever fired, and
  // ingest stopped for 10.5 hours behind a process that looked perfectly well.
  // Driven with a stub socket -- the whole point of the failure is that a real
  // connection produces no event to test against.
  const stub = { terminated: 0, readyState: 1, terminate() { this.terminated++ } }
  const sub2 = new JetstreamSubscription(db, 'wss://example.invalid')
  const poke = (o: Record<string, unknown>) => Object.assign(sub2 as any, o)

  poke({ ws: stub, lastMessageAt: Date.now() })
  check('a talking connection is left alone', sub2.checkAlive() === false && stub.terminated === 0)

  poke({ lastMessageAt: Date.now() - 61_000 })
  check('a silent one is terminated', sub2.checkAlive() === true && stub.terminated === 1)
  check(
    'and not terminated again while the reconnect lands',
    sub2.checkAlive() === false && stub.terminated === 1,
  )

  poke({ lastMessageAt: Date.now() - 61_000 })
  await sub2.handleMessage(commit({ text: 'tea', rkey: 'live1' }))
  check(
    'any arriving message counts, even one that stores nothing',
    sub2.checkAlive() === false && stub.terminated === 1,
  )

  poke({ lastMessageAt: Date.now() - 61_000 })
  await sub2.handleMessage('{ not json').catch(() => {})
  check(
    'so does one that cannot be parsed - bytes are bytes',
    sub2.checkAlive() === false && stub.terminated === 1,
  )

  poke({ ws: undefined, lastMessageAt: 0 })
  check('with no socket there is nothing to give up on', sub2.checkAlive() === false)

  console.log(`\n${pass === total ? 'All' : `${pass} of`} ${total} checks passed`)
  process.exit(pass === total ? 0 : 1)
}

run().catch((err) => {
  console.error(err)
  process.exit(1)
})
