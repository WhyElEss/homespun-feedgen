// Covers saving the config over HTTP, the lab that measures an edit first, and
// the delete button that removes one post without consulting either.
// Usage: yarn testAdminWrite  (needs FEEDGEN_FILTERS_PATH — see below)
//
// The interesting cases here are all refusals: a save is the one thing in this
// UI that can break four live feeds, so what it declines to do matters more
// than the happy path.
import fs from 'node:fs'
import path from 'node:path'
import express from 'express'
import { createAdminRouter } from '../src/admin'
import { createAdminAuth, hashPassword } from '../src/adminAuth'
import { measureCandidate, seedCorpus, StoredPost } from '../src/adminLab'
import { deletePost, inspectPost } from '../src/adminDelete'
import { loadFiltersOnce, buildHaystacks, MatchablePost } from '../src/filter'
import { createDb, migrateToLatest } from '../src/db'

// filter.ts captures this at module load, so it has to come from the
// environment — setting it here would already be too late.
const FILTERS = process.env.FEEDGEN_FILTERS_PATH
if (!FILTERS) {
  console.error('FEEDGEN_FILTERS_PATH must be set — run this as `yarn testAdminWrite`')
  process.exit(1)
}
const PASSWORD = 'correct horse battery staple'

const baseConfig = () => ({
  feeds: {
    coffee: {
      displayName: 'Coffee',
      includePatterns: [{ pattern: '\\bcoffee\\b|#coffee\\b' }],
      excludePatterns: [{ pattern: '\\bdiscount\\b' }],
      retention: { type: 'hours', value: 72 },
    },
  },
})

fs.writeFileSync(FILTERS, JSON.stringify(baseConfig(), null, 2) + '\n')

