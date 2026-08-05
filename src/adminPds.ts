import fs from 'node:fs'
import path from 'node:path'
import { AtpAgent } from '@atproto/api'

// Editing the feed RECORD — the thing readers actually see — from the admin UI.
//
// The name, description and avatar a subscriber sees do not live in
// filters.json at all: they live in an app.bsky.feed.generator record on the
// PDS. filters.json's displayName is an internal label for logs and this UI,
// which is why editing it changed nothing visible and rightly looked broken.
//
// CREDENTIALS ARE NEVER STORED. Every call here takes a handle and an app
// password, uses them once, and drops them. That is a deliberate trade against
// convenience: an app password grants write access to the WHOLE repository —
// posts, follows, every record — so keeping one on the box would turn a stolen
// admin session into full control of the account. Nothing on disk, nothing in
// .env, nothing in a backup bundle.
//
// The mechanics are lifted from scripts/setFeedAvatar.ts and
// setFeedDescription.ts rather than reinvented, including the two traps that
// have already cost this project something.

// app.bsky.feed.generator, from the vendored lexicon.
const MAX_DISPLAY_GRAPHEMES = 24
const MAX_DISPLAY_BYTES = 240
const MAX_DESC_GRAPHEMES = 300
const MAX_DESC_BYTES = 3000
const MAX_BLOB_BYTES = 1_000_000

const DATA_DIR = () => process.env.FEEDGEN_DATA_DIR ?? '/data'

// Read AFTER dotenv.config(), never at module load, or a PDS_URL set in .env is
// invisible here. Same trap as the filters path in admin.ts.
const pdsUrl = () => process.env.PDS_URL || 'https://bsky.social'

const graphemes = (s: string): number =>
  [...new Intl.Segmenter('en', { granularity: 'grapheme' }).segment(s)].length

const checkText = (value: string, what: string, maxG: number, maxB: number) => {
  const g = graphemes(value)
  const b = Buffer.byteLength(value, 'utf8')
  if (g > maxG || b > maxB) {
    throw new Error(
      `${what} is too long: ${g}/${maxG} graphemes, ${b}/${maxB} bytes`,
    )
  }
}

export const sniffMime = (bytes: Buffer): string => {
  if (
    bytes.length > 8 &&
    bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
  ) {
    return 'image/png'
  }
  if (bytes.length > 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return 'image/jpeg'
  }
  throw new Error('not a PNG or JPEG — the lexicon accepts nothing else')
}

// The XRPC client does NOT hand a record's blob back in wire shape: it
// deserializes it into a BlobRef whose `ref` is a CID instance, so the obvious
// `avatar.ref.$link` is undefined and every `?.` chain hanging off it quietly
// evaluates to nothing instead of throwing. Going through toJSON gives the
// shape the record actually has. This one cost an avatar once: the backup step
// reported nothing wrong while writing no file at all.
export const blobLink = (blob: any): string | undefined =>
  blob ? JSON.parse(JSON.stringify(blob))?.ref?.$link : undefined

export const login = async (handle: string, password: string): Promise<AtpAgent> => {
  const agent = new AtpAgent({ service: pdsUrl() })
  try {
    await agent.login({ identifier: String(handle).trim(), password })
  } catch (err: any) {
    if (err?.error === 'AuthFactorTokenRequired') {
      // An app password bypasses email 2FA entirely, so hitting this means the
      // account password was used. Say that instead of asking for a code: this
      // page has no business handling an account password.
      throw new Error(
        'that looks like your account password — this needs an APP PASSWORD ' +
          '(Settings → Privacy and security → App passwords). App passwords ' +
          'skip the emailed code, and can be revoked on their own.',
      )
    }
    throw new Error(err?.message ?? String(err))
  }
  return agent
}

export type FeedRecord = { uri: string; cid: string; value: any }

