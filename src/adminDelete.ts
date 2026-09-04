import fs from 'node:fs'
import path from 'node:path'
import { Database } from './db'
import { toAtUri } from './adminResolve'
import { clearLabCache } from './adminLab'
import { getFeedKeys, getFeedConfig, loadFiltersOnce } from './filter'

// "I don't want this post in this feed" — resolve the link, check it is the
// right one, delete it.
//
// Scoped to the feed the page has open, like every control on that page. The
// feed is passed in; the row it removes is that feed's copy and nothing else.
// Whether other feeds hold the same post is not this button's business and is
// deliberately not reported — the whyNot panel answers that question, per feed,
// for anyone who wants it.
//
// Two steps: inspectPost() says what is at the link without touching anything,
// deletePost() removes the row. The page resolves first and sends back the
// at:// URI it was shown, so what gets deleted is what was on screen.
//
// It leaves a dump next to the database, exactly like purgePosts --uri, so the
// removal shows up on the Activity tab rather than being the one kind of
// removal with no trail.

const API = 'https://public.api.bsky.app'

// Read per request, never captured at module load — the import runs before
// anything a caller sets. The same trap admin.ts documents for the filters path.
const dbPath = () => process.env.FEEDGEN_SQLITE_LOCATION ?? '/data/db.sqlite'

export type PostTarget = {
  uri: string
  handle: string
  text: string
  // Whether the AppView still has it. False is not a refusal: the usual state
  // of a post worth deleting, an hour later, is deleted upstream, and the row
  // in this feed still has to be removable.
  exists: boolean
  feed: string
  // Is it in that feed right now. The only thing the button acts on.
  stored: boolean
  indexedAt: string | null
  // Does this feed pin it. Deleting the row does not un-pin it — the pin is
  // config, hydrated on every request — so the post would stay at the top of
  // the feed and the button would look broken.
  pinnedHere: boolean
}

export type DeleteResult = PostTarget & { removed: number; dump: string | null }

// The dumps auto-purge and purgePosts write, so the Activity tab can read this
// one the same way. Second precision, and a same-second collision with a sweep
// MERGES rather than overwrites: two removals in one second are two events, and
// the file name is the only clock either of them has.
const writeDump = (rows: unknown[]): string | null => {
  const dir = path.dirname(dbPath())
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z')
  const file = path.join(dir, `purged-${stamp}.json`)
  try {
    let all = rows
    if (fs.existsSync(file)) {
      const prev = JSON.parse(fs.readFileSync(file, 'utf8'))
      if (Array.isArray(prev)) all = [...prev, ...rows]
    }
    fs.writeFileSync(file, JSON.stringify(all, null, 2))
    return file
  } catch (err: any) {
    // A dump that cannot be written must not cancel the deletion: the operator
    // asked for the post to go, and losing the audit line is the smaller
    // failure. It is in the log.
    console.warn(`admin: could not write ${file}: ${String(err?.message ?? err)}`)
    return null
  }
}

// Best effort, and it must stay that way — see `exists` above.
const describe = async (
  uri: string,
): Promise<{ handle: string; text: string; exists: boolean }> => {
  try {
    const res = await fetch(
      `${API}/xrpc/app.bsky.feed.getPosts?uris=${encodeURIComponent(uri)}`,
    )
    if (!res.ok) return { handle: '', text: '', exists: false }
    const p = ((await res.json()) as any).posts?.[0]
    if (!p) return { handle: '', text: '', exists: false }
    return {
      handle: p.author?.handle ?? '',
      text: String(p.record?.text ?? '').replace(/\s+/g, ' '),
      exists: true,
    }
  } catch {
    return { handle: '', text: '', exists: false }
  }
}

// Step one. Reads only, which is what makes it safe to run on a blur.
export const inspectPost = async (
  db: Database,
  feed: string,
  input: string,
): Promise<PostTarget> => {
  if (getFeedKeys().length === 0) loadFiltersOnce()
  const cfg = getFeedConfig(feed)
  if (!cfg) throw new Error(`feed "${feed}" is not in the live config`)

  const uri = await toAtUri(input)
  const row = await db
    .selectFrom('post')
    .select(['indexedAt'])
    .where('uri', '=', uri)
    .where('feed', '=', feed)
    .executeTakeFirst()

  const { handle, text, exists } = await describe(uri)
  return {
    uri,
    handle,
    text,
    exists,
    feed,
    stored: !!row,
    indexedAt: row?.indexedAt ?? null,
    pinnedHere: cfg.pinnedPost === uri,
  }
}

// Step two. Inspects again rather than trusting anything carried over: the row
// may have gone (retention prunes, auto-purge sweeps) between the two presses,
// and the answer has to describe what happened, not what was predicted.
export const deletePost = async (
  db: Database,
  feed: string,
  input: string,
): Promise<DeleteResult> => {
  const target = await inspectPost(db, feed, input)
  if (!target.stored) return { ...target, removed: 0, dump: null }

  // Written BEFORE the delete, so a crash between the two leaves a record of
  // something still there rather than no record of something gone. `why` is one
  // of the strings adminActivity reads as a manual removal — keep them in step.
  const dump = writeDump([
    {
      uri: target.uri,
      indexedAt: target.indexedAt,
      feed: target.feed,
      handle: target.handle || '(not retrievable)',
      text: target.text.slice(0, 80),
      why: 'deleted by hand',
    },
  ])

  // `and feed = ?` is the scoping rule. Without it this deletes the post from
  // every feed on the box.
  await db
    .deleteFrom('post')
    .where('uri', '=', target.uri)
    .where('feed', '=', feed)
    .execute()

  // The lab keeps a hydrated corpus per feed for ten minutes; left alone, the
  // next "Count matches" would count a post that no longer exists.
  clearLabCache()

  console.log(`admin: deleted ${target.uri} from ${feed}`)
  return { ...target, removed: 1, dump }
}