let pass = 0
let total = 0
const check = (name: string, cond: boolean, detail = '') => {
  total++
  if (cond) pass++
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? `  [${detail}]` : ''}`)
}

const post = (uri: string, handle: string, text: string): StoredPost => {
  const record: MatchablePost = { text }
  return {
    uri,
    did: 'did:plc:' + handle,
    handle,
    text,
    indexedAt: new Date().toISOString(),
    hay: buildHaystacks(record),
    record,
  }
}

const mount = async (writable: boolean, db?: any, delDb?: any) => {
  const auth = createAdminAuth({ passwordHash: await hashPassword(PASSWORD) })
  const app = express()
  app.use(
    '/admin',
    createAdminRouter({
      auth,
      writable,
      lab: db
        ? (feed, filters, refresh) => measureCandidate(db, feed, filters, { refresh })
        : undefined,
      inspectPost: delDb ? (feed, input) => inspectPost(delDb, feed, input) : undefined,
      deletePost: delDb ? (feed, input) => deletePost(delDb, feed, input) : undefined,
    }),
  )
  const server = app.listen(0, '127.0.0.1')
  await new Promise((r) => server.once('listening', r))
  const url = `http://127.0.0.1:${(server.address() as any).port}/admin`
  const login = await fetch(`${url}/api/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ user: 'admin', password: PASSWORD }),
  })
  const cookie = (login.headers.get('set-cookie') ?? '').split(';')[0]
  const call = async (p: string, init: { method?: string; body?: unknown } = {}) => {
    const r = await fetch(`${url}${p}`, {
      method: init.method ?? (init.body !== undefined ? 'POST' : 'GET'),
      headers: init.body !== undefined
        ? { 'content-type': 'application/json', cookie }
        : { cookie },
      body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
    })
    return { status: r.status, body: (await r.json()) as any }
  }
  return { call, close: () => server.close() }
}

const onDisk = () => JSON.parse(fs.readFileSync(FILTERS, 'utf8'))

const run = async () => {
  console.log('\n── a read-only box refuses to save')
  {
    const { call, close } = await mount(false)
    const got = await call('/filters')
    check('GET reports it is read-only', got.body.writable === false)
    const put = await call('/filters', {
      method: 'PUT',
      body: { filters: baseConfig(), expectedDigest: got.body.digest },
    })
    check('PUT is refused', put.status === 403)
    // The refusal has to explain that an edit here would be UNDONE, not just
    // that it is forbidden. Deliberately not asserted in terms of a "standby"
    // or a "primary": the page answers for the box it is served from, and the
    // set of boxes changes.
    check(
      '...saying why: the edit would be overwritten',
      /overwritten|undone/i.test(String(put.body.error)),
    )
    close()
  }

  console.log('\n── saving, on a box that may')
  const { call, close } = await mount(true)
  const first = await call('/filters')
  check('GET returns a digest', /^[0-9a-f]{12}$/.test(first.body.digest ?? ''))
  check('...and says it is writable', first.body.writable === true)

  const stale = await call('/filters', {
    method: 'PUT',
    body: { filters: baseConfig(), expectedDigest: 'ffffffffffff' },
  })
  check('a stale digest is a conflict, not an overwrite', stale.status === 409)
  check('...and reports both digests', stale.body.actual === first.body.digest)

  const broken = JSON.parse(JSON.stringify(baseConfig()))
  broken.feeds.coffee.includePatterns[0].pattern = '('
  const bad = await call('/filters', {
    method: 'PUT',
    body: { filters: broken, expectedDigest: first.body.digest },
  })
  check('an invalid regex is refused', bad.status === 400)
  check('...naming the offending path', String(bad.body.error).includes('includePatterns'))

  const added = JSON.parse(JSON.stringify(baseConfig()))
  added.feeds.tea = { includePatterns: [{ pattern: 'tea' }] }
  const addRes = await call('/filters', {
    method: 'PUT',
    body: { filters: added, expectedDigest: first.body.digest },
  })
  check('adding a feed is refused — routing is built at startup', addRes.status === 400)
  check('...and says a restart is what it needs', String(addRes.body.error).includes('restart'))

  const removed = { feeds: {} as any }
  const rmRes = await call('/filters', {
    method: 'PUT',
    body: { filters: removed, expectedDigest: first.body.digest },
  })
  check('removing every feed is refused too', rmRes.status === 400)

  check('none of the refusals touched the file', onDisk().feeds.coffee.displayName === 'Coffee')
  check('...and left no feed behind', Object.keys(onDisk().feeds).join() === 'coffee')

  const next = JSON.parse(JSON.stringify(baseConfig()))
  next.feeds.coffee.excludePatterns.push({ pattern: '\\bsponsored\\b', comment: 'ads' })
  const ok = await call('/filters', {
    method: 'PUT',
    body: { filters: next, expectedDigest: first.body.digest },
  })
  check('a valid edit is saved', ok.status === 200 && ok.body.ok === true)
  check('...and lands on disk', onDisk().feeds.coffee.excludePatterns.length === 2)
  check('...returning the new digest', ok.body.digest !== first.body.digest)
  check('...having backed up the previous file', !!ok.body.backup && fs.existsSync(ok.body.backup))
  check(
    'the backup holds the OLD config, not the new one',
    JSON.parse(fs.readFileSync(ok.body.backup, 'utf8')).feeds.coffee.excludePatterns.length === 1,
  )
  check(
    'the digest it returned matches the file it wrote',
    (await call('/filters')).body.digest === ok.body.digest,
  )

  const replay = await call('/filters', {
    method: 'PUT',
    body: { filters: baseConfig(), expectedDigest: first.body.digest },
  })
  check('the old digest no longer works — no lost updates', replay.status === 409)
  close()

  console.log('\n── the lab')
  {
    const dbPath = path.join(path.dirname(FILTERS), 'lab-test.sqlite')
    fs.rmSync(dbPath, { force: true })
    const db = createDb(dbPath)
    await migrateToLatest(db)
    // Restore the config the corpus was written against, then load it.
    fs.writeFileSync(FILTERS, JSON.stringify(baseConfig(), null, 2) + '\n')
    loadFiltersOnce()

    // A hundred posts, not five: the auto-purge cap is proportional (5%), so a
    // toy corpus makes every single removal look like a dangerous sweep. The
    // first run of this test asserted the opposite and was wrong about it.
    const filler = Array.from({ length: 95 }, (_, i) =>
      post(`at://f${i}`, `user${i}`, `coffee number ${i}`),
    )
    seedCorpus('coffee', [
      post('at://1', 'ann', 'fresh coffee this morning'),
      post('at://2', 'bob', 'coffee and a discount code'),  // already excluded
      post('at://3', 'cid', 'pour over coffee, no ads'),
      post('at://4', 'dee', 'coffee sponsored by someone'),
      post('at://5', 'eve', 'espresso only'),               // never matched the include
      ...filler,
    ], 2)

    const { call: lab, close: closeLab } = await mount(true, db)

    const unchanged = await lab('/lab/measure', {
      body: { feed: 'coffee', filters: baseConfig() },
    })
    check('an unchanged config removes nothing', unchanged.body.result.removed === 0)
    check(
      'it counts what the feed holds now, not the whole corpus',
      unchanged.body.result.keptNow === 98,
      `keptNow=${unchanged.body.result.keptNow}`,
    )
    check('unretrievable rows are reported', unchanged.body.result.unretrievable === 2)

    const tighter = JSON.parse(JSON.stringify(baseConfig()))
    tighter.feeds.coffee.excludePatterns.push({ pattern: '\\bsponsored\\b' })
    const measured = await lab('/lab/measure', {
      body: { feed: 'coffee', filters: tighter },
    })
    const r = measured.body.result
    check('a new exclude is measured', r.removed === 1, `removed=${r.removed}`)
    check('...naming the post it would take', r.samples[0]?.handle === 'dee')
    check('...and why', String(r.samples[0]?.reason).includes('excluded by'))
    check('...leaving the rest', r.keptAfter === 97, `keptAfter=${r.keptAfter}`)
    check('a small change is under the auto-purge cap', r.wouldExceedAutoPurgeCap === false)

    const narrowed = JSON.parse(JSON.stringify(baseConfig()))
    narrowed.feeds.coffee.includePatterns[0].pattern = '#coffee\\b'
    const narrow = await lab('/lab/measure', { body: { feed: 'coffee', filters: narrowed } })
    check(
      'narrowing an include shows what would be lost',
      narrow.body.result.removed === 98,
      `removed=${narrow.body.result.removed}`,
    )
    check(
      '...and flags that auto-purge would withhold a sweep that big',
      narrow.body.result.wouldExceedAutoPurgeCap === true,
    )

    // The one that matters: a pattern is user input, and this process also
    // ingests the firehose. It must not be possible to hang it from a browser.
    const evil = JSON.parse(JSON.stringify(baseConfig()))
    evil.feeds.coffee.excludePatterns.push({ pattern: '(a+)+$' })
    seedCorpus('coffee', [post('at://6', 'mal', 'coffee ' + 'a'.repeat(46) + '!')])
    const started = Date.now()
    const hung = await lab('/lab/measure', { body: { feed: 'coffee', filters: evil } })
    const elapsed = Date.now() - started
    check('a catastrophic pattern is stopped, not run', hung.status === 400)
    check('...quickly', elapsed < 15_000, `${elapsed}ms`)
    check('...explaining what happened', String(hung.body.error).includes('backtracking'))
    check('...and the config on disk is untouched', onDisk().feeds.coffee.excludePatterns.length === 1)

    const wrongFeed = await lab('/lab/measure', { body: { feed: 'nope', filters: baseConfig() } })
    check('measuring an unknown feed is an error, not a crash', wrongFeed.status === 400)

    closeLab()
    await db.destroy()
    fs.rmSync(dbPath, { force: true })
  }

  console.log('\n\u2500\u2500 deleting one post')
  {
    // Two feeds, and the post lives in both: "gone from one of them" is the
    // failure this whole section exists to rule out.
    const PINNED = 'at://did:plc:pinned/app.bsky.feed.post/aaa'
    const TARGET = 'at://did:plc:author/app.bsky.feed.post/bbb'
    const KEEP = 'at://did:plc:author/app.bsky.feed.post/ccc'
    const twoFeeds: any = JSON.parse(JSON.stringify(baseConfig()))
    twoFeeds.feeds.tea = {
      displayName: 'Tea',
      includePatterns: [{ pattern: '\\btea\\b' }],
      pinnedPost: PINNED,
      retention: { type: 'hours', value: 72 },
    }
    fs.writeFileSync(FILTERS, JSON.stringify(twoFeeds, null, 2) + '\n')
    loadFiltersOnce()

    const dbPath = path.join(path.dirname(FILTERS), 'delete-test.sqlite')
    fs.rmSync(dbPath, { force: true })
    process.env.FEEDGEN_SQLITE_LOCATION = dbPath
    const db = createDb(dbPath)
    await migrateToLatest(db)
    const rows = [
      { uri: TARGET, cid: 'cid1', indexedAt: '2026-09-01T10:00:00.000Z', feed: 'coffee' },
      { uri: TARGET, cid: 'cid1', indexedAt: '2026-09-01T10:00:00.000Z', feed: 'tea' },
      { uri: KEEP, cid: 'cid2', indexedAt: '2026-09-01T10:05:00.000Z', feed: 'coffee' },
      { uri: PINNED, cid: 'cid3', indexedAt: '2026-09-01T10:06:00.000Z', feed: 'tea' },
    ]
    await db.insertInto('post').values(rows).execute()
    const remaining = async () =>
      (await db.selectFrom('post').select(['uri', 'feed']).execute()).length
    const feedsHolding = async (uri: string) =>
      (await db.selectFrom('post').select(['feed']).where('uri', '=', uri).execute())
        .map((r) => r.feed)
        .sort()

    {
      const { call: ro, close: closeRo } = await mount(false, undefined, db)
      const res = await ro('/post/delete', { body: { feed: 'coffee', input: TARGET } })
      check('a read-only box refuses to delete', res.status === 403)
      // Refused at the FIRST step too: a Resolve that works in front of a
      // Delete that cannot is a dead end with an encouraging button on it.
      const look = await ro('/post/inspect', { body: { feed: 'coffee', input: TARGET } })
      check('...and refuses the look-up that precedes it', look.status === 403)
      check('...and nothing was removed', (await remaining()) === 4)
      closeRo()
    }

    const { call: del, close: closeDel } = await mount(true, undefined, db)

    const noFeed = await del('/post/delete', { body: { input: TARGET } })
    check('a delete with no feed is refused, never guessed at', noFeed.status === 400)
    check('...saying what is missing', String(noFeed.body.error).includes('feed'))

    const wrongFeed = await del('/post/inspect', { body: { feed: 'nope', input: TARGET } })
    check('a feed that is not in the config is an error', wrongFeed.status === 400)

    const empty = await del('/post/delete', { body: { feed: 'coffee', input: '   ' } })
    check('an empty field is refused', empty.status === 400)

    const junk = await del('/post/delete', { body: { feed: 'coffee', input: 'not a link' } })
    check('junk is refused with an instruction', junk.status === 400)
    check('...naming the shape it wants', String(junk.body.error).includes('bsky.app'))

    // Step one, and the whole reason there are two: what is at this link, and
    // does THIS feed hold it. Reads only.
    const seen = await del('/post/inspect', { body: { feed: 'coffee', input: TARGET } })
    check('inspect answers before anything is deleted', seen.status === 200)
    check('...for the feed it was asked about', seen.body.result.feed === 'coffee')
    check('...saying that feed holds it', seen.body.result.stored === true)
    // The scoping rule made visible: the post is in tea as well, and the answer
    // has to say so without implying the button reaches there.
    check('...and naming the OTHER feeds as untouched',
      seen.body.result.alsoIn.join() === 'Tea',
      JSON.stringify(seen.body.result.alsoIn))
    check('...having removed nothing', (await remaining()) === 4)

    const pinnedFirst = await del('/post/inspect', { body: { feed: 'tea', input: PINNED } })
    check('inspect flags a pin BEFORE the delete, not after',
      pinnedFirst.body.result.pinnedHere === true)
    const pinnedElsewhere = await del('/post/inspect', { body: { feed: 'coffee', input: PINNED } })
    check('...and a pin on ANOTHER feed is not this feed\'s warning',
      pinnedElsewhere.body.result.pinnedHere === false)

    // The one that matters. A post stored for two feeds is two rows, and this
    // takes exactly one of them: the feed the page had open.
    const gone = await del('/post/delete', { body: { feed: 'coffee', input: TARGET } })
    check('the post is deleted', gone.status === 200 && gone.body.result.removed === 1)
    check('...from the SELECTED feed only', (await feedsHolding(TARGET)).join() === 'tea',
      (await feedsHolding(TARGET)).join())
    check('...leaving every other row alone', (await remaining()) === 3)

    // The trail. Without it this is the only kind of removal on the box that
    // leaves no record, and the Activity tab would under-report.
    const dump = gone.body.result.dump
    check('it wrote a dump beside the database', !!dump && fs.existsSync(dump))
    const dumped = JSON.parse(fs.readFileSync(dump, 'utf8'))
    check('...with the one row it removed', dumped.length === 1)
    check('...filed under that feed', dumped[0]?.feed === 'coffee')
    check(
      '...marked as a removal made by hand',
      dumped.every((d: any) => d.why === 'deleted by hand'),
      String(dumped[0]?.why),
    )
    check(
      '...carrying the fields the activity view reads',
      dumped.every((d: any) => d.uri && d.feed && d.indexedAt),
    )

    const again = await del('/post/delete', { body: { feed: 'coffee', input: TARGET } })
    check('deleting it twice is not an error', again.status === 200)
    check('...it simply reports nothing was there', again.body.result.removed === 0)
    check('...and writes no dump for a no-op', again.body.result.dump === null)
    check('...and the copy in the other feed is STILL there',
      (await feedsHolding(TARGET)).join() === 'tea')

    // Deleting it from the other feed is a separate, deliberate act — which is
    // the whole point of the scoping.
    const second = await del('/post/delete', { body: { feed: 'tea', input: TARGET } })
    check('switching feed and repeating removes the other copy',
      second.body.result.removed === 1 && (await feedsHolding(TARGET)).length === 0)

    const pinned = await del('/post/delete', { body: { feed: 'tea', input: PINNED } })
    check('a pinned post still deletes', pinned.body.result.removed === 1)
    check('...but says it is still pinned', pinned.body.result.pinnedHere === true)

    closeDel()
    await db.destroy()
    fs.rmSync(dbPath, { force: true })
    delete process.env.FEEDGEN_SQLITE_LOCATION
  }

  fs.rmSync(FILTERS, { force: true })
  fs.rmSync(path.join(path.dirname(FILTERS), 'filters-backups'), {
    recursive: true,
    force: true,
  })
  console.log(`\n${pass === total ? 'All' : `${pass} of`} ${total} checks passed`)
  process.exit(pass === total ? 0 : 1)
}

run().catch((err) => {
  console.error(err)
  process.exit(1)
})
