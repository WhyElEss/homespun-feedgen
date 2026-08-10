import fs from 'node:fs'

// Feed matching logic for every feed this instance serves. The configs live
// in /data/filters.json (mounted to ./data on the host) and are hot-reloaded:
// edit the file and the running service picks it up within ~10 seconds, no
// rebuild or restart. A broken edit (invalid JSON or regex) is rejected as a
// whole — the service keeps the previous config and logs the error.
//
// Shape:
//   { "feeds": { "<rkey>": { …config… }, … } }
// The rkey is the feed's record key, which must equal the algo shortname.
//
// SkyFeed semantics preserved (ported from the skyfeedBuilder blocks that
// were public in each feed's app.bsky.feed.generator record):
//   - a feed matches by text patterns, by author DID, or by both
//   - each pattern declares which fields it looks at (`target`)
//   - replies are always dropped, matching the "remove reply" block every
//     one of these feeds had; reposts need no code (different collection,
//     never indexed); "remove by list" is handled in subscription.ts via
//     each feed's excludeListUri.

const FILTERS_PATH = process.env.FEEDGEN_FILTERS_PATH ?? '/data/filters.json'
const RELOAD_CHECK_INTERVAL_MS = 10_000

// Which fields a pattern is tested against. Mirrors SkyFeed's block targets.
type Target = 'text' | 'text|alt_text' | 'text|alt_text|link'
const TARGETS: Target[] = ['text', 'text|alt_text', 'text|alt_text|link']

const DEFAULT_INCLUDE_TARGET: Target = 'text|alt_text'
const DEFAULT_EXCLUDE_TARGET: Target = 'text|alt_text|link'

type RawPattern = {
  pattern: string
  flags?: string
  comment?: string
  target?: Target
}

// allow  — no effect; exclude — such posts never enter the feed;
// only   — ONLY such posts enter the feed
type ToggleMode = 'allow' | 'exclude' | 'only'
const TOGGLE_MODES: ToggleMode[] = ['allow', 'exclude', 'only']

// hours — drop posts older than N hours; count — keep the newest N posts.
export type Retention =
  | { type: 'hours'; value: number }
  | { type: 'count'; value: number }

const DEFAULT_RETENTION: Retention = { type: 'hours', value: 72 }

// A pinned post is named by its at:// URI. Checked here rather than at request
// time so a typo is reported on save, in the same reload that would apply it.
const POST_URI_RE =
  /^at:\/\/did:[a-z0-9]+:[^/\s]+\/app\.bsky\.feed\.post\/[^/\s]+$/

type RawFeed = {
  displayName?: string
  includePatterns?: RawPattern[]
  excludePatterns?: RawPattern[]
  includeDids?: string[]
  excludeListUri?: string
  pinnedPost?: string
  gifPosts?: ToggleMode
  quotePosts?: ToggleMode
  selfLabeledPosts?: ToggleMode
  bridgedPosts?: ToggleMode
  retention?: Retention
}

type RawFilters = {
  feeds?: Record<string, RawFeed>
} & RawFeed // legacy single-feed shape, see compileLegacy()

// The comment travels with the compiled pattern so a verdict can name the RULE
// that fired ("automated reposters and tag-spam") instead of quoting the first
// sixty characters of its expression at whoever is reading.
type CompiledPattern = { re: RegExp; target: Target; comment?: string }

export type FeedConfig = {
  key: string
  displayName?: string
  include: CompiledPattern[]
  exclude: CompiledPattern[]
  includeDids: Set<string>
  excludeListUri?: string
  pinnedPost?: string
  gifPosts: ToggleMode
  quotePosts: ToggleMode
  selfLabeledPosts: ToggleMode
  bridgedPosts: ToggleMode
  retention: Retention
}

// Before multi-feed support this service ran one feed, named by
// FEEDGEN_SHORTNAME. That variable is no longer used for routing — feeds now
// come from filters.json — but it still names the feed a legacy-shaped
// filters.json describes, so an old config keeps working.
const LEGACY_FEED_KEY = process.env.FEEDGEN_SHORTNAME ?? 'my-feed'

let current: Map<string, FeedConfig> | undefined
// Feeds registered at startup. A hot reload cannot add a feed (its algo would
// not be routed), so we warn instead of silently accepting one.
let registeredKeys: Set<string> | undefined

