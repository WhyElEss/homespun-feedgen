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

export type ResolvedPost = {
  uri: string
  did: string
  handle: string
  text: string
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

export const resolvePostRef = async (input: string): Promise<ResolvedPost> => {
  const raw = String(input ?? '').trim()
  if (!raw) throw new Error('nothing to resolve')

  let did: string
  let rkey: string

  const asUri = AT_URI.exec(raw)
  const asUrl = POST_URL.exec(raw)
  if (asUri) {
    did = asUri[1]
    rkey = asUri[2]
  } else if (asUrl) {
    const who = decodeURIComponent(asUrl[1])
    did = who.startsWith('did:') ? who : await resolveHandle(who)
    rkey = asUrl[2]
  } else {
    throw new Error(
      'paste a post link like https://bsky.app/profile/<handle>/post/<id>, ' +
        'or an at:// URI',
    )
  }

  const uri = `at://${did}/app.bsky.feed.post/${rkey}`
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
