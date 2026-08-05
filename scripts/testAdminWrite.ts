// Covers saving the config over HTTP and the lab that measures an edit first.
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

const mount = async (writable: boolean, db?: any) => {
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
    check('...saying why, in terms of the standby', String(put.body.error).includes('primary'))
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