const compilePattern = (
  p: RawPattern,
  where: string,
  i: number,
  defaultTarget: Target,
): CompiledPattern => {
  if (typeof p.pattern !== 'string') {
    throw new Error(`${where}[${i}]: "pattern" must be a string`)
  }
  const target = p.target ?? defaultTarget
  if (!TARGETS.includes(target)) {
    throw new Error(
      `${where}[${i}]: "target" must be one of ${TARGETS.join(' | ')}`,
    )
  }
  try {
    // g and y are stripped. Both make RegExp.test STATEFUL — it resumes from
    // lastIndex, so the same pattern against the same text alternates between
    // hit and miss on successive calls. The lab has always stripped them; the
    // ingest path had not, so a config that used one would have dropped posts
    // at random. No live config does, which is exactly why it would have been
    // found the hard way.
    const flags = (p.flags ?? 'iu').replace(/[gy]/g, '')
    return { re: new RegExp(p.pattern, flags), target, comment: p.comment }
  } catch (err) {
    throw new Error(`${where}[${i}] (${p.comment ?? 'no comment'}): ${err}`)
  }
}

const compileToggle = (
  value: ToggleMode | undefined,
  name: string,
  fallback: ToggleMode,
): ToggleMode => {
  if (value === undefined) return fallback
  if (!TOGGLE_MODES.includes(value)) {
    throw new Error(`${name}: must be one of ${TOGGLE_MODES.join(' | ')}`)
  }
  return value
}

const compileRetention = (
  value: Retention | undefined,
  where: string,
): Retention => {
  if (value === undefined) return DEFAULT_RETENTION
  if (value.type !== 'hours' && value.type !== 'count') {
    throw new Error(`${where}.retention.type: must be "hours" or "count"`)
  }
  if (!Number.isInteger(value.value) || value.value <= 0) {
    throw new Error(`${where}.retention.value: must be a positive integer`)
  }
  return { type: value.type, value: value.value }
}

const compilePinnedPost = (
  value: string | undefined,
  where: string,
): string | undefined => {
  if (value === undefined) return undefined
  if (typeof value !== 'string' || !POST_URI_RE.test(value)) {
    throw new Error(
      `${where}.pinnedPost: must be a post URI like ` +
        `at://did:plc:xxxx/app.bsky.feed.post/yyyy (got ${JSON.stringify(value)})`,
    )
  }
  return value
}

const compileFeed = (key: string, raw: RawFeed): FeedConfig => {
  const where = `feeds["${key}"]`
  const includeRaw = raw.includePatterns ?? []
  const excludeRaw = raw.excludePatterns ?? []
  const didsRaw = raw.includeDids ?? []

  if (!Array.isArray(includeRaw) || !Array.isArray(excludeRaw)) {
    throw new Error(`${where}: includePatterns / excludePatterns must be arrays`)
  }
  if (!Array.isArray(didsRaw)) {
    throw new Error(`${where}: includeDids must be an array`)
  }
  for (const did of didsRaw) {
    if (typeof did !== 'string' || !did.startsWith('did:')) {
      throw new Error(`${where}.includeDids: "${did}" is not a DID`)
    }
  }
  // A feed with no positive criterion at all would match every post on the
  // network. Refuse it rather than flood the feed.
  if (includeRaw.length === 0 && didsRaw.length === 0) {
    throw new Error(
      `${where}: needs at least one includePattern or one includeDid — ` +
        `a feed with neither would match the entire firehose`,
    )
  }

  return {
    key,
    displayName: raw.displayName,
    include: includeRaw.map((p, i) =>
      compilePattern(p, `${where}.includePatterns`, i, DEFAULT_INCLUDE_TARGET),
    ),
    exclude: excludeRaw.map((p, i) =>
      compilePattern(p, `${where}.excludePatterns`, i, DEFAULT_EXCLUDE_TARGET),
    ),
    includeDids: new Set(didsRaw),
    excludeListUri: raw.excludeListUri,
    pinnedPost: compilePinnedPost(raw.pinnedPost, where),
    gifPosts: compileToggle(raw.gifPosts, `${where}.gifPosts`, 'allow'),
    quotePosts: compileToggle(raw.quotePosts, `${where}.quotePosts`, 'allow'),
    // Defaults to exclude: that is what this service has always done, and
    // letting self-labeled (adult) posts through is not a change to make
    // silently. Set "allow" per feed to match SkyFeed's behaviour exactly.
    selfLabeledPosts: compileToggle(
      raw.selfLabeledPosts,
      `${where}.selfLabeledPosts`,
      'exclude',
    ),
    // Defaults to allow, like gifPosts and quotePosts: a feed that says
    // nothing about bridged posts keeps taking them. "exclude" drops every
    // post federated in from the fediverse (Mastodon and the rest) by Bridgy
    // Fed; "only" makes a feed of nothing else.
    bridgedPosts: compileToggle(
      raw.bridgedPosts,
      `${where}.bridgedPosts`,
      'allow',
    ),
    retention: compileRetention(raw.retention, where),
  }
}

