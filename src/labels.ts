import WebSocket from 'ws'
import { Frame } from '@atproto/xrpc-server'
import { Database } from './db'

// Labels from Bluesky's moderation service, for the feeds that choose to hide
// what it labels.
//
// A self-label lives inside the post record, so the filter can read it at
// ingest. A moderator's label does not: the labeler publishes it separately,
// seconds or days after the post, and Jetstream never carries it. Two sources
// cover that between them:
//
//   * the labeler's own stream (com.atproto.label.subscribeLabels) — every
//     label it issues, as it issues it. A label on a post this box already
//     stores is written down; everything else is dropped, because ~66 000
//     labels a day go past and nearly none are ours.
//   * one question per stored post (com.atproto.label.queryLabels), asked
//     about a minute after the post arrived. That covers the label issued
//     BEFORE the post reached us — the automated image classifier answers in
//     about four seconds, and a Jetstream replay after an outage can deliver
//     the post hours late — and it covers every post that was already stored
//     when this code first ran.
//
// Nothing is deleted on account of a label. The feed handler declines to SERVE
// a post whose label the feed names (src/algos/feed.ts), so switching a label
// off on /admin brings those posts straight back, and a label the labeler
// withdraws on appeal — a negation on the stream — does the same.
//
// Labels on ACCOUNTS are not followed, deliberately. Bluesky's own clients
// hide a post for a label on the post; an adult label on an account blurs its
// avatar and banner and leaves its posts alone. Moderating accounts per feed
// is what each feed's moderation list is for.

export const LABELER_DID = 'did:plc:ar7c4by46qjdydhdevvrndac'
export const LABELER_URL = 'https://mod.bsky.app'

export type Label = {
  src: string
  uri: string
  val: string
  cts: string
  neg?: boolean
  exp?: string
}

const POST_PATH = '/app.bsky.feed.post/'

const isOurKind = (l: Label): boolean =>
  l.src === LABELER_DID &&
  typeof l.uri === 'string' &&
  l.uri.startsWith('at://') &&
  l.uri.includes(POST_PATH) &&
  typeof l.val === 'string' &&
  typeof l.cts === 'string'

// The state a batch of labels leaves behind: for each (post, value) the last
// word, which is either the label or its withdrawal (null). Ordered by cts
// because queryLabels promises no order; ties keep the order they came in.
export const foldLabels = (labels: Label[]): Map<string, Label | null> => {
  const ordered = labels
    .map((l, i) => ({ l, i }))
    .filter(({ l }) => isOurKind(l))
    .sort((a, b) => (a.l.cts < b.l.cts ? -1 : a.l.cts > b.l.cts ? 1 : a.i - b.i))
  const out = new Map<string, Label | null>()
  for (const { l } of ordered) out.set(`${l.uri}\n${l.val}`, l.neg ? null : l)
  return out
}

const chunk = <T>(xs: T[], n: number): T[][] => {
  const out: T[][] = []
  for (let i = 0; i < xs.length; i += n) out.push(xs.slice(i, i + n))
  return out
}

// Write a batch down. A label is kept only for a post this box stores; a
// withdrawal is applied whatever is stored, since removing nothing is free.
// Returns how many rows were written or removed.
export const applyLabels = async (db: Database, labels: Label[]): Promise<number> => {
  const folded = foldLabels(labels)
  if (folded.size === 0) return 0

  const uris = [...new Set([...folded.values()].filter(Boolean).map((l) => l!.uri))]
  const stored = new Set<string>()
  for (const part of chunk(uris, 200)) {
    const rows = await db
      .selectFrom('post')
      .select('uri')
      .where('uri', 'in', part)
      .groupBy('uri')
      .execute()
    for (const r of rows) stored.add(r.uri)
  }

  let changed = 0
  for (const [k, l] of folded) {
    const [uri, val] = k.split('\n')
    if (l === null) {
      const res = await db
        .deleteFrom('post_label')
        .where('uri', '=', uri)
        .where('val', '=', val)
        .executeTakeFirst()
      changed += Number(res.numDeletedRows ?? 0)
      continue
    }
    if (!stored.has(uri)) continue
    await db
      .insertInto('post_label')
      .values({ uri, val, cts: l.cts, exp: l.exp ?? null })
      .onConflict((oc) => oc.columns(['uri', 'val']).doUpdateSet({ cts: l.cts, exp: l.exp ?? null }))
      .execute()
    changed++
  }
  return changed
}

