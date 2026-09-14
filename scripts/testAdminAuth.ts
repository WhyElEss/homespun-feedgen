// Covers the password layer in front of the admin UI and the status snapshot
// behind it. Usage: ts-node scripts/testAdminAuth.ts
//
// This is the only barrier between the internet and the config of live feeds,
// so the tests care as much about what is REFUSED as about what works.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import express from 'express'
import { createAdminRouter } from '../src/admin'
import {
  createAdminAuth,
  describeAgent,
  hashPassword,
  verifyPassword,
  looksLikeHash,
} from '../src/adminAuth'
import { collectStatus } from '../src/adminStatus'
import { loadFiltersOnce } from '../src/filter'
import { createDb, migrateToLatest } from '../src/db'
import { Config } from '../src/config'

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'feedgen-adminauth-'))
const DB = path.join(TMP, 'db.sqlite')
const PASSWORD = 'correct horse battery staple'

// filter.ts captures FEEDGEN_FILTERS_PATH when the module loads, and an import
// is evaluated before anything in this file runs — so setting it here would be
// too late and the status section would read the LIVE config instead. It has to
// come from the environment: `yarn test:adminauth` sets it, same as test:pinned.
const FILTERS = process.env.FEEDGEN_FILTERS_PATH
if (!FILTERS) {
  console.error(
    'FEEDGEN_FILTERS_PATH must be set to a scratch path — run this as ' +
      '`yarn test:adminauth`, which points it at /tmp/adminauth-test-filters.json',
  )
  process.exit(1)
}

fs.writeFileSync(
  FILTERS,
  JSON.stringify({
    feeds: {
      abc: {
        displayName: 'Example',
        includePatterns: [{ pattern: 'coffee' }],
        retention: { type: 'hours', value: 72 },
        pinnedPost: 'at://did:plc:aaaaaaaaaaaaaaaaaaaaaaaa/app.bsky.feed.post/xyz',
      },
      def: {
        includeDids: ['did:plc:bbbbbbbbbbbbbbbbbbbbbbbb'],
        retention: { type: 'count', value: 500 },
      },
    },
  }),
)

let pass = 0
let total = 0
const check = (name: string, cond: boolean, detail = '') => {
  total++
  if (cond) pass++
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? `  [${detail}]` : ''}`)
}

type Res = { status: number; body: any; headers: Headers; text: string }

const mount = async (router: express.Router) => {
  const app = express()
  app.use('/admin', router)
  const server = app.listen(0, '127.0.0.1')
  await new Promise((r) => server.once('listening', r))
  const base = `http://127.0.0.1:${(server.address() as any).port}/admin`
  const call = async (
    p: string,
    init: { method?: string; body?: unknown; cookie?: string; origin?: string } = {},
  ): Promise<Res> => {
    const headers: Record<string, string> = {}
    if (init.body !== undefined) headers['content-type'] = 'application/json'
    if (init.cookie) headers['cookie'] = init.cookie
    if (init.origin) headers['origin'] = init.origin
    const r = await fetch(`${base}${p}`, {
      method: init.method ?? (init.body !== undefined ? 'POST' : 'GET'),
      headers,
      body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
    })
    const text = await r.text()
    let body: any = undefined
    try {
      body = JSON.parse(text)
    } catch {
      /* html */
    }
    return { status: r.status, body, headers: r.headers, text }
  }
  return { call, close: () => server.close() }
}

const cookieFrom = (res: Res): string => (res.headers.get('set-cookie') ?? '').split(';')[0]