const compile = (raw: RawFilters): Map<string, FeedConfig> => {
  // Legacy single-feed shape (no "feeds" key, patterns at the top level).
  // Accepted so that restoring an old filters.json without restoring the old
  // code still starts up.
  if (!raw.feeds) {
    if (!raw.includePatterns) {
      throw new Error('filters.json: missing "feeds" object')
    }
    console.warn(
      `filters: legacy single-feed config detected — treating it as feed "${LEGACY_FEED_KEY}"`,
    )
    return new Map([[LEGACY_FEED_KEY, compileFeed(LEGACY_FEED_KEY, raw)]])
  }

  if (typeof raw.feeds !== 'object' || Array.isArray(raw.feeds)) {
    throw new Error('filters.json: "feeds" must be an object keyed by rkey')
  }
  const keys = Object.keys(raw.feeds)
  if (keys.length === 0) throw new Error('filters.json: "feeds" is empty')

  const out = new Map<string, FeedConfig>()
  for (const key of keys) {
    out.set(key, compileFeed(key, raw.feeds[key]))
  }
  return out
}

// Check a candidate config without touching the live one. Everything that
// validates a filters.json already lives in compile(); the only way to reach it
// used to be loadFilters(), which reads a fixed path AND installs the result —
// so the only way to find out whether an edit was valid was to write it to disk
// and watch the log. Anything editing the config from outside (an admin UI, a
// pre-commit check) wants to ask first. Throws the same path-qualified errors,
// e.g. `feeds["abc"].includePatterns[2]: invalid regex`.
export const validateFilters = (raw: unknown): Map<string, FeedConfig> =>
  compile(raw as RawFilters)

// Persist a config safely. Two properties matter to anything that writes this
// file from outside:
//   * it is validated first, so a config the service could not load never
//     reaches disk;
//   * it is written to a temporary file in the same directory and renamed,
//     which is atomic on POSIX — the watcher (and any concurrent reader) sees
//     either the old file or the new one, never a half-written one.
// Editing by hand is forgiving because a torn read merely fails the reload and
// the previous config is kept; a UI saving on every keystroke is not.
export const writeFilters = (raw: unknown, path: string = FILTERS_PATH): void => {
  validateFilters(raw)
  const tmp = `${path}.tmp-${process.pid}`
  fs.writeFileSync(tmp, JSON.stringify(raw, null, 2) + '\n')
  fs.renameSync(tmp, path)
}

export const loadFilters = (): void => {
  const raw = JSON.parse(fs.readFileSync(FILTERS_PATH, 'utf8')) as RawFilters
  const compiled = compile(raw)

  if (registeredKeys) {
    for (const key of compiled.keys()) {
      if (!registeredKeys.has(key)) {
        console.warn(
          `filters: feed "${key}" appeared in the config but has no route — ` +
            `restart the service to serve it`,
        )
      }
    }
    for (const key of registeredKeys) {
      if (!compiled.has(key)) {
        console.warn(
          `filters: feed "${key}" is routed but missing from the config — ` +
            `it will match nothing until the config is fixed`,
        )
      }
    }
  }

  current = compiled
  for (const cfg of compiled.values()) {
    console.log(
      `filters: ${cfg.key}${cfg.displayName ? ` (${cfg.displayName})` : ''} — ` +
        `${cfg.include.length} include / ${cfg.exclude.length} exclude patterns, ` +
        `${cfg.includeDids.size} author DIDs, ` +
        `retention ${cfg.retention.value} ${cfg.retention.type}` +
        (cfg.excludeListUri ? ', + exclude list' : '') +
        (cfg.pinnedPost ? `, pinned ${cfg.pinnedPost}` : ''),
    )
  }
}

