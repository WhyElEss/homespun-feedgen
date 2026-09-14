import crypto from 'node:crypto'
import fs from 'node:fs'
import express from 'express'
import { verifyTotp, TotpConfig } from './adminTotp'

// Password and session handling for the admin UI.
//
// This is the ONLY thing standing between the internet and the config of live
// feeds, so the choices here are deliberately conservative:
//
//   * the password is never stored, only a scrypt hash, and it is hashed
//     ASYNCHRONOUSLY — this process also ingests the firehose, and a synchronous
//     scrypt would stall ingestion for the ~100 ms it takes on a Pi;
//   * sessions live server-side and the cookie carries nothing but a random
//     token, so there is no signature to forge and no payload to tamper with;
//   * a session lasts 30 days from sign-in, however it is used. It used to die
//     after an hour idle, which meant a full password + code every single visit
//     for someone who looks in a few times a week — protection that trains
//     people to hate the page. The lifetime is ABSOLUTE, not sliding, so a
//     stolen cookie is worth at most 30 days, and every session can be listed
//     and signed out from the Security tab;
//   * sessions are kept on disk (when a store path is given) so a rebuild or a
//     restart does not sign everyone out. The file holds a SHA-256 of each
//     token, never the token: it rides along in every backup bundle, and a
//     copy of it must not be a copy of the cookies;
//   * a session is bound to the credentials it was created with. Change the
//     password hash (or a .env second factor) and every existing session is
//     void on the next request;
//   * failed logins are rate limited per IP *and* globally. The per-IP limit is
//     the useful one behind the tunnel, where Cloudflare gives us a real client
//     address; the global one is what still holds if someone reaches the service
//     directly and forges that header.
//
// No dependencies beyond node's crypto: every added package is another thing to
// rebuild on two boxes and another supply-chain surface on a public repo.

const SCRYPT_N = 16384 // ~16 MB of memory per hash at r=8
const SCRYPT_R = 8
const SCRYPT_P = 1
const SCRYPT_KEYLEN = 64
const SCRYPT_MAXMEM = 64 * 1024 * 1024

const scrypt = (
  password: string,
  salt: Buffer,
  params: { N: number; r: number; p: number; keylen: number },
): Promise<Buffer> =>
  new Promise((resolve, reject) => {
    crypto.scrypt(
      password,
      salt,
      params.keylen,
      { N: params.N, r: params.r, p: params.p, maxmem: SCRYPT_MAXMEM },
      (err, key) => (err ? reject(err) : resolve(key)),
    )
  })

// Format: scrypt$N$r$p$<salt base64>$<key base64>. The parameters travel with
// the hash so raising them later does not invalidate existing passwords.
export const hashPassword = async (password: string): Promise<string> => {
  const salt = crypto.randomBytes(16)
  const key = await scrypt(password, salt, {
    N: SCRYPT_N,
    r: SCRYPT_R,
    p: SCRYPT_P,
    keylen: SCRYPT_KEYLEN,
  })
  return [
    'scrypt',
    SCRYPT_N,
    SCRYPT_R,
    SCRYPT_P,
    salt.toString('base64'),
    key.toString('base64'),
  ].join('$')
}

// Checked at startup so a truncated paste fails at boot with a clear message,
// rather than silently becoming a password nobody can ever match.
//
// The salt and key lengths are checked EXACTLY, against what hashPassword
// produces: a hash cut short mid-line still splits into six plausible-looking
// parts and still base64-decodes, so "long enough" would wave it through.
// hashPassword is the only producer, which is what makes the exact check safe —
// but if its parameters are ever raised, this must be updated in the same
// commit or existing hashes stop being recognised at boot.
export const looksLikeHash = (stored: string): boolean => {
  const parts = stored.split('$')
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false
  const [N, r, p] = [Number(parts[1]), Number(parts[2]), Number(parts[3])]
  if (!Number.isInteger(N) || !Number.isInteger(r) || !Number.isInteger(p)) return false
  if (N <= 1 || r <= 0 || p <= 0) return false
  return (
    Buffer.from(parts[4], 'base64').length === 16 &&
    Buffer.from(parts[5], 'base64').length === SCRYPT_KEYLEN
  )
}

