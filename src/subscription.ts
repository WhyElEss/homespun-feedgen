import WebSocket from 'ws'
import { Database } from './db'
import { matchingFeeds, getExcludeListUris } from './filter'
import { pruneFeeds, GC_INTERVAL_MS } from './gc'

import type { MatchablePost } from './filter'

// Jetstream event shapes, per the official README
// (github.com/bluesky-social/jetstream)
type PostRecord = MatchablePost & {
  $type: string
  langs?: string[]
  createdAt?: string
}

type JetstreamEvent = {
  did: string
  time_us: number
  kind: 'commit' | 'identity' | 'account'
  commit?: {
    rev: string
    operation: 'create' | 'update' | 'delete'
    collection: string
    rkey: string
    record?: PostRecord
    cid?: string
  }
}

// On reconnect, rewind cursor a few seconds for gapless playback
// (official Jetstream README recommendation). Values are microseconds.
const CURSOR_REWIND_US = 5_000_000
const CURSOR_SAVE_INTERVAL_MS = 10_000

// A dead link does not always produce a socket event. If the path disappears
// without the peer sending FIN or RST -- a switch reboot, a cable pulled, a NAT
// table wiped -- the connection sits half-open: no 'close', no 'error', and the
// reconnect below therefore never runs. The process stays perfectly healthy and
// ingests nothing. That is exactly what a 77-second link flap did on
// 2026-08-19: ingest stopped for 10.5 hours and only a reboot noticed.
//
// The stream carries every post on the network, several per second, so silence
// this long is never a quiet period -- it is a connection that has stopped
// existing. Anything above a few seconds would do; a minute is chosen to leave
// room for a slow replay without ever being mistaken for real traffic.
const IDLE_TIMEOUT_MS = 60_000
const IDLE_CHECK_INTERVAL_MS = 10_000
// The independent second line, and the one that needs no timer to be right: a
// write on a half-open socket makes the kernel retransmit, and the retransmit
// eventually raises ECONNRESET or ETIMEDOUT, which DOES reach 'error'/'close'.
// A pong is deliberately not counted as liveness -- a peer that answers pings
// while sending no events is still a feed that has stopped.
const PING_INTERVAL_MS = 30_000
// ws has no connect timeout of its own, so a SYN into a black hole would hang
// in CONNECTING forever -- the same silent stall one step earlier.
const HANDSHAKE_TIMEOUT_MS = 30_000

// SkyFeed "remove by list" block: member DIDs are refreshed periodically
const LIST_REFRESH_INTERVAL_MS = 60 * 60 * 1000

// Old posts are garbage-collected. How much each feed keeps is per-feed
// config (retention: by age or by post count) — see filter.ts.

export class JetstreamSubscription {
  private ws?: WebSocket
  private cursor?: number
  // Wall clock, not event time: this measures whether the SOCKET is alive, and
  // a replay delivers hours-old events perfectly healthily.
  private lastMessageAt = 0
  // feed key -> DIDs muted for that feed by its moderation list.
  // Not private: the ingest path is the least covered code here and the most
  // consequential, so the tests drive it directly rather than through a socket.
  excludedDids = new Map<string, Set<string>>()

  constructor(public db: Database, public service: string) {}

  async run(reconnectDelay: number) {
    // filters are loaded by FeedGenerator.create() before routing is built
    this.cursor = await this.loadCursor()
    await this.refreshExcludedDids()
    await this.gc()
    this.connect(reconnectDelay)
    setInterval(() => {
      if (this.cursor) {
        this.saveCursor(this.cursor).catch((err) =>
          console.error('jetstream: failed to save cursor', err),
        )
      }
    }, CURSOR_SAVE_INTERVAL_MS)
    setInterval(() => {
      this.refreshExcludedDids().catch(() => {})
    }, LIST_REFRESH_INTERVAL_MS)
    setInterval(() => {
      this.gc().catch((err) => console.error('gc failed', err))
    }, GC_INTERVAL_MS)
    setInterval(() => this.checkAlive(), IDLE_CHECK_INTERVAL_MS)
    setInterval(() => {
      if (this.ws?.readyState === WebSocket.OPEN) this.ws.ping()
    }, PING_INTERVAL_MS)
  }

  // Public for the same reason as handleMessage below: the tests drive it with
  // a stub socket, because the failure it exists for cannot be reached through
  // a real connection. Returns whether it gave up on the current socket.
  checkAlive(now = Date.now()): boolean {
    const ws = this.ws
    if (!ws) return false
    const idleMs = now - this.lastMessageAt
    if (idleMs < IDLE_TIMEOUT_MS) return false
    console.warn(
      `jetstream: no data for ${Math.round(idleMs / 1000)}s, forcing a reconnect`,
    )
    // Stamped before terminating, not after: 'close' arrives asynchronously and
    // the next tick must not fire again while that reconnect is still landing.
    this.lastMessageAt = now
    // terminate(), not close(): a half-open socket will never answer a closing
    // handshake. This reaches 'close' below, which is the only reconnect path.
    ws.terminate()
    return true
  }

  private async gc() {
    await pruneFeeds(this.db)
  }