// Initial load throws (bad config at startup should fail loudly); later
// reloads only log and keep the previous config.
export const watchFilters = (): void => {
  loadFilters()
  // Whatever loaded first defines the routable set for this process.
  registeredKeys = new Set(current!.keys())
  fs.watchFile(FILTERS_PATH, { interval: RELOAD_CHECK_INTERVAL_MS }, () => {
    try {
      loadFilters()
    } catch (err) {
      console.error('filters: reload failed — keeping previous config:', err)
    }
  })
}

// Reads the config without installing the watcher. For one-shot scripts.
export const loadFiltersOnce = (): Map<string, FeedConfig> => {
  loadFilters()
  return current!
}

export const getFeedKeys = (): string[] => [...(current?.keys() ?? [])]

export const getFeedConfig = (key: string): FeedConfig | undefined =>
  current?.get(key)

// feed key -> moderation list URI, for the feeds that declare one
export const getExcludeListUris = (): Map<string, string> => {
  const out = new Map<string, string>()
  for (const cfg of current?.values() ?? []) {
    if (cfg.excludeListUri) out.set(cfg.key, cfg.excludeListUri)
  }
  return out
}

export const getRetentions = (): Map<string, Retention> => {
  const out = new Map<string, Retention>()
  for (const cfg of current?.values() ?? []) out.set(cfg.key, cfg.retention)
  return out
}

type ExternalCard = { uri?: string; title?: string; description?: string }
type ImageWithAlt = { alt?: string }

export type MatchablePost = {
  text?: string
  reply?: unknown
  labels?: { values?: { val?: string }[] }
  // Bridgy Fed stamps every record it creates with these two non-lexicon
  // fields. They are the only reliable mark of a bridged post: the handle is
  // not available to the filter at all, and even where it is, a bridge whose
  // handle fails to resolve shows up as "handle.invalid" rather than as
  // "<user>.<instance>.ap.brid.gy".
  bridgyOriginalUrl?: string
  bridgyOriginalText?: string
  facets?: { features?: { $type?: string; uri?: string }[] }[]
  embed?: {
    $type?: string
    external?: ExternalCard // app.bsky.embed.external
    images?: ImageWithAlt[] // app.bsky.embed.images
    alt?: string // app.bsky.embed.video
    media?: {
      // app.bsky.embed.recordWithMedia
      external?: ExternalCard
      images?: ImageWithAlt[]
      alt?: string
    }
  }
}

const altTexts = (record: MatchablePost): string[] => {
  const images = record.embed?.images ?? record.embed?.media?.images ?? []
  const parts = images.map((img) => img.alt ?? '')
  const videoAlt = record.embed?.alt ?? record.embed?.media?.alt
  if (videoAlt) parts.push(videoAlt)
  return parts
}

const linkStrings = (record: MatchablePost): string[] => {
  const parts: string[] = []
  const ext = record.embed?.external ?? record.embed?.media?.external
  if (ext) parts.push(ext.uri ?? '', ext.title ?? '', ext.description ?? '')
  for (const facet of record.facets ?? []) {
    for (const feature of facet.features ?? []) {
      if (feature.$type === 'app.bsky.richtext.facet#link' && feature.uri) {
        parts.push(feature.uri)
      }
    }
  }
  return parts
}

// The three haystacks a pattern can be tested against, built once per post.
export type Haystacks = Record<Target, string>

export const buildHaystacks = (record: MatchablePost): Haystacks => {
  const text = record.text ?? ''
  const withAlt = [text, ...altTexts(record)].join('\n')
  return {
    text,
    'text|alt_text': withAlt,
    'text|alt_text|link': [withAlt, ...linkStrings(record)].join('\n'),
  }
}

// Bluesky GIFs are external embeds pointing at Tenor (or a bare .gif URL)
const isGifPost = (record: MatchablePost): boolean => {
  const uri =
    record.embed?.external?.uri ?? record.embed?.media?.external?.uri ?? ''
  return /\.gif(?:$|\?)/i.test(uri) || /(?:^|\.)tenor\.com\//i.test(uri)
}

const isQuotePost = (record: MatchablePost): boolean =>
  record.embed?.$type === 'app.bsky.embed.record' ||
  record.embed?.$type === 'app.bsky.embed.recordWithMedia'

// A post federated in from the fediverse by Bridgy Fed. Detected on the record
// rather than on the author, which is what makes it reliable: the ingest never
// sees a handle (buildHaystacks has no access to one), the account's DID is an
// ordinary did:plc with nothing to match on, and the giveaway that IS in the
// DID document — the PDS atproto.brid.gy — would cost a network lookup per
// post. bridgyOriginalUrl travels inside the record itself, so this is free.
const isBridgedPost = (record: MatchablePost): boolean =>
  typeof record.bridgyOriginalUrl === 'string' ||
  typeof record.bridgyOriginalText === 'string'