type FetchLike = (url: string) => Promise<{ ok: boolean; status: number; json(): Promise<any> }>

// About a minute after arrival: long enough for the image classifier, which
// answered the post that prompted all this in four seconds.
export const CHECK_MIN_AGE_MS = 60_000
// queryLabels took 60 patterns in one call when measured; 50 leaves room.
const CHECK_BATCH = 50
const CHECK_MAX_PER_RUN = 1000
const QUERY_LIMIT = 250

// Ask the labeler about every stored post nobody has asked about yet. A batch
// that fails is left unchecked and asked again next time, so an outage at the
// labeler delays this and loses nothing.
export const checkNewPosts = async (
  db: Database,
  opts: { now?: number; fetchImpl?: FetchLike; minAgeMs?: number } = {},
): Promise<{ checked: number; labelled: number }> => {
  const now = opts.now ?? Date.now()
  const fetchImpl: FetchLike = opts.fetchImpl ?? (fetch as unknown as FetchLike)
  const cutoff = new Date(now - (opts.minAgeMs ?? CHECK_MIN_AGE_MS)).toISOString()

  // Newest first: those are the posts at the top of a feed.
  const rows = await db
    .selectFrom('post')
    .leftJoin('label_check', 'label_check.uri', 'post.uri')
    .select('post.uri as uri')
    .select((eb) => eb.fn.max('post.indexedAt').as('at'))
    .where('label_check.uri', 'is', null)
    .where('post.indexedAt', '<=', cutoff)
    .groupBy('post.uri')
    .orderBy('at', 'desc')
    .limit(CHECK_MAX_PER_RUN)
    .execute()

  let checked = 0
  let labelled = 0
  for (const part of chunk(rows.map((r) => r.uri), CHECK_BATCH)) {
    const labels: Label[] = []
    let cursor: string | undefined
    for (;;) {
      const qs = new URLSearchParams({ limit: String(QUERY_LIMIT) })
      for (const uri of part) qs.append('uriPatterns', uri)
      qs.append('sources', LABELER_DID)
      if (cursor) qs.set('cursor', cursor)
      const res = await fetchImpl(`${LABELER_URL}/xrpc/com.atproto.label.queryLabels?${qs}`)
      if (!res.ok) throw new Error(`queryLabels: HTTP ${res.status}`)
      const body = await res.json()
      const page: Label[] = Array.isArray(body?.labels) ? body.labels : []
      labels.push(...page)
      if (page.length < QUERY_LIMIT || !body.cursor || body.cursor === cursor) break
      cursor = body.cursor
    }
    labelled += await applyLabels(db, labels)
    const at = new Date(now).toISOString()
    await db
      .insertInto('label_check')
      .values(part.map((uri) => ({ uri, checkedAt: at })))
      .onConflict((oc) => oc.doNothing())
      .execute()
    checked += part.length
  }
  return { checked, labelled }
}

// Labels and checks whose post is gone, and labels past their expiry. Posts
// leave by retention, deletion upstream and purges, and none of those paths
// knows about labels, so the tables are tidied after them instead.
export const pruneLabels = async (db: Database, now: number = Date.now()): Promise<void> => {
  const iso = new Date(now).toISOString()
  await db
    .deleteFrom('post_label')
    .where((eb) =>
      eb.or([
        eb('uri', 'not in', eb.selectFrom('post').select('uri')),
        eb.and([eb('exp', 'is not', null), eb('exp', '<=', iso)]),
      ]),
    )
    .execute()
  await db
    .deleteFrom('label_check')
    .where('uri', 'not in', (eb) => eb.selectFrom('post').select('uri'))
    .execute()
}

