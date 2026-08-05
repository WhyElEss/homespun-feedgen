// The second factor: the algorithm, and the login that uses it.
// Usage: yarn testAdminTotp
//
// TOTP is easy to implement in a way that looks right and is not — the window
// silently too wide, a code that works twice, a base32 decoder that drops the
// last byte. Each of those is a test here rather than a hope.
import express from 'express'
import {
  base32Decode,
  base32Encode,
  codeFor,
  verifyTotp,
  generateSecret,
  otpauthUri,
  looksLikeSecret,
  stepFor,
  totpConfig,
} from '../src/adminTotp'
import { createAdminAuth, hashPassword } from '../src/adminAuth'
import { createAdminRouter } from '../src/admin'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

let pass = 0
let total = 0
const check = (name: string, cond: boolean, detail = '') => {
  total++
  if (cond) pass++
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? `  [${detail}]` : ''}`)
}

const PASSWORD = 'correct horse battery staple'
const USER = 'yuri'

const run = async () => {
  console.log('\n── base32')
  check('round-trips', base32Encode(base32Decode('JBSWY3DPEHPK3PXP')) === 'JBSWY3DPEHPK3PXP')
  check('ignores spaces and case', base32Decode('jbsw y3dp').length === base32Decode('JBSWY3DP').length)
  check('rejects other alphabets', (() => {
    try { base32Decode('0189!'); return false } catch { return true }
  })())

  console.log('\n── RFC 6238 vectors (SHA1, the shared secret "12345678901234567890")')
  // The seed from the RFC, base32-encoded. Its codes at the published times are
  // fixed, so this catches an implementation that is merely self-consistent.
  const SEED = base32Encode(Buffer.from('12345678901234567890'))
  check('at 59s → 287082', codeFor(SEED, 59_000) === '287082', codeFor(SEED, 59_000))
  check('at 1111111109s → 081804', codeFor(SEED, 1_111_111_109_000) === '081804', codeFor(SEED, 1_111_111_109_000))
  check('at 1234567890s → 005924', codeFor(SEED, 1_234_567_890_000) === '005924', codeFor(SEED, 1_234_567_890_000))

  console.log('\n── verification window')
  const secret = generateSecret()
  const now = Date.now()
  check('the current code is accepted', verifyTotp(secret, codeFor(secret, now), { atMs: now }).ok)
  check('one step early is accepted', verifyTotp(secret, codeFor(secret, now - 30_000), { atMs: now }).ok)
  check('one step late is accepted', verifyTotp(secret, codeFor(secret, now + 30_000), { atMs: now }).ok)
  check('two steps out is REFUSED', !verifyTotp(secret, codeFor(secret, now - 60_000), { atMs: now }).ok)
  check('a wrong code is refused', !verifyTotp(secret, '000000', { atMs: now }).ok)
  check('a non-numeric code is refused', !verifyTotp(secret, 'abcdef', { atMs: now }).ok)
  check('a short code is refused', !verifyTotp(secret, '12345', { atMs: now }).ok)
  check("another secret's code is refused",
    !verifyTotp(secret, codeFor(generateSecret(), now), { atMs: now }).ok)

  console.log('\n── a code is good ONCE')
  const step = stepFor(now)
  const code = codeFor(secret, now)
  check('accepted the first time', verifyTotp(secret, code, { atMs: now, lastUsedStep: step - 1 }).ok)
  const again = verifyTotp(secret, code, { atMs: now, lastUsedStep: step })
  check('refused the second time', !again.ok)
  check('...and says why', again.replay === true)

  console.log('\n── the enrolment URI')
  const uri = otpauthUri(secret, 'yuri', 'feed.example.com')
  check('is an otpauth URI', uri.indexOf('otpauth://totp/') === 0)
  check('carries the secret', uri.indexOf('secret=' + secret) > 0)
  check('pins the parameters', uri.indexOf('digits=6') > 0 && uri.indexOf('period=30') > 0)
  check('a real secret passes the startup check', looksLikeSecret(secret))
  check('a short one does not', !looksLikeSecret('AAAA'))
  check('junk does not', !looksLikeSecret('not base32!'))

  console.log('\n── logging in')
  const mount = async (totpSecret?: string) => {
    const auth = createAdminAuth({
      passwordHash: await hashPassword(PASSWORD),
      user: USER,
      // The config is read per login now, so the test hands over a fixed one
      // rather than a bare string.
      totp: () =>
        totpSecret
          ? { secret: totpSecret, source: 'env' as const, broken: false }
          : { source: null, broken: false },
    })
    const app = express()
    app.use('/admin', createAdminRouter({ auth }))
    const server = app.listen(0, '127.0.0.1')
    await new Promise((r) => server.once('listening', r))
    const base = `http://127.0.0.1:${(server.address() as any).port}/admin`
    const post = async (path: string, body: unknown) => {
      const r = await fetch(`${base}${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      })
      return { status: r.status, body: (await r.json()) as any }
    }
    const get = async (path: string) => {
      const r = await fetch(`${base}${path}`)
      return { status: r.status, body: (await r.json()) as any }
    }
    return { post, get, close: () => server.close() }
  }

  {
    const { post, get, close } = await mount()
    check('without a secret the form is told not to ask',
      (await get('/api/login-meta')).body.totpRequired === false)
    check('the right user and password get in',
      (await post('/api/login', { user: USER, password: PASSWORD })).status === 200)
    const wrongUser = await post('/api/login', { user: 'admin', password: PASSWORD })
    check('a wrong username is refused', wrongUser.status === 401)
    check('...with the same wording as a wrong password',
      wrongUser.body.error === (await post('/api/login', { user: USER, password: 'nope' })).body.error,
      wrongUser.body.error)
    close()
  }

  {
    const s2 = generateSecret()
    const { post, get, close } = await mount(s2)
    check('with a secret the form is told to ask',
      (await get('/api/login-meta')).body.totpRequired === true)

    const noCode = await post('/api/login', { user: USER, password: PASSWORD })
    check('password alone is not enough', noCode.status === 401)
    check('...and the form is told to show the field', noCode.body.needsTotp === true)

    check('a wrong code is refused',
      (await post('/api/login', { user: USER, password: PASSWORD, totp: '000000' })).status === 401)

    // The order that matters: a wrong password must never reveal anything
    // about the code, so it fails as a password, not as a code.
    const badPass = await post('/api/login', { user: USER, password: 'nope', totp: codeFor(s2) })
    check('a wrong password fails before the code is looked at', badPass.body.needsTotp === undefined)

    const good = await post('/api/login', { user: USER, password: PASSWORD, totp: codeFor(s2) })
    check('the right code gets in', good.status === 200, JSON.stringify(good.body).slice(0, 60))
    check('...and issues a session', (good.body.ok === true))

    const replay = await post('/api/login', { user: USER, password: PASSWORD, totp: codeFor(s2) })
    check('the same code cannot be used again', replay.status === 401)
    check('...saying so plainly', String(replay.body.error).includes('already been used'))
    close()
  }

  console.log('\n── enrolling from the UI')
  {
    // The store lives under FEEDGEN_DATA_DIR, so a scratch dir keeps this out
    // of the real one.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'feedgen-totp-'))
    process.env.FEEDGEN_DATA_DIR = dir
    delete process.env.FEEDGEN_ADMIN_TOTP_SECRET

    const auth = createAdminAuth({
      passwordHash: await hashPassword(PASSWORD),
      user: USER,
      totp: totpConfig,
      maxFailuresPerIp: 50,
    })
    const app = express()
    app.use('/admin', createAdminRouter({
      auth,
      identity: { publisherDid: 'did:plc:p', serviceDid: 'did:plc:s',
                  hostname: 'feed.example.com', subscriptionEndpoint: 'wss://x' },
    }))
    const server = app.listen(0, '127.0.0.1')
    await new Promise((r) => server.once('listening', r))
    const url = `http://127.0.0.1:${(server.address() as any).port}/admin`

    const login = await fetch(`${url}/api/login`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ user: USER, password: PASSWORD }),
    })
    const cookie = (login.headers.get('set-cookie') ?? '').split(';')[0]
    const call = async (p: string, body?: unknown) => {
      const r = await fetch(`${url}${p}`, {
        method: body === undefined ? 'GET' : 'POST',
        headers: body === undefined
          ? { cookie }
          : { cookie, 'content-type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
      })
      return { status: r.status, body: (await r.json()) as any }
    }

    check('a signed-out visitor cannot start enrolment', (await (async () => {
      const r = await fetch(`${url}/totp/begin`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
      })
      return r.status
    })()) === 401)

    check('it starts off', (await call('/totp/status')).body.enabled === false)
    const begun = await call('/totp/begin', {})
    check('begin hands back a secret and a URI',
      begun.status === 200 && looksLikeSecret(begun.body.secret) &&
        begun.body.uri.indexOf('otpauth://') === 0)
    check('...but has NOT enabled anything yet',
      (await call('/totp/status')).body.enabled === false)
    check('...and nothing is on disk', !fs.existsSync(path.join(dir, 'admin-totp.json')))

    // The bug that shipped first: pressing the button again handed back a NEW
    // secret, so the one just saved in a password manager was already dead.
    const again2 = await call('/totp/begin', {})
    check('pressing set-up again returns the SAME secret',
      again2.body.secret === begun.body.secret)
    check('...and says how long it stays valid', again2.body.expiresInSec > 0)

    const wrong = await call('/totp/enable', { code: '000000' })
    check('a wrong code does not enable it', wrong.status === 400)
    check('...and says a clock problem is the likely cause',
      String(wrong.body.error).includes('time'))
    check('...leaving it off', (await call('/totp/status')).body.enabled === false)

    const enabled = await call('/totp/enable', { code: codeFor(begun.body.secret) })
    check('the right code enables it', enabled.status === 200)
    const st = await call('/totp/status')
    check('...status agrees', st.body.enabled === true && st.body.source === 'file')
    check('...and the file is written 0600',
      (fs.statSync(path.join(dir, 'admin-totp.json')).mode & 0o777) === 0o600)
    check('...so the login form is told to ask now',
      ((await (await fetch(`${url}/api/login-meta`)).json()) as any).totpRequired === true)

    check('turning it off needs the password',
      (await call('/totp/disable', { code: codeFor(begun.body.secret) })).status === 401)
    check('...and a valid code',
      (await call('/totp/disable', { password: PASSWORD, code: '000000' })).status === 401)
    check('...it is still on', (await call('/totp/status')).body.enabled === true)

    // A fresh step, because the code used to enable it is now spent for login —
    // and because reusing it here would test nothing about disabling.
    const offRes = await call('/totp/disable', {
      password: PASSWORD, code: codeFor(begun.body.secret),
    })
    check('with both it turns off', offRes.status === 200)
    check('...the file is gone', !fs.existsSync(path.join(dir, 'admin-totp.json')))

    console.log('\n── a secret that goes bad refuses logins rather than dropping a factor')
    fs.writeFileSync(path.join(dir, 'admin-totp.json'), 'not json at all')
    const brokenStatus = await call('/totp/status')
    check('status calls it broken', brokenStatus.body.broken === true)
    const brokenLogin = await fetch(`${url}/api/login`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ user: USER, password: PASSWORD }),
    })
    check('the correct password is refused', brokenLogin.status === 401)
    check('...naming the file to delete',
      String(((await brokenLogin.json()) as any).error).includes('admin-totp.json'))

    server.close()
    fs.rmSync(dir, { recursive: true, force: true })
    delete process.env.FEEDGEN_DATA_DIR
  }

  console.log(`\n${pass === total ? 'All' : `${pass} of`} ${total} checks passed`)
  process.exit(pass === total ? 0 : 1)
}

run().catch((err) => {
  console.error(err)
  process.exit(1)
})