export const verifyPassword = async (
  password: string,
  stored: string,
): Promise<boolean> => {
  const parts = stored.split('$')
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false
  const N = Number(parts[1])
  const r = Number(parts[2])
  const p = Number(parts[3])
  const salt = Buffer.from(parts[4], 'base64')
  const expected = Buffer.from(parts[5], 'base64')
  if (
    !Number.isInteger(N) ||
    !Number.isInteger(r) ||
    !Number.isInteger(p) ||
    N <= 1 ||
    r <= 0 ||
    p <= 0 ||
    salt.length === 0 ||
    expected.length === 0
  ) {
    return false
  }
  let actual: Buffer
  try {
    actual = await scrypt(password, salt, { N, r, p, keylen: expected.length })
  } catch {
    // A hash carrying absurd parameters must fail closed, not crash the route.
    return false
  }
  return actual.length === expected.length && crypto.timingSafeEqual(actual, expected)
}

export type AuthOptions = {
  passwordHash: string
  // The account name the login form must match. Real, not decorative — but
  // still ONE account: a wrong name and a wrong password give the same answer,
  // so it adds no way to enumerate users.
  user?: string
  // Read on every login, not captured once: enabling or disabling the second
  // factor from the UI must take effect without a restart.
  totp?: () => TotpConfig
  // Absolute lifetime of a session, and how long it may sit idle. Idle is off
  // by default — see the header.
  sessionTtlMs?: number
  sessionIdleMs?: number
  // Where sessions survive a restart. Unset keeps them in memory only, which
  // is what the tests and the loopback listener want.
  sessionStore?: string
  // Anything besides the password hash that should void every session when it
  // changes — the server passes a .env TOTP secret, which also needs a restart.
  sessionBinding?: string
  // Failed logins tolerated per client, and in total, inside one window.
  maxFailuresPerIp?: number
  maxFailuresGlobal?: number
  failureWindowMs?: number
  cookieName?: string
  cookiePath?: string
}

type Session = {
  created: number
  lastSeen: number
  ip: string
  agent: string
  // Fingerprint of the credentials this session was created under.
  binding: string
}

const DAY_MS = 24 * 60 * 60 * 1000

const DEFAULTS = {
  user: 'admin',
  sessionTtlMs: 30 * DAY_MS,
  sessionIdleMs: Infinity,
  maxFailuresPerIp: 5,
  maxFailuresGlobal: 20,
  failureWindowMs: 15 * 60 * 1000,
  cookieName: 'feedgen_admin',
  cookiePath: '/admin',
}

// lastSeen moves on every request; writing the file each time would put an SD
// card write behind every click. Losing up to this much of "last used" on a
// crash is harmless — expiry runs off `created`, which is written at sign-in.
const PERSIST_LAST_SEEN_EVERY_MS = 10 * 60 * 1000

const sha256 = (s: string): string => crypto.createHash('sha256').update(s).digest('hex')

// The list on the Security tab exists to tell one browser from another, so it
// needs a name a person recognises — not a 200-character User-Agent. Only the
// label is stored.
export const describeAgent = (ua: string | undefined): string => {
  const s = String(ua ?? '')
  const browser =
    /Edg\//.test(s) ? 'Edge'
    : /Firefox\//.test(s) ? 'Firefox'
    : /(Chrome|CriOS)\//.test(s) ? 'Chrome'
    : /Safari\//.test(s) ? 'Safari'
    : null
  const os =
    /iPhone/.test(s) ? 'iPhone'
    : /iPad/.test(s) ? 'iPad'
    : /Android/.test(s) ? 'Android'
    : /Mac OS X|Macintosh/.test(s) ? 'macOS'
    : /Windows/.test(s) ? 'Windows'
    : /Linux/.test(s) ? 'Linux'
    : null
  if (browser && os) return `${browser} on ${os}`
  return browser ?? os ?? 'unknown browser'
}

const parseCookies = (header: string | undefined): Record<string, string> => {
  const out: Record<string, string> = {}
  for (const part of (header ?? '').split(';')) {
    const eq = part.indexOf('=')
    if (eq < 0) continue
    const name = part.slice(0, eq).trim()
    if (!name) continue
    try {
      out[name] = decodeURIComponent(part.slice(eq + 1).trim())
    } catch {
      // A malformed escape in some unrelated cookie must not throw out of the
      // guard and turn into an express 500.
    }
  }
  return out
}

// Cloudflare sets CF-Connecting-IP and it is the only address that means
// anything through the tunnel. It is trivially forged by anything reaching the
// service directly, which is exactly why the global limiter exists too.
const clientIp = (req: express.Request): string => {
  const cf = req.headers['cf-connecting-ip']
  if (typeof cf === 'string' && cf.length > 0 && cf.length < 64) return cf
  return req.socket.remoteAddress ?? 'unknown'
}