const run = async () => {
  console.log('\n── hashing')
  const hash = await hashPassword(PASSWORD)
  check('a hash round-trips', await verifyPassword(PASSWORD, hash))
  check('a wrong password does not', !(await verifyPassword(PASSWORD + '!', hash)))
  check('the format is recognised', looksLikeHash(hash))
  check('junk is not a hash', !looksLikeHash('hunter2'))
  check('a truncated hash is not a hash', !looksLikeHash(hash.slice(0, hash.length - 20)))
  check(
    'a tampered hash fails closed, it does not throw',
    !(await verifyPassword(PASSWORD, 'scrypt$99999999999$8$1$AAAA$AAAA')),
  )
  check('two hashes of the same password differ (salted)', (await hashPassword(PASSWORD)) !== hash)

  console.log('\n── without auth the routes stay open (the loopback listener)')
  {
    const { call, close } = await mount(createAdminRouter())
    const r = await call('/filters')
    check('GET /filters needs no session', r.status === 200 && r.body.ok === true)
    close()
  }

  console.log('\n── with auth, everything but the page is refused')
  {
    // A generous failure budget here on purpose: this section deliberately
    // gets a lot of logins wrong, and the limiter has its own section below.
    // Sharing the default made an unrelated new check trip it.
    const auth = createAdminAuth({ passwordHash: hash, maxFailuresPerIp: 50 })
    const { call, close } = await mount(
      createAdminRouter({ auth, page: true, status: async () => ({ marker: true } as any) }),
    )

    const page = await call('/')
    check('the page itself is public — it IS the login form', page.status === 200)
    check('...and is HTML', page.text.startsWith('<!doctype html>'))
    check(
      'it cannot be framed',
      page.headers.get('x-frame-options') === 'DENY' &&
        (page.headers.get('content-security-policy') ?? '').includes("frame-ancestors 'none'"),
    )
    check('it is not cached', page.headers.get('cache-control') === 'no-store')

    // The UI is one inlined script, so a syntax error in it renders a blank
    // page while every check above still passes. Parsing it is the cheapest
    // way to notice, short of driving a browser.
    const script = page.text.split('<script>')[1]?.split('</script>')[0] ?? ''
    let parses = false
    try {
      new Function(script)
      parses = true
    } catch (err: any) {
      parses = false
      console.log(`      ${String(err?.message ?? err)}`)
    }
    check('the inlined script parses', parses && script.length > 500)
    check(
      'the login form carries a username field, or managers will not save the password',
      page.text.includes("autocomplete: 'username'") &&
        page.text.includes("autocomplete: 'current-password'"),
    )
    check(
      'the page tells the live cursor from one left by an endpoint switch',
      page.text.includes('s.service.subscriptionEndpoint'),
    )

    check('GET /filters is refused', (await call('/filters')).status === 401)
    check('GET /api/status is refused', (await call('/api/status')).status === 401)
    check(
      'POST /filters/validate is refused',
      (await call('/filters/validate', { body: { feeds: {} } })).status === 401,
    )
    check(
      'a made-up cookie is refused',
      (await call('/api/status', { cookie: 'feedgen_admin=notatoken' })).status === 401,
    )

    const wrong = await call('/api/login', { body: { user: 'admin', password: 'nope' } })
    check('a wrong password is refused', wrong.status === 401)
    check('...without saying which part was wrong',
      wrong.body.error === 'wrong username or password')
    check(
      'a missing password field does not crash the route',
      (await call('/api/login', { body: {} })).status === 401,
    )
    check(
      'a non-string password does not crash it either',
      (await call('/api/login', { body: { user: 'admin', password: { $ne: null } } })).status === 401,
    )

    check(
      'the account name is now checked, not decorative',
      (await call('/api/login', { body: { user: 'someone-else', password: PASSWORD } })).status === 401,
    )
    check(
      'a missing account name is refused too',
      (await call('/api/login', { body: { password: PASSWORD } })).status === 401,
    )

    const good = await call('/api/login', { body: { user: 'admin', password: PASSWORD } })
    check('the right password signs in', good.status === 200 && good.body.ok === true)
    const setCookie = good.headers.get('set-cookie') ?? ''
    check('the cookie is HttpOnly', setCookie.includes('HttpOnly'))
    check('the cookie is SameSite=Strict', setCookie.includes('SameSite=Strict'))
    check('the cookie is scoped to /admin', setCookie.includes('Path=/admin'))
    check(
      'the cookie is not marked Secure over plain HTTP, or the browser would drop it',
      !setCookie.includes('Secure'),
    )

    const cookie = cookieFrom(good)
    const authed = await call('/api/status', { cookie })
    check('the session unlocks the status', authed.status === 200 && authed.body.ok === true)
    check('...and returns the snapshot', authed.body.status?.marker === true)
    check('the session unlocks the config', (await call('/filters', { cookie })).status === 200)

    check(
      'a cross-origin POST is refused even with a valid session',
      (await call('/filters/validate', { cookie, body: {}, origin: 'https://evil.example' }))
        .status === 403,
    )
    check(
      'a cross-origin login is refused',
      (await call('/api/login', { body: { user: 'admin', password: PASSWORD }, origin: 'https://evil.example' }))
        .status === 403,
    )

    const out = await call('/api/logout', { cookie, body: {} })
    check('logging out succeeds', out.status === 200)
    check('...and the session is gone', (await call('/api/status', { cookie })).status === 401)
    check('...and the cookie is cleared', (out.headers.get('set-cookie') ?? '').includes('Max-Age=0'))
    close()
  }

  console.log('\n── rate limiting')
  {
    const auth = createAdminAuth({ passwordHash: hash, maxFailuresPerIp: 3 })
    const { call, close } = await mount(createAdminRouter({ auth }))
    const codes: number[] = []
    for (let i = 0; i < 5; i++) {
      codes.push((await call('/api/login', { body: { user: 'admin', password: 'nope' } })).status)
    }
    check('the first attempts are plain refusals', codes.slice(0, 3).every((c) => c === 401), codes.join(','))
    check('further attempts are rate limited', codes.slice(3).every((c) => c === 429))
    const locked = await call('/api/login', { body: { user: 'admin', password: PASSWORD } })
    check('...and the CORRECT password is locked out too', locked.status === 429)
    check('...with a Retry-After', Number(locked.headers.get('retry-after')) > 0)
    close()
  }

  console.log('\n── sessions expire')
  {
    // A second of slack, not milliseconds: an HTTP round trip through docker on
    // a Pi is easily 100 ms, and a tighter window fails on the machine speed
    // rather than on the behaviour under test.
    const auth = createAdminAuth({ passwordHash: hash, sessionIdleMs: 1000 })
    const { call, close } = await mount(createAdminRouter({ auth, status: async () => ({} as any) }))
    const cookie = cookieFrom(await call('/api/login', { body: { user: 'admin', password: PASSWORD } }))
    check('fresh session works', (await call('/api/status', { cookie })).status === 200)
    await new Promise((r) => setTimeout(r, 1300))
    check('an idle limit, when asked for, still drops an idle session',
      (await call('/api/status', { cookie })).status === 401)
    close()
  }
  {
    // The absolute lifetime is the one that matters now: kept busy, a session
    // must STILL end on time, or a stolen cookie in use would live forever.
    const auth = createAdminAuth({ passwordHash: hash, sessionTtlMs: 1500 })
    const { call, close } = await mount(createAdminRouter({ auth, status: async () => ({} as any) }))
    const cookie = cookieFrom(await call('/api/login', { body: { user: 'admin', password: PASSWORD } }))
    let busy = true
    for (let i = 0; i < 4; i++) {
      await new Promise((r) => setTimeout(r, 250))
      busy = busy && (await call('/api/status', { cookie })).status === 200
    }
    check('a session in constant use keeps working inside its lifetime', busy)
    await new Promise((r) => setTimeout(r, 1000))
    check('...and ends at its lifetime anyway — use does not extend it',
      (await call('/api/status', { cookie })).status === 401)
    close()
  }
  {
    const auth = createAdminAuth({ passwordHash: hash })
    const { call, close } = await mount(createAdminRouter({ auth, status: async () => ({} as any) }))
    const res = await call('/api/login', { body: { user: 'admin', password: PASSWORD } })
    check('by default a sign-in lasts 30 days',
      (res.headers.get('set-cookie') ?? '').includes(`Max-Age=${30 * 24 * 3600}`))
    close()
  }

  console.log('\n── sessions survive a restart, and nothing else')
  {
    const store = path.join(TMP, 'admin-sessions.json')
    const login = { user: 'admin', password: PASSWORD }
    const statusOnly = { status: async () => ({} as any) }

    const first = await mount(createAdminRouter({
      auth: createAdminAuth({ passwordHash: hash, sessionStore: store }), ...statusOnly,
    }))
    const signIn = await first.call('/api/login', { body: login })
    const cookie = cookieFrom(signIn)
    const token = cookie.split('=')[1]
    first.close()

    check('signing in writes the store', fs.existsSync(store))
    check('...readable by its owner only', (fs.statSync(store).mode & 0o777) === 0o600)
    const stored = fs.readFileSync(store, 'utf8')
    check('...and it holds no usable token, only a hash of one',
      token.length > 20 && !stored.includes(token))
    const saved = fs.readFileSync(store)

    const second = await mount(createAdminRouter({
      auth: createAdminAuth({ passwordHash: hash, sessionStore: store }), ...statusOnly,
    }))
    check('after a restart the same cookie still gets in',
      (await second.call('/api/status', { cookie })).status === 200)
    second.close()

    const otherHash = await hashPassword('a different password')
    fs.writeFileSync(store, saved)
    const third = await mount(createAdminRouter({
      auth: createAdminAuth({ passwordHash: otherHash, sessionStore: store }), ...statusOnly,
    }))
    check('a new password voids every stored session',
      (await third.call('/api/status', { cookie })).status === 401)
    third.close()
    const savedKey = Object.keys(JSON.parse(saved.toString()).sessions)[0]
    check('...and they are dropped from the file, not merely ignored',
      !!savedKey && !fs.readFileSync(store, 'utf8').includes(savedKey))

    fs.writeFileSync(store, saved)
    const fourth = await mount(createAdminRouter({
      auth: createAdminAuth({ passwordHash: hash, sessionStore: store, sessionBinding: 'NEWSECRET' }),
      ...statusOnly,
    }))
    check('so does a changed .env second factor',
      (await fourth.call('/api/status', { cookie })).status === 401)
    fourth.close()

    fs.writeFileSync(store, '{ this is not json')
    let survived = true
    let fifth: Awaited<ReturnType<typeof mount>> | undefined
    try {
      fifth = await mount(createAdminRouter({
        auth: createAdminAuth({ passwordHash: hash, sessionStore: store }), ...statusOnly,
      }))
    } catch {
      survived = false
    }
    check('a corrupt store does not stop the service starting', survived && !!fifth)
    check('...and signs nobody in', (await fifth!.call('/api/status', { cookie })).status === 401)
    check('...while a fresh sign-in still works',
      (await fifth!.call('/api/login', { body: login })).status === 200)
    fifth!.close()

    fs.writeFileSync(store, saved)
    const sixth = await mount(createAdminRouter({
      auth: createAdminAuth({ passwordHash: hash, sessionStore: store }), ...statusOnly,
    }))
    await sixth.call('/api/logout', { cookie, body: {} })
    const seventh = await mount(createAdminRouter({
      auth: createAdminAuth({ passwordHash: hash, sessionStore: store }), ...statusOnly,
    }))
    check('signing out is remembered across a restart too',
      (await seventh.call('/api/status', { cookie })).status === 401)
    sixth.close()
    seventh.close()
  }

  console.log('\n── the list of signed-in browsers')
  {
    const auth = createAdminAuth({ passwordHash: hash })
    const { call, close } = await mount(createAdminRouter({ auth, status: async () => ({} as any) }))
    const login = { user: 'admin', password: PASSWORD }
    check('a signed-out visitor cannot list sessions', (await call('/api/sessions')).status === 401)
    check('...or sign anyone out',
      (await call('/api/sessions/revoke-others', { body: {} })).status === 401)

    const mac = cookieFrom(await call('/api/login', { body: login }))
    const phone = cookieFrom(await call('/api/login', { body: login }))
    const tablet = cookieFrom(await call('/api/login', { body: login }))

    const list = await call('/api/sessions', { cookie: mac })
    check('every sign-in is listed', list.status === 200 && list.body.sessions.length === 3)
    check('...exactly one of them marked as this browser',
      list.body.sessions.filter((s: any) => s.current).length === 1)
    check('...with the lifetime stated', list.body.ttlDays === 30)
    check('...and not one token in the reply',
      [mac, phone, tablet].every((c) => !list.text.includes(c.split('=')[1])))

    const mine = list.body.sessions.find((s: any) => s.current)
    check('this browser cannot sign itself out from the list',
      (await call('/api/sessions/revoke', { cookie: mac, body: { id: mine.id } })).status === 400)

    const phoneId = (await call('/api/sessions', { cookie: phone })).body.sessions
      .find((s: any) => s.current).id
    const gone = await call('/api/sessions/revoke', { cookie: mac, body: { id: phoneId } })
    check('another browser can be signed out by its id', gone.status === 200)
    check('...and its cookie stops working', (await call('/api/status', { cookie: phone })).status === 401)
    check('...while this one carries on', (await call('/api/status', { cookie: mac })).status === 200)
    check('an unknown id is a 404, not a silent success',
      (await call('/api/sessions/revoke', { cookie: mac, body: { id: 'ffffffffffffffff' } })).status === 404)
    check('a partial id matches nothing',
      (await call('/api/sessions/revoke', { cookie: mac, body: { id: '' } })).status === 404)

    const rest = await call('/api/sessions/revoke-others', { cookie: mac, body: {} })
    check('"everywhere else" signs out the rest', rest.status === 200 && rest.body.revoked === 1)
    check('...the tablet is out', (await call('/api/status', { cookie: tablet })).status === 401)
    check('...and this browser is not', (await call('/api/status', { cookie: mac })).status === 200)
    check('a cross-origin sign-out is refused',
      (await call('/api/sessions/revoke-others', { cookie: mac, body: {}, origin: 'https://evil.example' }))
        .status === 403)
    close()

    check('browsers get a name a person recognises',
      describeAgent('Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1') === 'Safari on iPhone' &&
      describeAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36') === 'Chrome on macOS' &&
      describeAgent(undefined) === 'unknown browser')
  }

  console.log('\n── the status snapshot')
  {
    const db = createDb(DB)
    await migrateToLatest(db)
    loadFiltersOnce()
    const iso = (msAgo: number) => new Date(Date.now() - msAgo).toISOString()
    await db
      .insertInto('post')
      .values([
        { uri: 'at://x/app.bsky.feed.post/1', cid: 'c1', indexedAt: iso(7200_000), feed: 'abc' },
        { uri: 'at://x/app.bsky.feed.post/2', cid: 'c2', indexedAt: iso(60_000), feed: 'abc' },
        { uri: 'at://x/app.bsky.feed.post/3', cid: 'c3', indexedAt: iso(60_000), feed: 'ghost' },
      ])
      .execute()
    await db
      .insertInto('sub_state')
      .values({ service: 'wss://jetstream1.example', cursor: (Date.now() - 5000) * 1000 })
      .execute()

    const cfg = {
      port: 3000,
      listenhost: '0.0.0.0',
      hostname: 'feed.example.com',
      sqliteLocation: DB,
      subscriptionEndpoint: 'wss://jetstream1.example',
      serviceDid: 'did:plc:service',
      publisherDid: 'did:plc:publisher',
      subscriptionReconnectDelay: 3000,
    } as Config

    const s = await collectStatus(db, cfg, Date.now() - 90_000, false)
    const abc = s.feeds.find((f) => f.key === 'abc')
    const def = s.feeds.find((f) => f.key === 'def')
    const ghost = s.feeds.find((f) => f.key === 'ghost')

    check('every configured feed is listed', !!abc && !!def)
    check('post counts are per feed', abc?.rows === 2, String(abc?.rows))
    check('a configured feed with no posts still shows', def?.rows === 0)
    check('the config is reflected', abc?.retention?.value === 72 && abc?.includePatterns === 1)
    check('an author feed reports its DIDs', def?.includeDids === 1)
    check('a pinned post is reported as configured', abc?.pinnedPost !== null && def?.pinnedPost === null)
    check('oldest and newest bracket the rows', !!abc?.oldest && !!abc?.newest && abc!.oldest! < abc!.newest!)
    check('rows for a feed no longer configured are surfaced, not hidden', ghost?.routed === false)
    check('...and configured feeds are marked routed', abc?.routed === true)
    check('the cursor is decoded to a time', !!s.cursors[0]?.at)
    check('...and its lag is seconds, not microseconds', (s.cursors[0]?.lagSec ?? -1) < 60)
    check('the filters file is digested', (s.filters.sha256 ?? '').length === 12)
    check('the box reports which mode it is in', s.service.writable === false)
    check('process uptime is measured, not guessed', s.box.processUptimeSec >= 90)

    // The snapshot is served to a browser: it must not carry the password hash
    // or anything else from the environment that was not asked for.
    const dumped = JSON.stringify(s)
    check('the snapshot leaks no secret', !dumped.includes('scrypt$') && !dumped.includes('TUNNEL'))

    await db.destroy()
  }

  fs.rmSync(TMP, { recursive: true, force: true })
  fs.rmSync(FILTERS, { force: true })
  console.log(`\n${pass === total ? 'All' : `${pass} of`} ${total} checks passed`)
  process.exit(pass === total ? 0 : 1)
}

run().catch((err) => {
  console.error(err)
  process.exit(1)
})