// Per value, how many of this feed's stored posts carry it right now. What the
// control on /admin shows beside each value, so switching one on says what it
// is about to hide before Save.
export const labelCounts = async (
  db: Database,
  feed: string,
  now: number = Date.now(),
): Promise<{ counts: Record<string, number>; stored: number; unchecked: number }> => {
  const iso = new Date(now).toISOString()
  const rows = await db
    .selectFrom('post')
    .innerJoin('post_label', 'post_label.uri', 'post.uri')
    .select('post_label.val as val')
    .select((eb) => eb.fn.count<number>('post.uri').distinct().as('n'))
    .where('post.feed', '=', feed)
    .where((eb) => eb.or([eb('post_label.exp', 'is', null), eb('post_label.exp', '>', iso)]))
    .groupBy('post_label.val')
    .execute()
  const counts: Record<string, number> = {}
  for (const r of rows) counts[r.val] = Number(r.n)

  const stored = await db
    .selectFrom('post')
    .select((eb) => eb.fn.countAll<number>().as('n'))
    .where('feed', '=', feed)
    .executeTakeFirst()
  const unchecked = await db
    .selectFrom('post')
    .leftJoin('label_check', 'label_check.uri', 'post.uri')
    .select((eb) => eb.fn.countAll<number>().as('n'))
    .where('post.feed', '=', feed)
    .where('label_check.uri', 'is', null)
    .executeTakeFirst()
  return { counts, stored: Number(stored?.n ?? 0), unchecked: Number(unchecked?.n ?? 0) }
}

// The live labels on one post, as this box holds them.
export const storedLabelsFor = async (
  db: Database,
  uri: string,
  now: number = Date.now(),
): Promise<string[]> => {
  const iso = new Date(now).toISOString()
  const rows = await db
    .selectFrom('post_label')
    .select('val')
    .where('uri', '=', uri)
    .where((eb) => eb.or([eb('exp', 'is', null), eb('exp', '>', iso)]))
    .execute()
  return rows.map((r) => r.val)
}

// What the status page reports. Module state, like gc.ts's lastGc: the page
// wants it and the stream object is not reachable from there.
const state = {
  connected: false,
  lastLabelAt: undefined as number | undefined,
  lastCheckAt: undefined as number | undefined,
  lastCheckError: undefined as string | undefined,
  outdatedCursorAt: undefined as number | undefined,
}

export const labelStreamState = () => ({ ...state })

export const uncheckedCount = async (db: Database): Promise<number> => {
  const r = await db
    .selectFrom('post')
    .leftJoin('label_check', 'label_check.uri', 'post.uri')
    .select((eb) => eb.fn.count<number>('post.uri').distinct().as('n'))
    .where('label_check.uri', 'is', null)
    .executeTakeFirst()
  return Number(r?.n ?? 0)
}

const CURSOR_SAVE_INTERVAL_MS = 10_000
const CHECK_INTERVAL_MS = 60_000
const PRUNE_INTERVAL_MS = 60 * 60 * 1000
// The stream carried ~46 labels a minute when measured (2026-09-16). Five
// silent minutes is a connection that has stopped existing, not a lull — the
// same half-open socket the Jetstream watchdog exists for.
export const LABEL_IDLE_TIMEOUT_MS = 5 * 60_000
const IDLE_CHECK_INTERVAL_MS = 30_000
const PING_INTERVAL_MS = 30_000
const HANDSHAKE_TIMEOUT_MS = 30_000

export class LabelSubscription {
  private ws?: WebSocket
  private cursor?: number
  private savedCursor?: number
  private lastMessageAt = 0
  private checking = false

  constructor(public db: Database, public service: string = LABELER_URL) {}