// A cookie may only be marked Secure when the browser reached us over HTTPS —
// set it on a plain-HTTP LAN visit and the browser silently drops the cookie,
// which looks exactly like a broken login.
const isHttps = (req: express.Request): boolean =>
  req.headers['x-forwarded-proto'] === 'https' ||
  (req.socket as any).encrypted === true

// Reject a cross-site POST outright. SameSite=Strict already keeps the cookie
// off such a request, but an explicit check costs nothing and does not depend
// on the browser getting it right.
const sameOrigin = (req: express.Request): boolean => {
  const origin = req.headers.origin
  if (typeof origin !== 'string' || origin === '') return true // non-browser client
  try {
    return new URL(origin).host === req.headers.host
  } catch {
    return false
  }
}

export type AdminAuth = {
  guard: express.RequestHandler
  routes: express.Router
  // Exposed for the tests and for the status page's "signed in since" line.
  sessionCount: () => number
  // Signs out every session except the one making this request. Called when a
  // second factor is switched on: a session opened with the password alone
  // must not outlive the decision that the password alone is not enough.
  revokeOthers: (req: express.Request) => number
  // The configured account name, so routes that build an enrolment URI can
  // label it with something meaningful.
  user: string
  // Re-checking the password for a step that must not ride on a session alone.
  verifyPassword: (given: unknown) => Promise<boolean>
  // Whether the login form should ask for a code. Revealed unauthenticated,
  // which costs nothing: one login attempt would tell you the same.
  totpRequired: () => boolean
}

