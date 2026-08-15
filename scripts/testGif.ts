import { validateFilters, matchesFeedVerbose, MatchablePost } from '../src/filter'

// The gifPosts toggle, and the shape that defeated it.
//
// A GIF reaches Bluesky two ways and they look nothing alike. PICKED from the
// GIF button it is an external card at Tenor — which this always caught.
// UPLOADED from your own files, the client transcodes it to mp4 and posts
// app.bsky.embed.video with presentation: "gif": no .gif in the record at all,
// so a uri test cannot see it, and gifPosts: exclude quietly passed it. That is
// how the user found this — a GIF in Vinyl, which has had the toggle on for
// weeks.
//
// Same file covers app.bsky.embed.gallery, the successor to images[], because
// it arrived through the same door: an embed vocabulary that moved on while
// the filter kept reading the old words.

const KEY = 'f'
const WHO = 'did:plc:exampleexampleexample'
const cfg = (mode?: string) =>
  validateFilters({
    feeds: {
      [KEY]: { includePatterns: [{ pattern: 'vinyl' }], ...(mode ? { gifPosts: mode } : {}) },
    },
  }).get(KEY)!
const mediaCfg = (mode: string) =>
  validateFilters({
    feeds: { [KEY]: { includePatterns: [{ pattern: 'vinyl' }], mediaPosts: mode } },
  }).get(KEY)!

const text = 'a vinyl record'

// picked from the GIF button
const tenor: MatchablePost = { text,
  embed: { $type: 'app.bsky.embed.external', external: { uri: 'https://tenor.com/view/x' } } }
const tenorCdn: MatchablePost = { text,
  embed: { $type: 'app.bsky.embed.external', external: { uri: 'https://media.tenor.com/a/b' } } }
// not Tenor: the host is somebody else's and the path merely says so
const fakeTenor: MatchablePost = { text,
  embed: { $type: 'app.bsky.embed.external', external: { uri: 'https://elsewhere.com/tenor.com/x' } } }
const bareGifUrl: MatchablePost = { text,
  embed: { $type: 'app.bsky.embed.external', external: { uri: 'https://ex.com/a.gif' } } }
const gifWithQuery: MatchablePost = { text,
  embed: { $type: 'app.bsky.embed.external', external: { uri: 'https://ex.com/a.gif?w=1' } } }
// uploaded from a file — the real record, copied from the post that was reported
const uploadedGif: MatchablePost = { text,
  embed: { $type: 'app.bsky.embed.video', presentation: 'gif',
           video: { mimeType: 'video/mp4' } } as any }
const uploadedGifQuoted: MatchablePost = { text,
  embed: { $type: 'app.bsky.embed.recordWithMedia',
           media: { $type: 'app.bsky.embed.video', presentation: 'gif' } } }
const galleryGif: MatchablePost = { text,
  embed: { $type: 'app.bsky.embed.gallery',
           items: [{ $type: 'app.bsky.embed.gallery#video', presentation: 'gif' }] } }
// an ordinary video is NOT a gif, and this is the line the fix must not cross
const realVideo: MatchablePost = { text,
  embed: { $type: 'app.bsky.embed.video', presentation: 'default' } }
const videoNoPresentation: MatchablePost = { text, embed: { $type: 'app.bsky.embed.video' } }
const photo: MatchablePost = { text,
  embed: { $type: 'app.bsky.embed.images', images: [{ alt: 'a sleeve' }] } }
const plain: MatchablePost = { text }