  async run(reconnectDelay: number) {
    const row = await this.db
      .selectFrom('label_state')
      .selectAll()
      .where('service', '=', this.service)
      .executeTakeFirst()
    this.cursor = row?.cursor
    this.savedCursor = row?.cursor
    this.connect(reconnectDelay)

    setInterval(() => {
      this.saveCursor().catch((err) => console.error('labels: failed to save cursor', err))
    }, CURSOR_SAVE_INTERVAL_MS)
    setInterval(() => this.check(), CHECK_INTERVAL_MS)
    setInterval(() => {
      pruneLabels(this.db).catch((err) => console.error('labels: prune failed', err))
    }, PRUNE_INTERVAL_MS)
    setInterval(() => this.checkAlive(), IDLE_CHECK_INTERVAL_MS)
    setInterval(() => {
      if (this.ws?.readyState === WebSocket.OPEN) this.ws.ping()
    }, PING_INTERVAL_MS)
    this.check()
  }

  // Never two at once: a first run over a full database takes a while, and the
  // next tick must not ask the same questions again underneath it.
  async check() {
    if (this.checking) return
    this.checking = true
    try {
      const r = await checkNewPosts(this.db)
      state.lastCheckAt = Date.now()
      state.lastCheckError = undefined
      if (r.labelled) console.log(`labels: asked about ${r.checked} posts, ${r.labelled} labelled`)
    } catch (err) {
      state.lastCheckError = String(err)
      console.error('labels: check failed, will retry', err)
    } finally {
      this.checking = false
    }
  }

  checkAlive(now = Date.now()): boolean {
    const ws = this.ws
    if (!ws) return false
    if (now - this.lastMessageAt < LABEL_IDLE_TIMEOUT_MS) return false
    console.warn('labels: stream silent, forcing a reconnect')
    this.lastMessageAt = now
    ws.terminate()
    return true
  }

  private async saveCursor() {
    const cursor = this.cursor
    if (cursor === undefined || cursor === this.savedCursor) return
    await this.db
      .insertInto('label_state')
      .values({ service: this.service, cursor })
      .onConflict((oc) => oc.column('service').doUpdateSet({ cursor }))
      .execute()
    this.savedCursor = cursor
  }

  private connect(reconnectDelay: number) {
    const url =
      this.service.replace(/^http/, 'ws') +
      '/xrpc/com.atproto.label.subscribeLabels' +
      (this.cursor !== undefined ? `?cursor=${this.cursor}` : '')
    console.log(`labels: connecting to ${url}`)
    this.lastMessageAt = Date.now()
    const ws = new WebSocket(url, { handshakeTimeout: HANDSHAKE_TIMEOUT_MS })
    this.ws = ws
    ws.on('open', () => {
      if (this.ws === ws) state.connected = true
    })
    ws.on('message', (data) => {
      this.handleFrame(data as Buffer).catch((err) =>
        console.error('labels: could not handle frame', err),
      )
    })
    ws.on('error', (err) => console.error('labels: socket error', err))
    ws.on('close', () => {
      if (this.ws !== ws) return
      state.connected = false
      console.warn(`labels: disconnected, retrying in ${reconnectDelay}ms`)
      setTimeout(() => this.connect(reconnectDelay), reconnectDelay)
    })
  }

  // Public so the tests can drive it with frames built in memory.
  async handleFrame(bytes: Uint8Array) {
    this.lastMessageAt = Date.now()
    const frame = Frame.fromBytes(bytes)
    if (frame.isError()) {
      console.error(`labels: stream error ${frame.code}: ${frame.message ?? ''}`)
      return
    }
    if (frame.type === '#info') {
      const body = frame.body as { name?: string; message?: string }
      console.warn(`labels: stream info ${body.name}: ${body.message ?? ''}`)
      // The labeler no longer holds the history back to our cursor, so labels
      // issued while we were away are gone from the stream. Asking about every
      // stored post again recovers them.
      if (body.name === 'OutdatedCursor') {
        state.outdatedCursorAt = Date.now()
        await this.db.deleteFrom('label_check').execute()
      }
      return
    }
    if (frame.type !== '#labels') return
    const body = frame.body as { seq: number; labels: Label[] }
    if (Array.isArray(body.labels) && body.labels.length) {
      state.lastLabelAt = Date.now()
      await applyLabels(this.db, body.labels)
    }
    if (typeof body.seq === 'number') this.cursor = body.seq
  }
}