export const getFeedRecord = async (
  publisherDid: string,
  rkey: string,
  agent?: AtpAgent,
): Promise<FeedRecord> => {
  // Readable without logging in, so the UI can show what is live before anyone
  // types a password.
  const client = agent ?? new AtpAgent({ service: pdsUrl() })
  const res = await client.com.atproto.repo.getRecord({
    repo: publisherDid,
    collection: 'app.bsky.feed.generator',
    rkey,
  })
  return { uri: res.data.uri, cid: res.data.cid ?? '', value: res.data.value }
}

// bsky.social answers com.atproto.sync.getBlob with a 302 to the account's real
// PDS host, and the XRPC client does not follow redirects — hence plain fetch.
export const fetchBlob = async (did: string, cid: string): Promise<Buffer> => {
  const url = `${pdsUrl()}/xrpc/com.atproto.sync.getBlob?did=${encodeURIComponent(
    did,
  )}&cid=${encodeURIComponent(cid)}`
  const res = await fetch(url, { redirect: 'follow' })
  if (!res.ok) throw new Error(`getBlob: HTTP ${res.status}`)
  return Buffer.from(await res.arrayBuffer())
}

const putWithRetry = async (
  agent: AtpAgent,
  publisherDid: string,
  rkey: string,
  record: any,
  swapRecord?: string,
): Promise<{ uri: string; cid: string }> => {
  // A PDS has returned a bare 500 on this write before, with a payload it had
  // no reason to reject. Retry on 5xx; anything else is raised immediately.
  for (let attempt = 1; ; attempt++) {
    try {
      const res = await agent.com.atproto.repo.putRecord({
        repo: publisherDid,
        collection: 'app.bsky.feed.generator',
        rkey,
        record,
        ...(swapRecord ? { swapRecord } : {}),
      })
      return res.data
    } catch (err: any) {
      const status = err?.status ?? 0
      if (status < 500 || attempt >= 4) throw err
      await new Promise((r) => setTimeout(r, attempt * 2000))
    }
  }
}

// Keeps restoreFeed truthful. Those two files are the canonical restore pair,
// and letting them drift from what is live is how a restore quietly puts back
// something that was never there.
const refreshRestorePair = (rkey: string, written: { uri: string; cid: string }, record: any, avatar?: Buffer) => {
  const dir = DATA_DIR()
  try {
    fs.writeFileSync(
      path.join(dir, `feed-record-backup-${rkey}.json`),
      JSON.stringify({ uri: written.uri, cid: written.cid, value: record }, null, 2),
    )
    if (avatar) fs.writeFileSync(path.join(dir, `feed-avatar-${rkey}.bin`), avatar)
  } catch {
    // Never fail the write because bookkeeping failed — the record is already
    // live at this point, and reporting success is the truth.
  }
}

const backupBefore = (rkey: string, stamp: string, record: any, avatar?: Buffer) => {
  try {
    const dir = path.join(DATA_DIR(), `record-backup-${stamp}`)
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, `${rkey}.json`), JSON.stringify(record, null, 2))
    if (avatar) fs.writeFileSync(path.join(dir, `${rkey}.avatar.bin`), avatar)
    return dir
  } catch {
    return null
  }
}

export type RecordEdit = {
  displayName?: string
  description?: string
  avatar?: Buffer
}