  private connect(reconnectDelay: number) {
    const params = new URLSearchParams()
    params.append('wantedCollections', 'app.bsky.feed.post')
    if (this.cursor) {
      params.append(
        'cursor',
        String(Math.max(0, this.cursor - CURSOR_REWIND_US)),
      )
    }
    const url = `${this.service}/subscribe?${params.toString()}`
    console.log(`jetstream: connecting to ${url}`)
    // Stamped before the socket exists, so the watchdog never counts the time
    // spent connecting: a slow handshake would otherwise terminate itself.
    this.lastMessageAt = Date.now()
    const ws = new WebSocket(url, { handshakeTimeout: HANDSHAKE_TIMEOUT_MS })
    this.ws = ws

    ws.on('message', (data) => {
      this.handleMessage(data.toString()).catch((err) =>
        console.error('jetstream: could not handle message', err),
      )
    })
    ws.on('error', (err) => {
      console.error('jetstream: socket error', err)
    })
    ws.on('close', () => {
      // A socket we have already replaced can still close late; acting on it
      // would open a second connection alongside the live one.
      if (this.ws !== ws) return
      console.warn(`jetstream: disconnected, retrying in ${reconnectDelay}ms`)
      setTimeout(() => this.connect(reconnectDelay), reconnectDelay)
    })
  }

  // Public for the same reason as excludedDids above: testable end to end.
  async handleMessage(raw: string) {
    // Liveness is "bytes arrived", so it is stamped before anything can reject
    // this message -- an event for a collection we ignore still proves the
    // socket is carrying traffic.
    this.lastMessageAt = Date.now()
    const evt = JSON.parse(raw) as JetstreamEvent
    this.cursor = evt.time_us

    // identity / account events arrive regardless of filters — ignore them
    if (evt.kind !== 'commit' || !evt.commit) return
    if (evt.commit.collection !== 'app.bsky.feed.post') return

    const uri = `at://${evt.did}/${evt.commit.collection}/${evt.commit.rkey}`

    if (evt.commit.operation === 'delete') {
      await this.db.deleteFrom('post').where('uri', '=', uri).execute()
      return
    }

    if (evt.commit.operation === 'create') {
      const record = evt.commit.record
      if (!record) return
      // A post can belong to several feeds; each feed applies its own
      // moderation list on top of the shared match.
      const feeds = matchingFeeds(record, evt.did).filter(
        (feed) => !this.excludedDids.get(feed)?.has(evt.did),
      )
      if (feeds.length === 0) return

      // Stamp with the relay-assigned event time, not the wall clock. This is
      // the same value the cursor is built from, so a replayed post lands in
      // its true position instead of on top of the feed. Deliberately NOT
      // record.createdAt, which the client sets and can therefore forge.
      const indexedAt = new Date(evt.time_us / 1000).toISOString()
      await this.db
        .insertInto('post')
        .values(
          feeds.map((feed) => ({
            uri,
            cid: evt.commit!.cid ?? '',
            indexedAt,
            feed,
          })),
        )
        .onConflict((oc) => oc.doNothing())
        .execute()
    }
    // 'update' operations are not relevant for these feeds
  }

  private async fetchList(listUri: string): Promise<Set<string>> {
    const dids = new Set<string>()
    let cursor: string | undefined
    do {
      const params = new URLSearchParams({ list: listUri, limit: '100' })
      if (cursor) params.set('cursor', cursor)
      const res = await fetch(
        `https://public.api.bsky.app/xrpc/app.bsky.graph.getList?${params.toString()}`,
      )
      if (!res.ok) throw new Error(`getList: HTTP ${res.status}`)
      const data = (await res.json()) as {
        cursor?: string
        items: { subject: { did: string } }[]
      }
      for (const item of data.items) dids.add(item.subject.did)
      cursor = data.cursor
    } while (cursor)
    return dids
  }

  // Cached per list URI so that several feeds sharing one list cost one fetch,
  // and so a failed refresh can fall back to the previous membership.
  private listCache = new Map<string, Set<string>>()

  private async refreshExcludedDids() {
    const byFeed = getExcludeListUris()
    const next = new Map<string, Set<string>>()

    for (const uri of new Set(byFeed.values())) {
      try {
        const dids = await this.fetchList(uri)
        this.listCache.set(uri, dids)
        console.log(`exclude list ${uri}: ${dids.size} accounts`)
      } catch (err) {
        // keep the previous membership on failure — better stale than empty
        console.error(`exclude list ${uri}: refresh failed`, err)
      }
    }

    for (const [feed, uri] of byFeed) {
      const dids = this.listCache.get(uri)
      if (dids) next.set(feed, dids)
    }
    this.excludedDids = next
  }

  private async loadCursor(): Promise<number | undefined> {
    const res = await this.db
      .selectFrom('sub_state')
      .selectAll()
      .where('service', '=', this.service)
      .executeTakeFirst()
    return res?.cursor
  }

  private async saveCursor(cursor: number) {
    // upsert: the starter kit's original updateCursor() only UPDATEs and
    // silently does nothing when the row is missing — we insert-or-update
    await this.db
      .insertInto('sub_state')
      .values({ service: this.service, cursor })
      .onConflict((oc) => oc.column('service').doUpdateSet({ cursor }))
      .execute()
  }
}