const cases: [string, string | undefined, MatchablePost, boolean][] = [
  // exclude — the setting every feed here runs
  ['tenor card, bare host', 'exclude', tenor, false],
  ['tenor card, cdn host', 'exclude', tenorCdn, false],
  ['tenor.com in a PATH is not tenor', 'exclude', fakeTenor, true],
  ['bare .gif url', 'exclude', bareGifUrl, false],
  ['.gif with a query', 'exclude', gifWithQuery, false],
  ['UPLOADED gif', 'exclude', uploadedGif, false],
  ['uploaded gif, quoted', 'exclude', uploadedGifQuoted, false],
  ['gif in a gallery', 'exclude', galleryGif, false],
  ['a real video stays', 'exclude', realVideo, true],
  ['video, no presentation', 'exclude', videoNoPresentation, true],
  ['a photo stays', 'exclude', photo, true],
  ['text alone stays', 'exclude', plain, true],
  // only — the inverse feed
  ['uploaded gif, only', 'only', uploadedGif, true],
  ['real video, only', 'only', realVideo, false],
  // allow / absent must change nothing
  ['uploaded gif, allow', 'allow', uploadedGif, true],
  ['uploaded gif, key absent', undefined, uploadedGif, true],
  // the toggle must not rescue a post that fails the include
  ['gif, off topic', 'only', { text: 'nothing relevant',
    embed: { $type: 'app.bsky.embed.video', presentation: 'gif' } }, false],
]

let fail = 0
const check = (name: string, cond: boolean, detail = '') => {
  if (!cond) fail++
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? `  [${detail}]` : ''}`)
}

console.log('── gifPosts sees both shapes of GIF')
for (const [name, mode, post, want] of cases) {
  const v = matchesFeedVerbose(cfg(mode), post, WHO)
  check(`gifPosts=${String(mode).padEnd(8)} ${name.padEnd(24)}${v.matched ? 'in' : 'out'}`,
    v.matched === want, v.matched ? '' : String(v.reason))
}

// app.bsky.embed.gallery — the same class of miss, found in the same pass
console.log('\n── a gallery is the poster\'s own pictures')
const gallery: MatchablePost = { text,
  embed: { $type: 'app.bsky.embed.gallery',
           items: [{ $type: 'app.bsky.embed.gallery#image', alt: 'a shelf of records' },
                   { $type: 'app.bsky.embed.gallery#image', alt: '' }] } }
const galleryQuoted: MatchablePost = { text,
  embed: { $type: 'app.bsky.embed.recordWithMedia',
           media: { $type: 'app.bsky.embed.gallery',
                    items: [{ $type: 'app.bsky.embed.gallery#image', alt: 'a shelf' }] } } }
const emptyGallery: MatchablePost = { text,
  embed: { $type: 'app.bsky.embed.gallery', items: [] } }
check('mediaPosts=only keeps a gallery',
  matchesFeedVerbose(mediaCfg('only'), gallery, WHO).matched)
check('...including a quoted one',
  matchesFeedVerbose(mediaCfg('only'), galleryQuoted, WHO).matched)
check('...but an empty gallery is not a picture',
  !matchesFeedVerbose(mediaCfg('only'), emptyGallery, WHO).matched)
check('mediaPosts=exclude drops a gallery',
  !matchesFeedVerbose(mediaCfg('exclude'), gallery, WHO).matched)

// alt text: a gallery keeps it one level further in, and the haystack has to
// follow. Matching on a word that exists ONLY in the alt proves the read.
console.log('\n── a gallery\'s alt text reaches the haystack')
const altOnly = validateFilters({
  feeds: { [KEY]: { includePatterns: [{ pattern: 'turntable', target: 'text|alt_text' }] } },
}).get(KEY)!
const altInGallery: MatchablePost = { text: 'no keyword in the text',
  embed: { $type: 'app.bsky.embed.gallery',
           items: [{ $type: 'app.bsky.embed.gallery#image', alt: 'my turntable' }] } }
const altInImages: MatchablePost = { text: 'no keyword in the text',
  embed: { $type: 'app.bsky.embed.images', images: [{ alt: 'my turntable' }] } }
check('a word only in a gallery alt matches',
  matchesFeedVerbose(altOnly, altInGallery, WHO).matched)
check('...exactly as it does for images[]',
  matchesFeedVerbose(altOnly, altInImages, WHO).matched)
check('...and text alone still does not',
  !matchesFeedVerbose(altOnly, { text: 'no keyword in the text' }, WHO).matched)

console.log(fail ? `\n${fail} FAILED` : `\nAll ${cases.length + 7} checks passed`)
process.exit(fail ? 1 : 0)
