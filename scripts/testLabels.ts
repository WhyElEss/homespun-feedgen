// Moderator labels: the config key, the label bookkeeping, the per-post check,
// the stream frames, whyNot's verdict, and the one thing all of it exists for —
// a feed that names a label does not SERVE a post carrying it, and a feed that
// does not name it serves the post as before.
// Usage: yarn test:labels
//
// Self-contained: no network. The labeler and the AppView are stubbed, the
// database is in memory, and the config is written to FEEDGEN_FILTERS_PATH.
import fs from 'node:fs'
import { MessageFrame, ErrorFrame } from '@atproto/xrpc-server'
import { createDb, migrateToLatest, Database } from '../src/db'
import { loadFiltersOnce, validateFilters } from '../src/filter'
import { makeHandler } from '../src/algos/feed'
import { AppContext } from '../src/config'
import { QueryParams } from '../src/lexicon/types/app/bsky/feed/getFeedSkeleton'
import {
  LABELER_DID,
  Label,
  LabelSubscription,
  applyLabels,
  checkNewPosts,
  foldLabels,
  labelCounts,
  pruneLabels,
  storedLabelsFor,
  uncheckedCount,
} from '../src/labels'
import { explainPost } from '../src/adminWhyNot'

const FILTERS = process.env.FEEDGEN_FILTERS_PATH ?? '/tmp/labels-test-filters.json'

let failed = 0
let passed = 0
const check = (name: string, got: unknown, want: unknown) => {
  const ok = JSON.stringify(got) === JSON.stringify(want)
  if (ok) passed++
  else failed++
  console.log(
    `  ${ok ? 'PASS' : 'FAIL'}  ${name}` +
      (ok ? '' : ` (want ${JSON.stringify(want)}, got ${JSON.stringify(got)})`),
  )
}
const throws = (name: string, fn: () => unknown, needle: string) => {
  try {
    fn()
    check(`${name} — refused`, 'accepted', 'refused')
  } catch (err) {
    check(`${name} — refused, naming the field`, String(err).includes(needle), true)
  }
}

const NOW = Date.parse('2026-09-16T12:00:00.000Z')
const iso = (msAgo: number) => new Date(NOW - msAgo).toISOString()
const uri = (id: string) => `at://did:plc:author/app.bsky.feed.post/${id}`
const lab = (u: string, val: string, extra: Partial<Label> = {}): Label => ({
  src: LABELER_DID,
  uri: u,
  val,
  cts: iso(1000),
  ...extra,
})

const writeConfig = (hide: Record<string, string[] | undefined>) => {
  const feeds: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(hide)) {
    feeds[k] = { includePatterns: [{ pattern: 'x' }], ...(v ? { moderationLabels: v } : {}) }
  }
  fs.writeFileSync(FILTERS, JSON.stringify({ feeds }))
  loadFiltersOnce()
}

const store = async (db: Database, feed: string, ids: string[], ageMs = 10 * 60_000) => {
  await db
    .insertInto('post')
    .values(
      ids.map((id, i) => ({
        uri: uri(id),
        cid: `cid-${id}`,
        indexedAt: iso(ageMs + i * 1000),
        feed,
      })),
    )
    .onConflict((oc) => oc.doNothing())
    .execute()
}

const fresh = async (): Promise<Database> => {
  const db = createDb(':memory:')
  await migrateToLatest(db)
  return db
}

const serve = async (db: Database, feed: string, limit = 50, cursor?: string) =>
  makeHandler(feed)({ db } as AppContext, { feed: '', limit, cursor } as QueryParams)