const isSelfLabeled = (record: MatchablePost): boolean =>
  (record.labels?.values?.length ?? 0) > 0

const applyToggle = (mode: ToggleMode, is: boolean): boolean => {
  if (mode === 'exclude' && is) return false
  if (mode === 'only' && !is) return false
  return true
}

// Why a post did not land in a feed. Used by scripts/whyNot.ts and the admin
// page's whyNot panel.
//
// The structured fields exist because `reason` alone was not an answer. It
// reported the first sixty characters of the EXPRESSION that fired, and the
// expressions here are alternations of dozens of tokens — so the verdict on a
// dropped post read "excluded by /\b(?:animation|3Dprint\w*|3Dmodel\w*|…/",
// which says one of forty things matched without saying which. The include
// side had reported its matched text all along; only the exclude side did not.
export type MatchVerdict = {
  matched: boolean
  reason?: string
  excludeMatch?: string
  excludeComment?: string
  excludeTarget?: string
  // Only so a caller can identify a pattern that has no comment. With one, the
  // comment IS the identifier — it titles the block in the editor.
  excludePattern?: string
}

export const matchesFeedVerbose = (
  cfg: FeedConfig,
  record: MatchablePost,
  authorDid: string,
  hay: Haystacks = buildHaystacks(record),
): MatchVerdict => {
  // SkyFeed "remove reply" block — present on every feed we serve
  if (record.reply) return { matched: false, reason: 'is a reply' }
  if (!applyToggle(cfg.selfLabeledPosts, isSelfLabeled(record))) {
    return { matched: false, reason: `selfLabeledPosts=${cfg.selfLabeledPosts}` }
  }
  if (!applyToggle(cfg.gifPosts, isGifPost(record))) {
    return { matched: false, reason: `gifPosts=${cfg.gifPosts}` }
  }
  if (!applyToggle(cfg.quotePosts, isQuotePost(record))) {
    return { matched: false, reason: `quotePosts=${cfg.quotePosts}` }
  }
  if (!applyToggle(cfg.bridgedPosts, isBridgedPost(record))) {
    return {
      matched: false,
      reason:
        `bridgedPosts=${cfg.bridgedPosts}` +
        (record.bridgyOriginalUrl ? ` (${record.bridgyOriginalUrl})` : ''),
    }
  }

  // Author gate (SkyFeed "did" input block)
  if (cfg.includeDids.size > 0 && !cfg.includeDids.has(authorDid)) {
    return { matched: false, reason: `author ${authorDid} not in includeDids` }
  }

  // Text gate. A DID-only feed has no include patterns and skips this.
  if (cfg.include.length > 0) {
    if (!hay['text|alt_text|link'].trim()) {
      return { matched: false, reason: 'post has no text, alt text or links' }
    }
    const hit = cfg.include.find((p) => p.re.test(hay[p.target]))
    if (!hit) return { matched: false, reason: 'no includePattern matched' }
  }

  const blocked = cfg.exclude.find((p) => p.re.test(hay[p.target]))
  if (blocked) {
    const hit = hay[blocked.target].match(blocked.re)?.[0] ?? ''
    const rule = blocked.comment ? ` (${blocked.comment})` : ''
    return {
      matched: false,
      // Matched text first, because that is the answer to the question being
      // asked. The expression stays after it: `purgePosts --rejected --reason
      // <substring>` narrows by matching against this string, and the fragment
      // an operator reaches for is a piece of the pattern they just edited.
      reason:
        `excluded by "${hit}"${rule} — ` +
        `/${blocked.re.source.slice(0, 60)}…/ on ${blocked.target}`,
      excludeMatch: hit,
      excludeComment: blocked.comment,
      excludeTarget: blocked.target,
      excludePattern: blocked.re.source.slice(0, 60),
    }
  }

  return { matched: true }
}

// Every feed this post belongs to. One pass over the shared haystacks.
export const matchingFeeds = (
  record: MatchablePost,
  authorDid: string,
): string[] => {
  if (!current) return []
  const hay = buildHaystacks(record)
  const out: string[] = []
  for (const cfg of current.values()) {
    if (matchesFeedVerbose(cfg, record, authorDid, hay).matched) out.push(cfg.key)
  }
  return out
}
