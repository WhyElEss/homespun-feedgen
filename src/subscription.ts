import WebSocket from 'ws'
import { Database } from './db'
import { matchesFeed, watchFilters, getExcludeListUri } from './filter'

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

// Old posts are garbage-collected (the feed is recency-based)
const GC_INTERVAL_MS = 60 * 60 * 1000
const KEEP_HOURS = 72

export class JetstreamSubscription {
  private ws?: WebSocket
  private cursor?: number
  private excludedDids = new Set<string>()

  constructor(public db: Database, public service: string) {}

  async run(reconnectDelay: number) {
    watchFilters() // throws on a broken config at startup — fail loudly
    this.cursor = await this.loadCursor()
    await this.refreshExcludedDids()
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
      const cutoff = new Date(
        Date.now() - KEEP_HOURS * 3600 * 1000,
      ).toISOString()
      this.db
        .deleteFrom('post')
        .where('indexedAt', '<', cutoff)
        .execute()
        .catch((err) => console.error('gc failed', err))
    }, GC_INTERVAL_MS)
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

  private async handleMessage(raw: string) {
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
      if (this.excludedDids.has(evt.did)) return
      const record = evt.commit.record
      if (!record || !matchesFeed(record)) return
      await this.db
        .insertInto('post')
        .values({
          uri,
          cid: evt.commit.cid ?? '',
          indexedAt: new Date().toISOString(),
        })
        .onConflict((oc) => oc.doNothing())
        .execute()
    }
    // 'update' operations are not relevant for this feed
  }

  private async refreshExcludedDids() {
    try {
      const listUri = getExcludeListUri()
      if (!listUri) {
        this.excludedDids = new Set()
        return
      }
      const dids = new Set<string>()
      let cursor: string | undefined
      do {
        const params = new URLSearchParams({
          list: listUri,
          limit: '100',
        })
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
      this.excludedDids = dids
      console.log(`exclude list: ${dids.size} accounts`)
    } catch (err) {
      // keep the previous set on failure — better stale than empty
      console.error('exclude list: refresh failed', err)
    }
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
