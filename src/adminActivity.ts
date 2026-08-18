import fs from 'node:fs'
import path from 'node:path'
import { sql } from 'kysely'
import { Database } from './db'
import { getFeedKeys, getFeedConfig } from './filter'

// What MOVED in the last 24 hours, as opposed to what the status page reports,
// which is what the box IS right now.
//
// Two sources, and the reason there are two is the whole point of this file:
//
//   * the `post` table says what is stored. It cannot say what was removed,
//     because removal is a delete;
//   * the dumps purgePosts writes next to the database say exactly what was
//     removed, and when.
//
// Together they reconstruct what actually reached readers. That matters for one
// specific question an operator cannot otherwise answer: you block an account
// on the strength of the ONE post you happened to see, the sweep removes four,
// and nothing anywhere tells you about the other three — which were in people's
// feeds the whole time.
//
// WHY 24 HOURS AND NOT SEVEN DAYS. The shortest retention window on these feeds
// is 72 h (a count retention of 500 works out at roughly 38 h on a busy
// single-account feed), so
// inside a 24 h window the hourly GC has removed nothing. The only thing that
// takes rows out of this window is a purge, and a purge leaves a dump. So the
// two sources are complete here and nowhere else: a seven-day chart would be
// mostly retention holes drawn as zeroes, which reads as "no posts that day".
//
// Nothing here reaches the network, for the same reason collectStatus does not:
// a view whose job is to tell you the service is healthy must not be the thing
// that stalls when Bluesky is slow.

export type PurgeKind = 'blocklist' | 'filter' | 'manual' | 'mixed' | 'unknown'

export type PurgedRow = {
  feed: string
  uri: string
  handle: string
  text: string
  why: string
  indexedAt: string
  kind: PurgeKind
}

export type PurgeEvent = {
  at: string
  kind: PurgeKind
  total: number
  byFeed: { feed: string; count: number }[]
  rows: PurgedRow[]
  // Rows present in the dump but not in `rows`. Shown, never swallowed: a list
  // silently cut at 100 reads as a complete list of 100.
  omitted: number
}

export type WithheldEvent = {
  at: string
  mode: string
  // The feed the refused sweep was scoped to. Empty on records written before
  // auto-purge went per-feed: those carry BOX-WIDE counts, and the page has to
  // say so rather than show them under whichever feed is selected.
  feed: string
  count: number
  stored: number
  limit: number
}

export type ActivityFeed = {
  key: string
  // One entry per hour in `hours`, same order.
  stored: number[]
  purged: number[]
  // Hours at or before this are cut by retention, so a zero there means "gone
  // by design", not "nothing arrived". Null when retention does not reach into
  // the window at all, which is the normal case for an hours-based feed.
  floor: string | null
}

export type ActivitySnapshot = {
  generatedAt: string
  // 24 UTC hour starts, oldest first. The last one is the hour in progress.
  hours: string[]
  feeds: ActivityFeed[]
  events: PurgeEvent[]
  withheld: WithheldEvent[]
  // Anything skipped, capped or unreadable. Never empty by accident: an empty
  // notes list is a claim that everything in the window was read.
  notes: string[]
}

// Read per request, never captured at module load — an import is evaluated
// before anything the caller sets afterwards. Same trap as filtersPath() in
// admin.ts and PDS_URL in the avatar script.
const dbPath = () => process.env.FEEDGEN_SQLITE_LOCATION ?? '/data/db.sqlite'
// purgePosts writes its dumps beside the database, so this must derive the
// directory the same way it does or the two disagree about where to look.
const dataDir = () => path.dirname(dbPath())

const HOURS = 24
const HOUR_MS = 3600 * 1000

// A dump holds at most the auto-purge cap (25 rows) unless someone ran a
// targeted --author sweep by hand, which has no cap at all. The counts always
// come from the whole file; only the detail list is bounded.
const MAX_ROWS_PER_EVENT = 100
const MAX_EVENTS = 50
// A dump this big is not a dump. Refuse it rather than parsing megabytes of
// JSON on the event loop that also serves the feeds.
const MAX_DUMP_BYTES = 4 * 1024 * 1024
const MAX_WITHHELD_BYTES = 256 * 1024

