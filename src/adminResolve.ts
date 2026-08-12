// Turning what you can copy out of a browser into what filters.json needs.
//
// A pin is an at:// URI, but nobody has one of those to hand — what you have is
// the bsky.app link you were just looking at, and that names the author by
// HANDLE while the URI needs a DID. Resolving it is a network call, and the
// page's Content-Security-Policy allows no external host, so the lookup has to
// happen here rather than in the browser.
//
// It also checks the post actually exists, because a well-formed URI pointing
// at a deleted post is dropped silently during hydration — no error, no log,
// the pin simply never appears.

const API = 'https://public.api.bsky.app'

const POST_URL =
  /^https?:\/\/bsky\.app\/profile\/([^/\s]+)\/post\/([A-Za-z0-9._:~-]+)/
const AT_URI = /^at:\/\/(did:[a-z0-9]+:[^/\s]+)\/app\.bsky\.feed\.post\/([^/\s]+)$/

const LIST_URL =
  /^https?:\/\/bsky\.app\/profile\/([^/\s]+)\/lists\/([A-Za-z0-9._:~-]+)/
const LIST_AT_URI =
  /^at:\/\/(did:[a-z0-9]+:[^/\s]+)\/app\.bsky\.graph\.list\/([^/\s]+)$/

export type ResolvedPost = {
  uri: string
  did: string
  handle: string
  text: string
  exists: boolean
}

export type ResolvedList = {
  uri: string
  did: string
  name: string
  purpose: string
  count: number
  exists: boolean
}

const resolveHandle = async (handle: string): Promise<string> => {
  const res = await fetch(
    `${API}/xrpc/com.atproto.identity.resolveHandle?handle=${encodeURIComponent(handle)}`,
  )
  if (!res.ok) throw new Error(`no account called "${handle}" (HTTP ${res.status})`)
  const { did } = (await res.json()) as any
  if (!did) throw new Error(`no account called "${handle}"`)
  return did
}

// Shared with the whyNot panel, which needs the URI but its own copy of the
// record, so the parsing lives in one place.
export const toAtUri = async (input: string): Promise<string> => {
  const raw = String(input ?? '').trim()
  if (!raw) throw new Error('nothing to resolve')

  const asUri = AT_URI.exec(raw)
  if (asUri) return `at://${asUri[1]}/app.bsky.feed.post/${asUri[2]}`

  const asUrl = POST_URL.exec(raw)
  if (!asUrl) {
    throw new Error(
      'paste a post link like https://bsky.app/profile/<handle>/post/<id>, ' +
        'or an at:// URI',
    )
  }
  const who = decodeURIComponent(asUrl[1])
  const did = who.startsWith('did:') ? who : await resolveHandle(who)
  return `at://${did}/app.bsky.feed.post/${asUrl[2]}`
}

// The same job for a moderation list, and it exists because the failure it
// prevents is silent. A bsky.app list link is what you have to hand; the config
// needs at://<did>/app.bsky.graph.list/<rkey>. Pasted unconverted, nothing
// complains — the config validates, the service starts, the log says "+ exclude
// list", and every account on that list keeps posting into the feed. That is exactly how a
// live feed lost its moderation list without anyone noticing.
export const toListAtUri = async (input: string): Promise<string> => {
  const raw = String(input ?? '').trim()
  if (!raw) throw new Error('nothing to resolve')

  const asUri = LIST_AT_URI.exec(raw)
  if (asUri) return `at://${asUri[1]}/app.bsky.graph.list/${asUri[2]}`

  const asUrl = LIST_URL.exec(raw)
  if (!asUrl) {
    throw new Error(
      'paste a list link like https://bsky.app/profile/<handle>/lists/<id>, ' +
        'or an at:// URI ending in /app.bsky.graph.list/<id>',
    )
  }
  const who = decodeURIComponent(asUrl[1])
  const did = who.startsWith('did:') ? who : await resolveHandle(who)
  return `at://${did}/app.bsky.graph.list/${asUrl[2]}`
}

export const resolveListRef = async (input: string): Promise<ResolvedList> => {
  const uri = await toListAtUri(input)
  const did = uri.slice('at://'.length).split('/')[0]
  const res = await fetch(
    `${API}/xrpc/app.bsky.graph.getList?list=${encodeURIComponent(uri)}&limit=1`,
  )
  // Same stance as a pin: report, do not throw. A list the operator is about to
  // create is a legitimate thing to save, and refusing it would be worse than
  // saying it is not there yet.
  if (!res.ok) {
    return { uri, did, name: '', purpose: '', count: 0, exists: false }
  }
  const { list } = (await res.json()) as any
  return {
    uri,
    did,
    name: list?.name ?? '',
    purpose: String(list?.purpose ?? '').replace(/^app\.bsky\.graph\.defs#/, ''),
    count: Number(list?.listItemCount ?? 0),
    exists: !!list,
  }
}

export const resolvePostRef = async (input: string): Promise<ResolvedPost> => {
  const uri = await toAtUri(input)
  const did = uri.slice('at://'.length).split('/')[0]
  const res = await fetch(`${API}/xrpc/app.bsky.feed.getPosts?uris=${encodeURIComponent(uri)}`)
  if (!res.ok) throw new Error(`could not check the post (HTTP ${res.status})`)
  const { posts } = (await res.json()) as any
  const found = (posts ?? [])[0]

  return {
    uri,
    did,
    handle: found?.author?.handle ?? '',
    text: (found?.record?.text ?? '').replace(/\s+/g, ' ').slice(0, 200),
    // Reported rather than thrown on: pinning a post that is gone is a mistake,
    // but so is refusing to save a URI the operator knows is right and is about
    // to publish. Say what is true and let them decide.
    exists: !!found,
  }
}
