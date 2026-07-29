import fs from 'node:fs'

// Feed matching logic. The patterns themselves live in /data/filters.json
// (mounted to ./data on the host) and are hot-reloaded: edit the file and
// the running service picks it up within ~10 seconds, no rebuild or restart.
// A broken edit (invalid JSON or regex) is rejected as a whole — the service
// keeps the previous config and logs the error.
//
// Matching semantics (SkyFeed-compatible, useful when migrating from there):
//   - include patterns match text|alt_text
//   - exclude patterns match text|alt_text|link (external card + facet URIs)
//   - replies and self-labeled posts are dropped; reposts need no code
//     (different collection, never indexed); list-based exclusion is
//     handled in subscription.ts via excludeListUri from the same file.

const FILTERS_PATH = process.env.FEEDGEN_FILTERS_PATH ?? '/data/filters.json'
const RELOAD_CHECK_INTERVAL_MS = 10_000

type RawPattern = { pattern: string; flags?: string; comment?: string }

// allow  — no effect; exclude — such posts never enter the feed;
// only   — ONLY such posts enter the feed
type ToggleMode = 'allow' | 'exclude' | 'only'
const TOGGLE_MODES: ToggleMode[] = ['allow', 'exclude', 'only']

type RawFilters = {
  includePatterns: RawPattern[]
  excludePatterns: RawPattern[]
  excludeListUri?: string
  gifPosts?: ToggleMode
  quotePosts?: ToggleMode
}

type CompiledFilters = {
  include: RegExp[]
  exclude: RegExp[]
  excludeListUri?: string
  gifPosts: ToggleMode
  quotePosts: ToggleMode
}

let current: CompiledFilters | undefined

const compile = (raw: RawFilters): CompiledFilters => {
  if (!Array.isArray(raw.includePatterns) || !Array.isArray(raw.excludePatterns)) {
    throw new Error('includePatterns / excludePatterns must be arrays')
  }
  const toRegExp = (p: RawPattern, where: string, i: number): RegExp => {
    if (typeof p.pattern !== 'string') {
      throw new Error(`${where}[${i}]: "pattern" must be a string`)
    }
    try {
      return new RegExp(p.pattern, p.flags ?? 'iu')
    } catch (err) {
      throw new Error(`${where}[${i}] (${p.comment ?? 'no comment'}): ${err}`)
    }
  }
  const toggle = (value: ToggleMode | undefined, name: string): ToggleMode => {
    if (value === undefined) return 'allow'
    if (!TOGGLE_MODES.includes(value)) {
      throw new Error(`${name}: must be one of ${TOGGLE_MODES.join(' | ')}`)
    }
    return value
  }
  return {
    include: raw.includePatterns.map((p, i) => toRegExp(p, 'includePatterns', i)),
    exclude: raw.excludePatterns.map((p, i) => toRegExp(p, 'excludePatterns', i)),
    excludeListUri: raw.excludeListUri,
    gifPosts: toggle(raw.gifPosts, 'gifPosts'),
    quotePosts: toggle(raw.quotePosts, 'quotePosts'),
  }
}

export const loadFilters = (): void => {
  const raw = JSON.parse(fs.readFileSync(FILTERS_PATH, 'utf8')) as RawFilters
  const compiled = compile(raw)
  current = compiled
  console.log(
    `filters: loaded ${compiled.include.length} include / ${compiled.exclude.length} exclude patterns` +
      (compiled.excludeListUri ? ' + exclude list' : ''),
  )
  if (compiled.include.length === 0) {
    console.warn('filters: includePatterns is empty — the feed will match NOTHING')
  }
}

// Initial load throws (bad config at startup should fail loudly); later
// reloads only log and keep the previous config.
export const watchFilters = (): void => {
  loadFilters()
  fs.watchFile(FILTERS_PATH, { interval: RELOAD_CHECK_INTERVAL_MS }, () => {
    try {
      loadFilters()
    } catch (err) {
      console.error('filters: reload failed — keeping previous config:', err)
    }
  })
}

export const getExcludeListUri = (): string | undefined =>
  current?.excludeListUri

type ExternalCard = { uri?: string; title?: string; description?: string }
type ImageWithAlt = { alt?: string }

export type MatchablePost = {
  text?: string
  reply?: unknown
  labels?: { values?: { val?: string }[] }
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

// Bluesky GIFs are external embeds pointing at Tenor (or a bare .gif URL)
const isGifPost = (record: MatchablePost): boolean => {
  const uri =
    record.embed?.external?.uri ?? record.embed?.media?.external?.uri ?? ''
  return /\.gif(?:$|\?)/i.test(uri) || /(?:^|\.)tenor\.com\//i.test(uri)
}

const isQuotePost = (record: MatchablePost): boolean =>
  record.embed?.$type === 'app.bsky.embed.record' ||
  record.embed?.$type === 'app.bsky.embed.recordWithMedia'

const applyToggle = (mode: ToggleMode, is: boolean): boolean => {
  if (mode === 'exclude' && is) return false
  if (mode === 'only' && !is) return false
  return true
}

export const matchesFeed = (record: MatchablePost): boolean => {
  if (!current) return false
  // SkyFeed "remove reply" block
  if (record.reply) return false
  // SkyFeed "remove has_labels" block (self-labels are all we can see at ingest)
  if ((record.labels?.values?.length ?? 0) > 0) return false
  if (!applyToggle(current.gifPosts, isGifPost(record))) return false
  if (!applyToggle(current.quotePosts, isQuotePost(record))) return false

  const text = record.text ?? ''
  // include: text + alt text, same targets as the SkyFeed positive block
  const includeHaystack = [text, ...altTexts(record)].join('\n')
  if (!includeHaystack.trim()) return false
  if (!current.include.some((re) => re.test(includeHaystack))) return false

  // exclude: text + alt text + links (external card and facet link URIs)
  const excludeHaystack = [includeHaystack, ...linkStrings(record)].join('\n')
  if (current.exclude.some((re) => re.test(excludeHaystack))) return false
  return true
}