// purgePosts names its dumps with a compact UTC stamp: purged-20260808T191012Z.
const DUMP_RE = /^purged-(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z\.json$/

const stampToIso = (m: RegExpMatchArray): string =>
  `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}.000Z`

// The dump records WHY each row went, but not which mode produced it. --blocked
// writes one fixed string and the targeted modes write two more; anything else
// is a filter verdict, which since af2a4b5 names the word that fired.
//
// This is inference, not a recorded field, so the raw `why` travels with every
// row: if purgePosts ever changes the wording the label degrades to "filter"
// while the actual reason stays on screen.
const kindOf = (why: string): PurgeKind => {
  if (why === 'on moderation list') return 'blocklist'
  if (why === 'author' || why === 'named uri' || why === 'not retrievable') return 'manual'
  return why ? 'filter' : 'unknown'
}

const collapseKinds = (kinds: PurgeKind[]): PurgeKind => {
  const set = new Set(kinds)
  if (set.size === 0) return 'unknown'
  if (set.size === 1) return kinds[0]
  return 'mixed'
}

// The 24 hour-buckets the whole snapshot is indexed by, as UTC hour starts.
//
// Buckets are UTC because that is what indexedAt holds; the page converts them
// for display. On a zone whose offset is not a whole number of hours the labels
// land on the half hour, which is accurate rather than wrong — sub-hour
// bucketing would be a real cost for a cosmetic gain.
export const windowHours = (now: number): string[] => {
  const top = Math.floor(now / HOUR_MS) * HOUR_MS
  const out: string[] = []
  for (let i = HOURS - 1; i >= 0; i--) {
    out.push(new Date(top - i * HOUR_MS).toISOString().slice(0, 13))
  }
  return out
}

// Where retention has already cut into the visible window.
//
// An hours-based feed has a hard cutoff that simply is not inside 24 h at these
// settings. A count-based feed is different: its window is however long the
// last N posts happen to span, and that CAN be shorter than a day if the
// account bursts. Only report a floor when the feed is actually at its cap —
// below it, nothing has been pruned and an early empty hour is just quiet.
export const retentionFloor = (
  key: string,
  rows: number,
  oldest: string | null,
  now: number,
): string | null => {
  const conf = getFeedConfig(key)
  const r = conf?.retention
  if (!r) return null
  if (r.type === 'hours') {
    const cut = new Date(now - r.value * HOUR_MS).toISOString()
    // Only interesting if it reaches into the window we are drawing.
    return cut > new Date(now - HOURS * HOUR_MS).toISOString() ? cut : null
  }
  if (r.type === 'count') return rows >= r.value ? oldest : null
  return null
}

type RawDump = {
  at: string
  rows: { feed?: unknown; uri?: unknown; indexedAt?: unknown; handle?: unknown; text?: unknown; why?: unknown }[]
}

// Every dump written inside the window, newest first.
//
// Filtering by the stamp in the FILENAME is not an approximation: a purge can
// only remove a row that already exists, so any purge touching a post indexed
// inside the window necessarily ran inside the window too. That is what makes
// reading 24 h of dumps sufficient to account for every post missing from the
// last 24 h of the table.
const readDumps = (dir: string, from: string, notes: string[]): RawDump[] => {
  let names: string[]
  try {
    names = fs.readdirSync(dir)
  } catch (err: any) {
    notes.push(`Could not read ${dir}: ${String(err?.message ?? err)}`)
    return []
  }

  const candidates: { file: string; at: string }[] = []
  for (const name of names) {
    // Match first, touch second. This directory also holds the database, the
    // per-purge database snapshots and the avatar backups, and none of them
    // should ever be opened — or even stat'ed — by a status view.
    const m = name.match(DUMP_RE)
    if (!m) continue
    const at = stampToIso(m)
    if (at < from) continue
    candidates.push({ file: name, at })
  }
  candidates.sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0))

  if (candidates.length > MAX_EVENTS) {
    notes.push(
      `${candidates.length} purge dumps in the window; showing the ${MAX_EVENTS} most recent.`,
    )
    candidates.length = MAX_EVENTS
  }

  const out: RawDump[] = []
  for (const c of candidates) {
    const full = path.join(dir, c.file)
    try {
      const st = fs.statSync(full)
      if (st.size > MAX_DUMP_BYTES) {
        notes.push(`${c.file} is ${st.size} bytes — too large to read, skipped.`)
        continue
      }
      const parsed = JSON.parse(fs.readFileSync(full, 'utf8'))
      if (!Array.isArray(parsed)) {
        notes.push(`${c.file} is not a list of rows, skipped.`)
        continue
      }
      out.push({ at: c.at, rows: parsed })
    } catch (err: any) {
      // purgePosts writes the dump BEFORE it deletes, so a run killed at the
      // wrong moment can leave a half-written file. One bad dump must not cost
      // the whole view.
      notes.push(`${c.file} could not be read: ${String(err?.message ?? err)}`)
    }
  }
  return out
}

const str = (v: unknown): string => (typeof v === 'string' ? v : '')

