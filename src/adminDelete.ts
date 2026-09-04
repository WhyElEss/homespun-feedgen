import fs from 'node:fs'
import path from 'node:path'
import { Database } from './db'
import { toAtUri } from './adminResolve'
import { clearLabCache } from './adminLab'
import { getFeedKeys, getFeedConfig, loadFiltersOnce } from './filter'

// "I don't want to see this post" — one link, one button, gone.
//
// Everything else on this box decides what a feed holds by RULE: a pattern, a
// moderation list, a retention window. This is the one place that acts on a
// single post because someone looked at it and did not want it there, and it
// deliberately asks no further questions — no filter to edit, no measurement to
// read, no reason to type.
//
// Three decisions worth knowing about:
//
//   * it removes the post from EVERY feed on this box, not from the feed the
//     page happens to have open. The object here is the post, not one feed's
//     copy of it, and "gone from three of the four" is not what anyone means by
//     delete. Which feeds it left is in the answer;
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

export type DeletedFrom = {
  key: string
  displayName: string | null
  indexedAt: string
}

export type DeleteResult = {
  uri: string
  handle: string
  text: string
  removed: number
  feeds: DeletedFrom[]
  // Feeds that pin this post. Deleting the row does not un-pin it: the pin is
  // config, hydrated on every request, so the post would keep appearing at the
  // top of that feed and the button would look broken.
  pinnedOn: string[]
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

// Best effort, and it must stay that way: the usual reason to delete a post is
// that it is objectionable, and the usual state of an objectionable post an
// hour later is deleted upstream. A row that the AppView will not return still
// has to be removable.
const describe = async (uri: string): Promise<{ handle: string; text: string }> => {
  try {
    const res = await fetch(
      `${API}/xrpc/app.bsky.feed.getPosts?uris=${encodeURIComponent(uri)}`,
    )
    if (!res.ok) return { handle: '', text: '' }
    const p = ((await res.json()) as any).posts?.[0]
    if (!p) return { handle: '', text: '' }
    return {
      handle: p.author?.handle ?? '',
      text: String(p.record?.text ?? '').replace(/\s+/g, ' '),
    }
  } catch {
    return { handle: '', text: '' }
  }
}

export const deletePost = async (
  db: Database,
  input: string,
): Promise<DeleteResult> => {
  const uri = await toAtUri(input)

  if (getFeedKeys().length === 0) loadFiltersOnce()
  const pinnedOn = getFeedKeys().filter((k) => getFeedConfig(k)?.pinnedPost === uri)

  const rows = await db
    .selectFrom('post')
    .select(['feed', 'indexedAt'])
    .where('uri', '=', uri)
    .execute()

  const { handle, text } = await describe(uri)

  if (!rows.length) {
    return { uri, handle, text, removed: 0, feeds: [], pinnedOn, dump: null }
  }

  // The dump is written BEFORE the delete, so a crash between the two leaves a
  // record of something that is still there rather than no record of something
  // that is gone. `why` is one of the strings adminActivity reads as a manual
  // removal — keep the two in step.
  const dump = writeDump(
    rows.map((r) => ({
      uri,
      indexedAt: r.indexedAt,
      feed: r.feed,
      handle: handle || '(not retrievable)',
      text: text.slice(0, 80),
      why: 'deleted by hand',
    })),
  )

  await db.deleteFrom('post').where('uri', '=', uri).execute()

  // The lab keeps a hydrated corpus per feed for ten minutes. Left alone, the
  // next "Count matches" would count a post that no longer exists.
  clearLabCache()

  const feeds: DeletedFrom[] = rows.map((r) => ({
    key: r.feed,
    displayName: getFeedConfig(r.feed)?.displayName ?? null,
    indexedAt: r.indexedAt,
  }))
  console.log(`admin: deleted ${uri} from ${feeds.map((f) => f.key).join(', ')}`)
  return { uri, handle, text, removed: rows.length, feeds, pinnedOn, dump }
}
