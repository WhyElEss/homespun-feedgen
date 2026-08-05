import fs from 'node:fs'
import os from 'node:os'
import crypto from 'node:crypto'
import { Database } from './db'
import { Config } from './config'
import { getFeedKeys, getFeedConfig } from './filter'
import { lastGc, GC_INTERVAL_MS } from './gc'

// A read-only snapshot of what this box is doing: what it serves, how far
// behind the firehose it is, and what the config on disk currently says.
//
// Everything here is derived from the live process and its own database — no
// network calls. A status page that reaches out to the AppView would take the
// ingest path's event loop with it whenever Bluesky is slow, and a page whose
// job is to tell you the service is healthy must not be the thing that stalls.

export type FeedStatus = {
  key: string
  displayName: string | null
  routed: boolean
  rows: number
  oldest: string | null
  newest: string | null
  retention: { type: string; value: number } | null
  includePatterns: number
  excludePatterns: number
  includeDids: number
  excludeListUri: string | null
  pinnedPost: string | null
}

export type StatusSnapshot = {
  generatedAt: string
  box: {
    name: string
    hostname: string
    pid: number
    node: string
    uptimeSec: number
    processUptimeSec: number
  }
  service: {
    hostname: string
    serviceDid: string
    publisherDid: string
    port: number
    subscriptionEndpoint: string
    writable: boolean
  }
  filters: {
    path: string
    exists: boolean
    modified: string | null
    sizeBytes: number | null
    sha256: string | null
  }
  cursors: {
    service: string
    cursor: number
    at: string | null
    lagSec: number | null
  }[]
  gc: {
    lastAt: string | null
    agoSec: number | null
    nextInSec: number | null
    intervalSec: number
    failures: number
  }
  feeds: FeedStatus[]
}

const filtersPath = () => process.env.FEEDGEN_FILTERS_PATH ?? '/data/filters.json'

// Short digest of the config on disk. Exported because the save path checks the
// SAME value the page displayed: if the two ever computed it differently, the
// concurrency guard would be comparing one thing against another and silently
// let an edit overwrite someone else's.
export const shortDigest = (buf: Buffer): string =>
  crypto.createHash('sha256').update(buf).digest('hex').slice(0, 12)

// The box a change is being made ON. Both boxes run the same image from the
// same tree, and filters.json is authoritative on the primary only — a UI that
// cannot tell you which machine you are looking at is a way to lose an edit.
const boxName = () => process.env.FEEDGEN_BOX_NAME ?? os.hostname()

export const collectStatus = async (
  db: Database,
  cfg: Config,
  startedAt: number,
  writable: boolean,
): Promise<StatusSnapshot> => {
  const now = Date.now()

  const grouped = await db
    .selectFrom('post')
    .select(['feed'])
    .select((eb) => eb.fn.count<number>('uri').as('rows'))
    .select((eb) => eb.fn.min<string>('indexedAt').as('oldest'))
    .select((eb) => eb.fn.max<string>('indexedAt').as('newest'))
    .groupBy('feed')
    .execute()
  const byFeed = new Map(grouped.map((g) => [g.feed, g]))

  // Routed feeds come from the algo table built at startup; configured feeds
  // come from the live config. They differ exactly when someone has added or
  // removed a feed without restarting, which is worth showing rather than
  // hiding — filter.ts only warns about it in the log.
  const configured = getFeedKeys()
  const keys = [...new Set([...configured, ...byFeed.keys()])].sort()

  const feeds: FeedStatus[] = keys.map((key) => {
    const conf = getFeedConfig(key)
    const stats = byFeed.get(key)
    return {
      key,
      displayName: conf?.displayName ?? null,
      routed: configured.includes(key),
      rows: Number(stats?.rows ?? 0),
      oldest: stats?.oldest ?? null,
      newest: stats?.newest ?? null,
      retention: conf?.retention ?? null,
      includePatterns: conf?.include.length ?? 0,
      excludePatterns: conf?.exclude.length ?? 0,
      includeDids: conf?.includeDids.size ?? 0,
      excludeListUri: conf?.excludeListUri ?? null,
      pinnedPost: conf?.pinnedPost ?? null,
    }
  })

  const subs = await db.selectFrom('sub_state').selectAll().execute()
  const cursors = subs.map((s) => {
    // The cursor is a Jetstream time_us — microseconds since the epoch, the
    // same clock indexedAt is stamped from. See src/subscription.ts.
    const ms = s.cursor / 1000
    const sane = Number.isFinite(ms) && ms > 0
    return {
      service: s.service,
      cursor: s.cursor,
      at: sane ? new Date(ms).toISOString() : null,
      lagSec: sane ? Math.round((now - ms) / 1000) : null,
    }
  })

  let filters: StatusSnapshot['filters']
  try {
    const path = filtersPath()
    const buf = fs.readFileSync(path)
    const stat = fs.statSync(path)
    filters = {
      path,
      exists: true,
      modified: stat.mtime.toISOString(),
      sizeBytes: stat.size,
      // Short digest: enough to compare two boxes at a glance, which is the
      // question this actually gets asked. The full hash is in check-parity.
      sha256: shortDigest(buf),
    }
  } catch {
    filters = {
      path: filtersPath(),
      exists: false,
      modified: null,
      sizeBytes: null,
      sha256: null,
    }
  }

  // Retention is enforced on a timer, not on write, so "501 posts with a 500
  // limit" is normal between sweeps — showing when the last one ran is what
  // makes that legible instead of looking like an off-by-one.
  const gc = lastGc()
  const gcAgo = gc.at === undefined ? null : Math.round((now - gc.at) / 1000)

  return {
    generatedAt: new Date(now).toISOString(),
    gc: {
      lastAt: gc.at === undefined ? null : new Date(gc.at).toISOString(),
      agoSec: gcAgo,
      nextInSec: gcAgo === null ? null : Math.max(0, Math.round(GC_INTERVAL_MS / 1000) - gcAgo),
      intervalSec: Math.round(GC_INTERVAL_MS / 1000),
      failures: gc.failures,
    },
    box: {
      name: boxName(),
      hostname: os.hostname(),
      pid: process.pid,
      node: process.version,
      uptimeSec: Math.round(os.uptime()),
      processUptimeSec: Math.round((now - startedAt) / 1000),
    },
    service: {
      hostname: cfg.hostname,
      serviceDid: cfg.serviceDid,
      publisherDid: cfg.publisherDid,
      port: cfg.port,
      subscriptionEndpoint: cfg.subscriptionEndpoint,
      writable,
    },
    filters,
    cursors,
    feeds,
  }
}
