import crypto from 'node:crypto'

// TOTP (RFC 6238) for the admin login — the same thing an authenticator app
// does, in about eighty lines and with no dependency: HMAC-SHA1 and a base32
// decoder are all it takes, and node has the first one.
//
// What it buys: a stolen password stops being enough. The admin page sits on a
// public hostname and edits live feeds, so that is worth having.
//
// What it costs, and the reason this is optional: TOTP needs the server clock
// to be roughly right. Homebridge warns about exactly this. The escape hatch
// here is better than most — delete FEEDGEN_ADMIN_TOTP_SECRET from .env and
// restart, and the second factor is gone — but it still means a lockout is
// possible from a machine you cannot reach.

const STEP_SECONDS = 30
const DIGITS = 6
// One step either side: ±30 s of clock skew between server and phone. Wider
// windows are how TOTP quietly stops being a second factor.
const WINDOW = 1

const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'

export const base32Decode = (input: string): Buffer => {
  const clean = String(input ?? '')
    .toUpperCase()
    .replace(/[\s-]/g, '')
    .replace(/=+$/, '')
  if (!clean.length || /[^A-Z2-7]/.test(clean)) {
    throw new Error('not a base32 secret (A–Z and 2–7 only)')
  }
  let bits = 0
  let value = 0
  const out: number[] = []
  for (const ch of clean) {
    value = (value << 5) | B32.indexOf(ch)
    bits += 5
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff)
      bits -= 8
    }
  }
  return Buffer.from(out)
}

export const base32Encode = (buf: Buffer): string => {
  let bits = 0
  let value = 0
  let out = ''
  for (const byte of buf) {
    value = (value << 8) | byte
    bits += 8
    while (bits >= 5) {
      out += B32[(value >>> (bits - 5)) & 31]
      bits -= 5
    }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31]
  return out
}

const hotp = (key: Buffer, counter: number): string => {
  const buf = Buffer.alloc(8)
  // Counter is 64-bit; JS bitwise is 32-bit, so write the halves separately.
  buf.writeUInt32BE(Math.floor(counter / 2 ** 32), 0)
  buf.writeUInt32BE(counter >>> 0, 4)
  const mac = crypto.createHmac('sha1', key).update(buf).digest()
  const offset = mac[mac.length - 1] & 0x0f
  const code =
    ((mac[offset] & 0x7f) << 24) |
    (mac[offset + 1] << 16) |
    (mac[offset + 2] << 8) |
    mac[offset + 3]
  return String(code % 10 ** DIGITS).padStart(DIGITS, '0')
}

export const stepFor = (atMs: number = Date.now()): number =>
  Math.floor(atMs / 1000 / STEP_SECONDS)

export const codeFor = (secret: string, atMs: number = Date.now()): string =>
  hotp(base32Decode(secret), stepFor(atMs))

export type TotpResult = {
  ok: boolean
  step: number | null
  // How far off the accepted step was, in steps. Non-zero on a slow clock;
  // logged server-side because a lockout caused by drift is otherwise a
  // complete mystery. Never returned to the client.
  drift: number
  // Set when the code was correct for a step that has already been used.
  replay: boolean
}

// A code is valid once. Without this, a code seen over someone's shoulder — or
// sitting in a proxy log — works for the rest of its 30-second window, which is
// exactly the reuse a second factor is supposed to prevent.
export const verifyTotp = (
  secret: string,
  token: string,
  opts: { atMs?: number; lastUsedStep?: number } = {},
): TotpResult => {
  const clean = String(token ?? '').replace(/\s/g, '')
  if (!/^\d{6}$/.test(clean)) return { ok: false, step: null, drift: 0, replay: false }

  const key = base32Decode(secret)
  const now = stepFor(opts.atMs ?? Date.now())
  const given = Buffer.from(clean)

  for (let d = -WINDOW; d <= WINDOW; d++) {
    const step = now + d
    const expected = Buffer.from(hotp(key, step))
    if (expected.length === given.length && crypto.timingSafeEqual(expected, given)) {
      if (opts.lastUsedStep !== undefined && step <= opts.lastUsedStep) {
        return { ok: false, step, drift: d, replay: true }
      }
      return { ok: true, step, drift: d, replay: false }
    }
  }
  return { ok: false, step: null, drift: 0, replay: false }
}

export const generateSecret = (): string => base32Encode(crypto.randomBytes(20))

// What an authenticator app scans, or accepts pasted. issuer and account are
// only labels — they decide what the entry is called in the app, nothing else.
export const otpauthUri = (secret: string, account: string, issuer: string): string => {
  const label = encodeURIComponent(`${issuer}:${account}`)
  const params = new URLSearchParams({
    secret,
    issuer,
    algorithm: 'SHA1',
    digits: String(DIGITS),
    period: String(STEP_SECONDS),
  })
  return `otpauth://totp/${label}?${params}`
}

export const looksLikeSecret = (secret: string): boolean => {
  try {
    // 16 bytes is the floor RFC 4226 recommends; 20 is what generateSecret makes.
    return base32Decode(secret).length >= 16
  } catch {
    return false
  }
}