const run = async () => {
  // ── config ──────────────────────────────────────────────────────────────
  console.log('\n── the moderationLabels key')
  const cfgOf = (extra: Record<string, unknown>) =>
    validateFilters({ feeds: { f: { includePatterns: [{ pattern: 'x' }], ...extra } } }).get('f')!
  check('absent means no labels hidden', cfgOf({}).moderationLabels, [])
  check('values kept, duplicates dropped', cfgOf({ moderationLabels: ['porn', 'sexual', 'porn'] }).moderationLabels, ['porn', 'sexual'])
  check('a system value with "!" is accepted', cfgOf({ moderationLabels: ['!hide'] }).moderationLabels, ['!hide'])
  throws('a capitalised value', () => cfgOf({ moderationLabels: ['Porn'] }), 'moderationLabels')
  throws('a value with a space', () => cfgOf({ moderationLabels: ['graphic media'] }), 'moderationLabels')
  throws('a string instead of a list', () => cfgOf({ moderationLabels: 'porn' }), 'moderationLabels')

  // ── folding ─────────────────────────────────────────────────────────────
  console.log('\n── folding a batch into its last word')
  const f1 = foldLabels([
    lab(uri('a'), 'porn', { cts: iso(3000) }),
    lab(uri('a'), 'porn', { cts: iso(2000), neg: true }),
    lab(uri('b'), 'sexual', { cts: iso(2000), neg: true }),
    lab(uri('b'), 'sexual', { cts: iso(1000) }),
  ])
  check('a label then its withdrawal leaves nothing', f1.get(`${uri('a')}\nporn`), null)
  check('a withdrawal then a new label leaves the label', f1.get(`${uri('b')}\nsexual`)?.val, 'sexual')
  const f2 = foldLabels([
    lab(uri('c'), 'porn', { cts: iso(1000), neg: true }),
    lab(uri('c'), 'porn', { cts: iso(2000) }),
  ])
  check('ordered by cts, not by arrival', f2.get(`${uri('c')}\nporn`), null)
  const f3 = foldLabels([
    lab(uri('d'), 'porn', { src: 'did:plc:someone-else' }),
    lab('did:plc:author', 'porn'),
    lab('at://did:plc:author/app.bsky.actor.profile/self', 'porn'),
  ])
  check('another labeler, an account and a profile are all ignored', f3.size, 0)

  // ── applying ────────────────────────────────────────────────────────────
  console.log('\n── writing labels down')
  {
    const db = await fresh()
    await store(db, 'feedA', ['stored'])
    const n = await applyLabels(db, [lab(uri('stored'), 'porn'), lab(uri('elsewhere'), 'porn')])
    check('one written — the post this box stores', n, 1)
    check('the stored post carries it', await storedLabelsFor(db, uri('stored'), NOW), ['porn'])
    check('the unknown post left no row', await storedLabelsFor(db, uri('elsewhere'), NOW), [])
    await applyLabels(db, [lab(uri('stored'), 'porn', { neg: true, cts: iso(10) })])
    check('a withdrawal removes it', await storedLabelsFor(db, uri('stored'), NOW), [])
    await applyLabels(db, [lab(uri('stored'), 'porn', { exp: iso(-60_000) })])
    await applyLabels(db, [lab(uri('stored'), 'sexual', { exp: iso(60_000) })])
    check('an expired label does not count', await storedLabelsFor(db, uri('stored'), NOW), ['porn'])
  }

  // ── serving ─────────────────────────────────────────────────────────────
  console.log('\n── what a feed serves')
  {
    const db = await fresh()
    // Two feeds hold the same five posts; only feedA hides "porn".
    for (const feed of ['feedA', 'feedB']) await store(db, feed, ['p1', 'p2', 'p3', 'p4', 'p5'])
    await applyLabels(db, [lab(uri('p2'), 'porn'), lab(uri('p4'), 'sexual')])
    writeConfig({ feedA: ['porn'], feedB: undefined })

    const a = await serve(db, 'feedA')
    check('the feed that hides "porn" skips that post', a.feed.map((x) => x.post).includes(uri('p2')), false)
    check('and serves the rest, including a label it does not name', a.feed.length, 4)
    const b = await serve(db, 'feedB')
    check('the feed that names no label serves all five', b.feed.length, 5)

    const page = await serve(db, 'feedA', 2)
    check('a page still holds `limit` rows', page.feed.length, 2)
    const next = await serve(db, 'feedA', 2, page.cursor)
    check('and paging carries on past the hidden post',
      [...page.feed, ...next.feed].map((x) => x.post).includes(uri('p2')), false)
    check('with nothing served twice',
      new Set([...page.feed, ...next.feed].map((x) => x.post)).size, 4)

    writeConfig({ feedA: [], feedB: undefined })
    check('switching the label off brings the post straight back', (await serve(db, 'feedA')).feed.length, 5)
    writeConfig({ feedA: ['porn', 'sexual'], feedB: undefined })
    check('two values hide both posts', (await serve(db, 'feedA')).feed.length, 3)

    await applyLabels(db, [lab(uri('p2'), 'porn', { neg: true, cts: iso(0) })])
    check('a label withdrawn upstream brings the post back', (await serve(db, 'feedA')).feed.length, 4)

    await db.deleteFrom('post_label').execute()
    await applyLabels(db, [lab(uri('p1'), 'porn', { exp: new Date(Date.now() - 1000).toISOString() })])
    check('a label past its expiry hides nothing', (await serve(db, 'feedA')).feed.length, 5)

    fs.writeFileSync(FILTERS, JSON.stringify({ feeds: {
      feedA: { includePatterns: [{ pattern: 'x' }], moderationLabels: ['porn'], pinnedPost: uri('p3') },
    } }))
    loadFiltersOnce()
    await applyLabels(db, [lab(uri('p3'), 'porn', { cts: iso(0) })])
    const pinned = await serve(db, 'feedA', 10)
    check('the pin is the operator\'s choice and is not hidden', pinned.feed[0].post, uri('p3'))

    // The real clock, like the handler: the expired label above was stamped
    // against it, not against NOW.
    const counts = await labelCounts(db, 'feedA')
    check('counts are per value, for this feed\'s stored posts', counts.counts, { porn: 1 })
    check('and say how many are stored', counts.stored, 5)
  }

  // ── asking about each new post ──────────────────────────────────────────
  console.log('\n── the per-post check')
  {
    const db = await fresh()
    await store(db, 'feedA', Array.from({ length: 60 }, (_, i) => `old${i}`), 10 * 60_000)
    await store(db, 'feedB', ['old0'], 10 * 60_000) // the same post in a second feed
    await store(db, 'feedA', ['young'], 5_000)

    const calls: string[][] = []
    const labeler = async (url: string) => {
      const u = new URL(url)
      const patterns = u.searchParams.getAll('uriPatterns')
      calls.push(patterns)
      const labels = patterns.includes(uri('old7'))
        ? [lab(uri('old7'), 'porn'), lab(uri('old7'), 'nudity', { neg: true })]
        : []
      return { ok: true, status: 200, json: async () => ({ cursor: '1', labels }) }
    }
    const r = await checkNewPosts(db, { now: NOW, fetchImpl: labeler })
    check('every stored post older than a minute was asked about, once', r.checked, 60)
    check('in batches of 50', calls.map((c) => c.length), [50, 10])
    check('the post a few seconds old waits for the classifier', calls.flat().includes(uri('young')), false)
    check('the labelled one is written down', await storedLabelsFor(db, uri('old7'), NOW), ['porn'])
    check('one post left unchecked — the young one', await uncheckedCount(db), 1)

    calls.length = 0
    await checkNewPosts(db, { now: NOW, fetchImpl: labeler })
    check('nothing is asked twice', calls.length, 0)

    const failing = async () => ({ ok: false, status: 503, json: async () => ({}) })
    let threw = false
    try {
      await checkNewPosts(db, { now: NOW + 120_000, fetchImpl: failing })
    } catch {
      threw = true
    }
    check('a labeler outage is reported', threw, true)
    check('and the post it could not ask about stays unchecked', await uncheckedCount(db), 1)

    // Paging: a full page means ask again with the cursor.
    const db2 = await fresh()
    await store(db2, 'feedA', ['busy'])
    let pages = 0
    await checkNewPosts(db2, {
      now: NOW,
      fetchImpl: async (url: string) => {
        pages++
        const first = !new URL(url).searchParams.get('cursor')
        const labels = first
          ? Array.from({ length: 250 }, (_, i) => lab(uri('busy'), 'noise', { cts: iso(5000 - i) }))
          : [lab(uri('busy'), 'porn')]
        return { ok: true, status: 200, json: async () => ({ cursor: first ? 'c1' : 'c2', labels }) }
      },
    })
    check('a full page of labels is followed by the next', pages, 2)
    check('and the label on the second page is kept', (await storedLabelsFor(db2, uri('busy'), NOW)).includes('porn'), true)
  }

  // ── tidying ─────────────────────────────────────────────────────────────
  console.log('\n── pruning')
  {
    const db = await fresh()
    await store(db, 'feedA', ['kept', 'gone'])
    await applyLabels(db, [lab(uri('kept'), 'porn'), lab(uri('gone'), 'porn'), lab(uri('kept'), 'sexual', { exp: iso(1) })])
    await db.insertInto('label_check').values([{ uri: uri('kept'), checkedAt: iso(0) }, { uri: uri('gone'), checkedAt: iso(0) }]).execute()
    await db.deleteFrom('post').where('uri', '=', uri('gone')).execute()
    await pruneLabels(db, NOW)
    const left = await db.selectFrom('post_label').select(['uri', 'val']).execute()
    check('a label whose post is gone is removed, and an expired one', left.map((l) => l.val), ['porn'])
    const checks = await db.selectFrom('label_check').select('uri').execute()
    check('a check whose post is gone is removed', checks.map((c) => c.uri), [uri('kept')])
  }

  // ── the stream ──────────────────────────────────────────────────────────
  console.log('\n── stream frames')
  {
    const db = await fresh()
    await store(db, 'feedA', ['live'])
    await db.insertInto('label_check').values({ uri: uri('live'), checkedAt: iso(0) }).execute()
    const sub = new LabelSubscription(db, 'https://labeler.invalid')
    const frame = (body: unknown, type: string) =>
      new MessageFrame(body as Record<string, unknown>, { type }).toBytes()

    await sub.handleFrame(frame({ seq: 42, labels: [lab(uri('live'), 'porn')] }, '#labels'))
    check('a #labels frame writes the label', await storedLabelsFor(db, uri('live'), NOW), ['porn'])
    check('and moves the cursor', (sub as any).cursor, 42)

    await sub.handleFrame(new ErrorFrame({ error: 'FutureCursor', message: 'x' }).toBytes())
    check('an error frame is survived', (sub as any).cursor, 42)

    await sub.handleFrame(frame({ name: 'OutdatedCursor', message: 'too old' }, '#info'))
    check('an outdated cursor makes every stored post be asked about again', await uncheckedCount(db), 1)

    const origLog = console.warn
    console.warn = () => {}
    ;(sub as any).ws = { terminate: () => { (sub as any).terminated = true } }
    ;(sub as any).lastMessageAt = NOW
    check('a live stream is left alone', sub.checkAlive(NOW + 60_000), false)
    check('five silent minutes forces a reconnect', sub.checkAlive(NOW + 5 * 60_000 + 1), true)
    console.warn = origLog
  }

  // ── whyNot ──────────────────────────────────────────────────────────────
  console.log('\n── whyNot')
  {
    const db = await fresh()
    await store(db, 'feedA', ['why'])
    await store(db, 'feedB', ['why'])
    writeConfig({ feedA: ['porn'], feedB: undefined })
    const origFetch = global.fetch
    ;(global as any).fetch = async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        posts: [{
          uri: uri('why'),
          author: { handle: 'ann.example' },
          record: { text: 'x marks the window', createdAt: iso(0) },
          labels: [
            { src: LABELER_DID, uri: uri('why'), val: 'porn', cts: iso(0) },
            { src: 'did:plc:someone-else', uri: uri('why'), val: 'spam', cts: iso(0) },
          ],
        }],
      }),
    })
    try {
      const r = await explainPost(db, uri('why'))
      check('the post\'s moderation labels are reported, and only Bluesky\'s', r.moderationLabels, ['porn'])
      const a = r.feeds.find((f) => f.key === 'feedA')!
      const b = r.feeds.find((f) => f.key === 'feedB')!
      check('the feed that hides it says which label', a.hiddenByLabels, ['porn'])
      check('the feed that does not, says nothing', b.hiddenByLabels, [])
      check('matching and hiding stay separate answers', a.wouldIndex, true)
    } finally {
      global.fetch = origFetch
    }
  }

  console.log(`\n${passed} passed, ${failed} failed`)
  process.exit(failed ? 1 : 0)
}

run().catch((err) => {
  console.error(err)
  process.exit(1)
})
