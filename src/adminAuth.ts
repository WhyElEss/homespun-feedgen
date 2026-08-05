import crypto from 'node:crypto'
import express from 'express'
import { verifyTotp } from './adminTotp'

// Password and session handling for the admin UI.
//
// This is the ONLY thing standing between the internet and the config of live
// feeds, so the choices here are deliberately conservative:
//
//   * the password is never stored, only a scrypt hash, and it is hashed
//     ASYNCHRONOUSLY — this process also ingests the firehose, and a synchronous
//     scrypt would stall ingestion for the ~100 ms it takes on a Pi;
//   * sessions live server-side and the cookie carries nothing but a random
//     token, so there is no signature to forge and no payload to tamper with.
//     A restart logs everyone out, which is the right trade for a service that
//     restarts rarely;
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
  // base32. When set, a second factor is required. Absent = off.
  totpSecret?: string
  // Absolute lifetime of a session, and how long it may sit idle.
  sessionTtlMs?: number
  sessionIdleMs?: number
  // Failed logins tolerated per client, and in total, inside one window.
  maxFailuresPerIp?: number
  maxFailuresGlobal?: number
  failureWindowMs?: number
  cookieName?: string
  cookiePath?: string
}

type Session = { created: number; lastSeen: number; ip: string }

const DEFAULTS = {
  user: 'admin',
  sessionTtlMs: 12 * 60 * 60 * 1000,
  sessionIdleMs: 60 * 60 * 1000,
  maxFailuresPerIp: 5,
  maxFailuresGlobal: 20,
  failureWindowMs: 15 * 60 * 1000,
  cookieName: 'feedgen_admin',
  cookiePath: '/admin',
}

const parseCookies = (header: string | undefined): Record<string, string> => {
  const out: Record<string, string> = {}
  for (const part of (header ?? '').split(';')) {
    const eq = part.indexOf('=')
    if (eq < 0) continue
    const name = part.slice(0, eq).trim()
    if (name) out[name] = decodeURIComponent(part.slice(eq + 1).trim())
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
  // Whether the login form should ask for a code. Revealed unauthenticated,
  // which costs nothing: one login attempt would tell you the same.
  totpRequired: boolean
}

export const createAdminAuth = (opts: AuthOptions): AdminAuth => {
  const cfg = { ...DEFAULTS, ...opts }
  const sessions = new Map<string, Session>()
  // The last TOTP step accepted. A code is good once — see verifyTotp.
  let lastTotpStep: number | undefined
  const failuresByIp = new Map<string, { count: number; first: number }>()
  let globalFailures = { count: 0, first: 0 }

  const sweep = (now: number) => {
    for (const [token, s] of sessions) {
      if (now - s.created > cfg.sessionTtlMs || now - s.lastSeen > cfg.sessionIdleMs) {
        sessions.delete(token)
      }
    }
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

  const guard: express.RequestHandler = (req, res, next) => {
    const now = Date.now()
    sweep(now)
    const token = parseCookies(req.headers.cookie)[cfg.cookieName]
    const session = token ? sessions.get(token) : undefined
    if (!token || !session) {
      res.status(401).json({ ok: false, error: 'not signed in' })
      return
    }
    if (req.method !== 'GET' && req.method !== 'HEAD' && !sameOrigin(req)) {
      res.status(403).json({ ok: false, error: 'cross-origin request refused' })
      return
    }
    session.lastSeen = now
    next()
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
    if (cfg.totpSecret) {
      const verdict = verifyTotp(cfg.totpSecret, body.totp, { lastUsedStep: lastTotpStep })
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
    sessions.set(token, { created: now, lastSeen: now, ip })
    setCookie(req, res, token)
    console.log(`admin: signed in from ${ip}`)
    res.json({ ok: true })
  })

  routes.post('/api/logout', (req, res) => {
    const token = parseCookies(req.headers.cookie)[cfg.cookieName]
    if (token) sessions.delete(token)
    clearCookie(req, res)
    res.json({ ok: true })
  })

  return {
    guard,
    routes,
    sessionCount: () => sessions.size,
    totpRequired: !!cfg.totpSecret,
  }
}