export const updateFeedRecord = async (
  agent: AtpAgent,
  publisherDid: string,
  rkey: string,
  edit: RecordEdit,
): Promise<{ uri: string; cid: string; changed: string[]; backup: string | null }> => {
  const existing = await getFeedRecord(publisherDid, rkey, agent)
  const record = existing.value
  const changed: string[] = []

  if (edit.displayName !== undefined && edit.displayName !== record.displayName) {
    checkText(edit.displayName, 'display name', MAX_DISPLAY_GRAPHEMES, MAX_DISPLAY_BYTES)
    if (!edit.displayName.trim()) throw new Error('a feed must have a display name')
    record.displayName = edit.displayName
    changed.push('displayName')
  }
  if (edit.description !== undefined && edit.description !== (record.description ?? '')) {
    checkText(edit.description, 'description', MAX_DESC_GRAPHEMES, MAX_DESC_BYTES)
    if (edit.description) record.description = edit.description
    else delete record.description
    changed.push('description')
  }

  // The outgoing avatar blob is downloaded BEFORE the write, because the PDS
  // garbage-collects a blob within minutes of losing its last reference. One
  // logo has already been lost exactly this way.
  let outgoing: Buffer | undefined
  const oldRef = blobLink(record.avatar)
  if (edit.avatar && oldRef) {
    try {
      outgoing = await fetchBlob(publisherDid, oldRef)
    } catch {
      outgoing = undefined
    }
  }
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..+/, 'Z')
  const backup = backupBefore(rkey, stamp, existing, outgoing)

  let uploaded: Buffer | undefined
  if (edit.avatar) {
    const mimeType = sniffMime(edit.avatar)
    if (edit.avatar.length > MAX_BLOB_BYTES) {
      throw new Error(
        `avatar is ${edit.avatar.length} bytes; the lexicon allows ${MAX_BLOB_BYTES}`,
      )
    }
    const res = await agent.com.atproto.repo.uploadBlob(edit.avatar, { encoding: mimeType })
    record.avatar = res.data.blob
    uploaded = edit.avatar
    changed.push('avatar')
  }

  if (!changed.length) throw new Error('nothing to change')

  // swapRecord: fail rather than clobber an edit made between read and write.
  const written = await putWithRetry(agent, publisherDid, rkey, record, existing.cid || undefined)
  refreshRestorePair(rkey, written, record, uploaded)
  return { ...written, changed, backup }
}

export const RKEY_RE = /^[A-Za-z0-9][A-Za-z0-9._~-]{0,63}$/

export const createFeedRecord = async (
  agent: AtpAgent,
  publisherDid: string,
  serviceDid: string,
  rkey: string,
  edit: { displayName: string; description?: string; avatar?: Buffer },
): Promise<{ uri: string; cid: string }> => {
  if (!RKEY_RE.test(rkey)) {
    throw new Error(
      'the record key may contain only letters, digits, and . _ ~ - and must ' +
        'start with a letter or digit',
    )
  }
  checkText(edit.displayName, 'display name', MAX_DISPLAY_GRAPHEMES, MAX_DISPLAY_BYTES)
  if (!edit.displayName.trim()) throw new Error('a feed must have a display name')
  if (edit.description) {
    checkText(edit.description, 'description', MAX_DESC_GRAPHEMES, MAX_DESC_BYTES)
  }

  // Refuse to overwrite an existing feed. putRecord would happily replace one,
  // and a feed record carries its likes and subscribers with its URI.
  let exists = false
  try {
    await getFeedRecord(publisherDid, rkey, agent)
    exists = true
  } catch {
    exists = false
  }
  if (exists) {
    throw new Error(
      `a feed record already exists at rkey "${rkey}". Creating over it would ` +
        `replace a live feed — pick another key.`,
    )
  }

  const record: any = {
    did: serviceDid,
    displayName: edit.displayName,
    createdAt: new Date().toISOString(),
  }
  if (edit.description) record.description = edit.description
  if (edit.avatar) {
    const mimeType = sniffMime(edit.avatar)
    if (edit.avatar.length > MAX_BLOB_BYTES) {
      throw new Error(
        `avatar is ${edit.avatar.length} bytes; the lexicon allows ${MAX_BLOB_BYTES}`,
      )
    }
    const res = await agent.com.atproto.repo.uploadBlob(edit.avatar, { encoding: mimeType })
    record.avatar = res.data.blob
  }

  const written = await putWithRetry(agent, publisherDid, rkey, record)
  refreshRestorePair(rkey, written, record, edit.avatar)
  return written
}

export const decodeImage = (base64: string | undefined): Buffer | undefined => {
  if (!base64) return undefined
  const raw = String(base64).replace(/^data:[^;]+;base64,/, '')
  const bytes = Buffer.from(raw, 'base64')
  if (!bytes.length) throw new Error('the image was empty or not valid base64')
  sniffMime(bytes)
  return bytes
}
