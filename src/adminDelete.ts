import fs from 'node:fs'
import path from 'node:path'
import { Database } from './db'
import { toAtUri } from './adminResolve'
import { clearLabCache } from './adminLab'
import { getFeedKeys, getFeedConfig, loadFiltersOnce } from './filter'

// "I don't want to see this post in this feed" — resolve the link, look at what
// came back, then delete it.
//
// Everything else on this box decides what a feed holds by RULE: a pattern, a
// moderation list, a retention window. This is the one place that acts on a
// single post because someone looked at it and did not want it there, and it
// asks nothing about WHY — no filter to edit, no measurement to read, no
// reason to type.
//
// SCOPED TO ONE FEED, like every other control on that page. The feed comes
// from the "Editing feed" picker and is passed in; a post stored for four feeds
// is four rows, and this removes exactly one of them. Nothing here may reach
// past the feed on screen — the page has one selected feed and every button on
// it answers for that feed alone. The first version deleted from all of them at
// once, which is not a smaller version of this: it is a different, unasked-for
// operation wearing the same button.
//
// TWO STEPS, and the first one is the check. inspectPost() answers "what is at
// this link, and is it in THIS feed" without touching anything; deletePost()
// then removes exactly that row. The page resolves first and sends back the
// at:// URI it was shown, so what gets deleted is what was on screen — not
// whatever the field happens to contain a moment later. A confirmation dialog
// could not have offered that: it asks before there is anything to look at.
//
// Two more decisions worth knowing about:
//
//   * it leaves a dump next to the database, exactly like purgePosts --uri, so
//     the removal shows up on the Activity tab instead of being the one kind of
//     removal with no trail;
//   * it does NOT stop the post coming back. Nothing re-reads old posts, so in
//     practice it stays gone — but a cursor rewind replays the firehose, and a
//     replayed post is matched again from scratch. A post that must never come
//     back is a filter or a moderation-list job.

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
  // in this database still has to be removable.
  exists: boolean
  // The feed this answer is about — the one selected in the picker.
  feed: string
  displayName: string | null
  // Is it in THAT feed right now. The only thing the button acts on.
  stored: boolean
  indexedAt: string | null
  // Other feeds on this box holding the same post, named so the answer cannot
  // be mistaken for a box-wide one — and explicitly NOT touched. Switch the
  // picker and delete it there too if that is what you want.
  alsoIn: string[]
  // Does THIS feed pin it. Deleting the row does not un-pin it: the pin is
  // config, hydrated on every request, so the post would keep appearing at the
  // top of the feed and the button would look broken.
  pinnedHere: boolean
}

export type DeleteResult = PostTarget & {
  removed: number
  dump: string | null
}

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
    // A dump that cannot be written must not cancel the deletion. The operator
    // asked for the post to go; losing the audit line is the smaller failure,
    // and it is in the log.
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

// Step one: what is at this link, and is it in the selected feed. Reads only —
// nothing here changes anything, which is what makes it safe to run on a blur.
export const inspectPost = async (
  db: Database,
  feed: string,
  input: string,
): Promise<PostTarget> => {
  if (getFeedKeys().length === 0) loadFiltersOnce()
  const cfg = getFeedConfig(feed)
  if (!cfg) throw new Error(`feed "${feed}" is not in the live config`)

  const uri = await toAtUri(input)

  const rows = await db
    .selectFrom('post')
    .select(['feed', 'indexedAt'])
    .where('uri', '=', uri)
    .execute()
  const here = rows.find((r) => r.feed === feed)

  const { handle, text, exists } = await describe(uri)
  return {
    uri,
    handle,
    text,
    exists,
    feed,
    displayName: cfg.displayName ?? null,
    stored: !!here,
    indexedAt: here?.indexedAt ?? null,
    alsoIn: rows
      .filter((r) => r.feed !== feed)
      .map((r) => getFeedConfig(r.feed)?.displayName ?? r.feed),
    pinnedHere: cfg.pinnedPost === uri,
  }
}

// Step two. Takes the same input as step one and inspects again rather than
// trusting anything the caller carried over: the row may have gone (retention
// prunes, auto-purge sweeps) between the two presses, and the answer has to
// describe what actually happened, not what was predicted.
export const deletePost = async (
  db: Database,
  feed: string,
  input: string,
): Promise<DeleteResult> => {
  const target = await inspectPost(db, feed, input)

  if (!target.stored) {
    return { ...target, removed: 0, dump: null }
  }

  // The dump is written BEFORE the delete, so a crash between the two leaves a
  // record of something that is still there rather than no record of something
  // that is gone. `why` is one of the strings adminActivity reads as a manual
  // removal — keep the two in step.
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

  // `and feed = ?` is the whole scoping rule in one line. Without it this
  // deletes the post from every feed on the box.
  await db
    .deleteFrom('post')
    .where('uri', '=', target.uri)
    .where('feed', '=', feed)
    .execute()

  // The lab keeps a hydrated corpus per feed for ten minutes. Left alone, the
  // next "Count matches" would count a post that no longer exists.
  clearLabCache()

  console.log(`admin: deleted ${target.uri} from ${feed}`)
  return { ...target, removed: 1, dump }
}