// Sweeps the safety cap refused. These never produce a dump — nothing was
// deleted — so without this they are invisible to everything except the ntfy
// push, and they are the most interesting event auto-purge can produce.
const readWithheld = (dir: string, from: string, notes: string[]): WithheldEvent[] => {
  const full = path.join(dir, 'auto-purge-withheld.jsonl')
  let text: string
  try {
    const st = fs.statSync(full)
    if (st.size > MAX_WITHHELD_BYTES) {
      // Append-only and never rotated, so read the tail and drop the first
      // line, which the offset has probably cut in half.
      const fd = fs.openSync(full, 'r')
      try {
        const buf = Buffer.alloc(MAX_WITHHELD_BYTES)
        const read = fs.readSync(fd, buf, 0, MAX_WITHHELD_BYTES, st.size - MAX_WITHHELD_BYTES)
        text = buf.subarray(0, read).toString('utf8').replace(/^[^\n]*\n/, '')
      } finally {
        fs.closeSync(fd)
      }
    } else {
      text = fs.readFileSync(full, 'utf8')
    }
  } catch {
    // Absent is the normal case: it only exists once a sweep has been refused.
    return []
  }

  const out: WithheldEvent[] = []
  let bad = 0
  for (const line of text.split('\n')) {
    if (!line.trim()) continue
    try {
      const o = JSON.parse(line)
      const at = str(o.at)
      if (!at || at < from) continue
      out.push({
        at,
        mode: str(o.mode) || 'unknown',
        feed: str(o.feed),
        count: Number(o.count) || 0,
        stored: Number(o.stored) || 0,
        limit: Number(o.limit) || 0,
      })
    } catch {
      bad++
    }
  }
  if (bad) notes.push(`${bad} unreadable line(s) in auto-purge-withheld.jsonl.`)
  out.sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0))
  return out
}

export const collectActivity = async (
  db: Database,
  now: number = Date.now(),
): Promise<ActivitySnapshot> => {
  const hours = windowHours(now)
  const index = new Map(hours.map((h, i) => [h, i]))
  const from = hours[0] + ':00:00.000Z'
  const notes: string[] = []

  const stored = await sql<{ feed: string; hour: string; n: number }>`
    select feed, substr("indexedAt", 1, 13) as hour, count(*) as n
    from post
    where "indexedAt" >= ${from}
    group by feed, hour
  `.execute(db)

  const totals = await sql<{ feed: string; rows: number; oldest: string | null }>`
    select feed, count(*) as rows, min("indexedAt") as oldest
    from post
    group by feed
  `.execute(db)
  const totalByFeed = new Map(totals.rows.map((t) => [t.feed, t]))

  const dumps = readDumps(dataDir(), from, notes)

  // Every feed the config knows about, plus any the table holds rows for. A
  // feed that has been removed from the config but still has rows is exactly
  // the case worth showing rather than hiding.
  const keys = new Set<string>(getFeedKeys())
  stored.rows.forEach((r) => keys.add(r.feed))
  totals.rows.forEach((r) => keys.add(r.feed))
  dumps.forEach((d) => d.rows.forEach((r) => keys.add(str(r.feed))))
  keys.delete('')

  const feeds: ActivityFeed[] = [...keys].sort().map((key) => {
    const t = totalByFeed.get(key)
    return {
      key,
      stored: new Array(HOURS).fill(0),
      purged: new Array(HOURS).fill(0),
      floor: retentionFloor(key, Number(t?.rows ?? 0), t?.oldest ?? null, now),
    }
  })
  const byKey = new Map(feeds.map((f) => [f.key, f]))

  for (const r of stored.rows) {
    const f = byKey.get(r.feed)
    const i = index.get(r.hour)
    if (f && i !== undefined) f.stored[i] = Number(r.n)
  }

  const events: PurgeEvent[] = dumps.map((d) => {
    const perFeed = new Map<string, number>()
    const kinds: PurgeKind[] = []
    const rows: PurgedRow[] = []

    for (const raw of d.rows) {
      const feed = str(raw.feed)
      const indexedAt = str(raw.indexedAt)
      const why = str(raw.why)
      const kind = kindOf(why)
      kinds.push(kind)
      perFeed.set(feed, (perFeed.get(feed) ?? 0) + 1)

      // Bucketed from the WHOLE dump, not from the capped detail list below:
      // the bars must account for every removed post even when the list does
      // not name them all.
      const f = byKey.get(feed)
      const i = index.get(indexedAt.slice(0, 13))
      if (f && i !== undefined) f.purged[i] += 1

      if (rows.length < MAX_ROWS_PER_EVENT) {
        rows.push({
          feed,
          uri: str(raw.uri),
          handle: str(raw.handle),
          text: str(raw.text),
          why,
          indexedAt,
          kind,
        })
      }
    }

    return {
      at: d.at,
      kind: collapseKinds(kinds),
      total: d.rows.length,
      byFeed: [...perFeed.entries()]
        .map(([feed, count]) => ({ feed, count }))
        .sort((a, b) => b.count - a.count),
      rows,
      omitted: Math.max(0, d.rows.length - rows.length),
    }
  })

  return {
    generatedAt: new Date(now).toISOString(),
    hours,
    feeds,
    events,
    withheld: readWithheld(dataDir(), from, notes),
    notes,
  }
}