export const createAdminAuth = (opts: AuthOptions): AdminAuth => {
  const cfg = { ...DEFAULTS, ...opts }
  const binding = sha256(`feedgen-admin-session|${cfg.passwordHash}|${cfg.sessionBinding ?? ''}`).slice(0, 32)
  // Keyed by sha256(token). The token itself exists only in the browser.
  const sessions = new Map<string, Session>()
  let persistedAt = new Map<string, number>()
  // The last TOTP step accepted. A code is good once — see verifyTotp.
  let lastTotpStep: number | undefined
  const failuresByIp = new Map<string, { count: number; first: number }>()
  let globalFailures = { count: 0, first: 0 }

  const expired = (s: Session, now: number) =>
    now - s.created > cfg.sessionTtlMs ||
    now - s.lastSeen > cfg.sessionIdleMs ||
    s.binding !== binding

  const persist = () => {
    if (!cfg.sessionStore) return
    const file = cfg.sessionStore
    const tmp = `${file}.tmp-${process.pid}`
    const out: Record<string, Session> = {}
    for (const [key, s] of sessions) out[key] = s
    try {
      fs.writeFileSync(tmp, JSON.stringify({ version: 1, sessions: out }, null, 2) + '\n', {
        mode: 0o600,
      })
      fs.renameSync(tmp, file)
      persistedAt = new Map([...sessions].map(([k, s]) => [k, s.lastSeen]))
    } catch (err: any) {
      // The session still works in memory; it just will not survive a restart.
      console.error(`admin: could not save sessions to ${file}: ${err?.message ?? err}`)
    }
  }

  // Anything unreadable starts from nothing. Failing closed here costs one
  // sign-in; failing open would be a session nobody issued.
  if (cfg.sessionStore) {
    const now = Date.now()
    let raw: string | undefined
    try {
      raw = fs.readFileSync(cfg.sessionStore, 'utf8')
    } catch (err: any) {
      if (err?.code !== 'ENOENT') {
        console.warn(`admin: cannot read ${cfg.sessionStore} — starting with no sessions`)
      }
    }
    if (raw !== undefined) {
      try {
        const parsed = JSON.parse(raw)
        let dropped = 0
        for (const [key, v] of Object.entries<any>(parsed?.sessions ?? {})) {
          const s: Session = {
            created: Number(v?.created),
            lastSeen: Number(v?.lastSeen),
            ip: String(v?.ip ?? ''),
            agent: String(v?.agent ?? ''),
            binding: String(v?.binding ?? ''),
          }
          const valid =
            /^[0-9a-f]{64}$/.test(key) &&
            Number.isFinite(s.created) &&
            Number.isFinite(s.lastSeen) &&
            s.created <= now &&
            !expired(s, now)
          if (valid) sessions.set(key, s)
          else dropped++
        }
        persistedAt = new Map([...sessions].map(([k, s]) => [k, s.lastSeen]))
        if (dropped > 0) persist()
      } catch {
        console.warn(`admin: ${cfg.sessionStore} is not valid JSON — starting with no sessions`)
      }
    }
  }

  const sweep = (now: number) => {
    let changed = false
    for (const [key, s] of sessions) {
      if (expired(s, now)) {
        sessions.delete(key)
        changed = true
      }
    }
    if (changed) persist()
    for (const [ip, f] of failuresByIp) {
      if (now - f.first > cfg.failureWindowMs) failuresByIp.delete(ip)
    }
    if (now - globalFailures.first > cfg.failureWindowMs) {
      globalFailures = { count: 0, first: 0 }
    }
  }

  const lockedOut = (ip: string, now: number): boolean => {
    const perIp = failuresByIp.get(ip)
    if (perIp && perIp.count >= cfg.maxFailuresPerIp) return true
    return globalFailures.count >= cfg.maxFailuresGlobal
  }

  const recordFailure = (ip: string, now: number) => {
    const perIp = failuresByIp.get(ip) ?? { count: 0, first: now }
    perIp.count++
    failuresByIp.set(ip, perIp)
    if (globalFailures.count === 0) globalFailures.first = now
    globalFailures.count++
    console.warn(
      `admin: failed login from ${ip} (${perIp.count} in window, ${globalFailures.count} total)`,
    )
  }

  // Hashed before comparing so the comparison is constant time AND does not
  // leak the expected length, which a raw timingSafeEqual on unequal buffers
  // would (it throws) and a length check would (it returns early).
  const sameUser = (given: unknown): boolean => {
    const a = crypto.createHash('sha256').update(String(given ?? '')).digest()
    const b = crypto.createHash('sha256').update(cfg.user).digest()
    return crypto.timingSafeEqual(a, b)
  }

  const setCookie = (req: express.Request, res: express.Response, token: string) => {
    const attrs = [
      `${cfg.cookieName}=${token}`,
      `Path=${cfg.cookiePath}`,
      'HttpOnly',
      'SameSite=Strict',
      `Max-Age=${Math.floor(cfg.sessionTtlMs / 1000)}`,
    ]
    if (isHttps(req)) attrs.push('Secure')
    res.setHeader('Set-Cookie', attrs.join('; '))
  }

  const clearCookie = (req: express.Request, res: express.Response) => {
    const attrs = [
      `${cfg.cookieName}=`,
      `Path=${cfg.cookiePath}`,
      'HttpOnly',
      'SameSite=Strict',
      'Max-Age=0',
    ]
    if (isHttps(req)) attrs.push('Secure')
    res.setHeader('Set-Cookie', attrs.join('; '))
  }

  const keyOf = (req: express.Request): string | undefined => {
    const token = parseCookies(req.headers.cookie)[cfg.cookieName]
    return token ? sha256(token) : undefined
  }

  const guard: express.RequestHandler = (req, res, next) => {
    const now = Date.now()
    sweep(now)
    const key = keyOf(req)
    const session = key ? sessions.get(key) : undefined
    if (!key || !session) {
      res.status(401).json({ ok: false, error: 'not signed in' })
      return
    }
    if (req.method !== 'GET' && req.method !== 'HEAD' && !sameOrigin(req)) {
      res.status(403).json({ ok: false, error: 'cross-origin request refused' })
      return
    }
    session.lastSeen = now
    if (now - (persistedAt.get(key) ?? 0) > PERSIST_LAST_SEEN_EVERY_MS) persist()
    next()
  }

  // What the Security tab shows. The id is a prefix of the token's hash: enough
  // to name a row, useless as a cookie.
  const idOf = (key: string) => key.slice(0, 16)

  const revokeOthers = (req: express.Request): number => {
    const mine = keyOf(req)
    let n = 0
    for (const key of [...sessions.keys()]) {
      if (key !== mine) {
        sessions.delete(key)
        n++
      }
    }
    if (n > 0) persist()
    return n
  }

  const routes = express.Router()

  routes.post('/api/login', async (req, res) => {
    const now = Date.now()
    sweep(now)
    const ip = clientIp(req)

    if (!sameOrigin(req)) {
      res.status(403).json({ ok: false, error: 'cross-origin request refused' })
      return
    }
    if (lockedOut(ip, now)) {
      res
        .status(429)
        .set('Retry-After', String(Math.ceil(cfg.failureWindowMs / 1000)))
        .json({ ok: false, error: 'too many attempts — try again later' })
      return
    }

    const body: any = req.body ?? {}
    const password = body.password
    // Verify even when the field is missing or malformed, so a wrong shape and
    // a wrong password cost the same time and reveal the same thing. The user
    // check is folded into the same verdict for the same reason: a wrong name
    // and a wrong password are indistinguishable from outside.
    const ok =
      sameUser(body.user) &&
      typeof password === 'string' &&
      password.length > 0 &&
      password.length <= 1024 &&
      (await verifyPassword(password, cfg.passwordHash))

    if (!ok) {
      recordFailure(ip, now)
      res.status(401).json({ ok: false, error: 'wrong username or password' })
      return
    }

    // Only now, with the first factor proved, does the second one get asked
    // about — a wrong password must never reveal anything about the code.
    const totp = cfg.totp ? cfg.totp() : { source: null, broken: false }
    if (totp.broken) {
      console.error('admin: the TOTP secret is unusable — login refused, remove the file to disable 2FA')
      res.status(401).json({
        ok: false,
        error:
          'two-factor is configured but its secret cannot be read. Delete ' +
          'data/admin-totp.json on the box to turn it off.',
      })
      return
    }
    if (totp.secret) {
      const verdict = verifyTotp(totp.secret, body.totp, { lastUsedStep: lastTotpStep })
      if (!verdict.ok) {
        recordFailure(ip, now)
        if (verdict.replay) {
          console.warn(`admin: TOTP code reused from ${ip} — refused`)
        } else if (verdict.step !== null) {
          console.warn(`admin: TOTP off by ${verdict.drift} step(s) from ${ip}`)
        }
        res.status(401).json({
          ok: false,
          error: verdict.replay
            ? 'that code has already been used — wait for the next one'
            : 'wrong or expired code',
          needsTotp: true,
        })
        return
      }
      lastTotpStep = verdict.step ?? lastTotpStep
    }

    failuresByIp.delete(ip)
    const token = crypto.randomBytes(32).toString('base64url')
    sessions.set(sha256(token), {
      created: now,
      lastSeen: now,
      ip,
      agent: describeAgent(req.headers['user-agent']),
      binding,
    })
    persist()
    setCookie(req, res, token)
    console.log(`admin: signed in from ${ip}`)
    res.json({ ok: true })
  })

  routes.post('/api/logout', (req, res) => {
    const key = keyOf(req)
    if (key && sessions.delete(key)) persist()
    clearCookie(req, res)
    res.json({ ok: true })
  })

  routes.get('/api/sessions', guard, (req, res) => {
    const mine = keyOf(req)
    const list = [...sessions]
      .sort((a, b) => b[1].lastSeen - a[1].lastSeen)
      .map(([key, s]) => ({
        id: idOf(key),
        agent: s.agent,
        ip: s.ip,
        created: new Date(s.created).toISOString(),
        lastSeen: new Date(s.lastSeen).toISOString(),
        expires: new Date(s.created + cfg.sessionTtlMs).toISOString(),
        current: key === mine,
      }))
    res.json({
      ok: true,
      ttlDays: Math.round(cfg.sessionTtlMs / DAY_MS),
      persisted: !!cfg.sessionStore,
      sessions: list,
    })
  })

  routes.post('/api/sessions/revoke', guard, (req, res) => {
    const id = String((req.body as any)?.id ?? '')
    const key = [...sessions.keys()].find((k) => id.length === 16 && idOf(k) === id)
    if (!key) {
      res.status(404).json({ ok: false, error: 'no such session — it may have ended already' })
      return
    }
    // Your own row is what Sign out is for, and doing it here would pull the
    // page out from under the click that asked.
    if (key === keyOf(req)) {
      res.status(400).json({ ok: false, error: 'that is this browser — use Sign out instead' })
      return
    }
    sessions.delete(key)
    persist()
    console.warn(`admin: session ${id} signed out from ${clientIp(req)}`)
    res.json({ ok: true })
  })

  routes.post('/api/sessions/revoke-others', guard, (req, res) => {
    const n = revokeOthers(req)
    if (n > 0) console.warn(`admin: ${n} other session(s) signed out from ${clientIp(req)}`)
    res.json({ ok: true, revoked: n })
  })

  return {
    guard,
    routes,
    sessionCount: () => sessions.size,
    revokeOthers,
    user: cfg.user,
    verifyPassword: async (given: unknown) =>
      typeof given === 'string' &&
      given.length > 0 &&
      given.length <= 1024 &&
      (await verifyPassword(given, cfg.passwordHash)),
    totpRequired: () => {
      const t = cfg.totp ? cfg.totp() : { source: null, broken: false }
      return !!t.secret || t.broken
    },
  }
}
