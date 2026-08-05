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

// SkyFeed "remove by list" block: member DIDs are refreshed periodically
const LIST_REFRESH_INTERVAL_MS = 60 * 60 * 1000

// Old posts are garbage-collected. How much each feed keeps is per-feed
// config (retention: by age or by post count) — see filter.ts.

export class JetstreamSubscription {
  private ws?: WebSocket
  private cursor?: number
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
    this.ws = new WebSocket(url)

    this.ws.on('message', (data) => {
      this.handleMessage(data.toString()).catch((err) =>
        console.error('jetstream: could not handle message', err),
      )
    })
    this.ws.on('error', (err) => {
      console.error('jetstream: socket error', err)
    })
    this.ws.on('close', () => {
      console.warn(`jetstream: disconnected, retrying in ${reconnectDelay}ms`)
      setTimeout(() => this.connect(reconnectDelay), reconnectDelay)
    })
  }

  // Public for the same reason as excludedDids above: testable end to end.
  async handleMessage(raw: string) {
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
