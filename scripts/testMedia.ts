import { validateFilters, matchesFeedVerbose, MatchablePost } from '../src/filter'

// The mediaPosts toggle. A feed whose subject is what people photograph — a
// view from someone's window — wants the picture, and a post that only says
// the words is not the thing. Self-contained: no fixture file to point at.

const KEY = 'f'
const WHO = 'did:plc:exampleexampleexample'
const cfg = (mode?: string) =>
  validateFilters({
    feeds: { [KEY]: { includePatterns: [{ pattern: 'window' }], ...(mode ? { mediaPosts: mode } : {}) } },
  }).get(KEY)!

const text = 'the view from my window'
const img = (n = 1): MatchablePost => ({ text,
  embed: { $type: 'app.bsky.embed.images', images: Array(n).fill({ alt: 'a window' }) } })
const video: MatchablePost = { text, embed: { $type: 'app.bsky.embed.video', alt: 'a window' } }
const recordWithImages: MatchablePost = { text,
  embed: { $type: 'app.bsky.embed.recordWithMedia',
           media: { $type: 'app.bsky.embed.images', images: [{ alt: 'a window' }] } } }
const recordWithVideo: MatchablePost = { text,
  embed: { $type: 'app.bsky.embed.recordWithMedia', media: { $type: 'app.bsky.embed.video' } } }
const linkCard: MatchablePost = { text,
  embed: { $type: 'app.bsky.embed.external',
           external: { uri: 'https://example.com', title: 'a window' } } }
const tenorGif: MatchablePost = { text,
  embed: { $type: 'app.bsky.embed.external', external: { uri: 'https://tenor.com/x.gif' } } }
const quoteOnly: MatchablePost = { text, embed: { $type: 'app.bsky.embed.record' } }
const plain: MatchablePost = { text }
const emptyImages: MatchablePost = { text, embed: { $type: 'app.bsky.embed.images', images: [] } }

const cases: [string, string | undefined, MatchablePost, boolean][] = [
  // only — the shape Other People's Windows needs
  ['image', 'only', img(), true],
  ['four images', 'only', img(4), true],
  ['video', 'only', video, true],
  ['quote + images', 'only', recordWithImages, true],
  ['quote + video', 'only', recordWithVideo, true],
  ['text alone', 'only', plain, false],
  // a thumbnail that is not the poster's picture
  ['link card', 'only', linkCard, false],
  ['tenor gif', 'only', tenorGif, false],
  ['quote alone', 'only', quoteOnly, false],
  ['images: [] ', 'only', emptyImages, false],
  // exclude — the inverse feed
  ['image, exclude', 'exclude', img(), false],
  ['text, exclude', 'exclude', plain, true],
  // allow / absent must change nothing
  ['text, allow', 'allow', plain, true],
  ['text, key absent', undefined, plain, true],
  ['image, key absent', undefined, img(), true],
  // the toggle must not rescue a post that fails the include
  ['image, off topic', 'only', { text: 'nothing relevant',
    embed: { $type: 'app.bsky.embed.images', images: [{ alt: 'x' }] } }, false],
]

let fail = 0
for (const [name, mode, post, want] of cases) {
  const v = matchesFeedVerbose(cfg(mode), post, WHO)
  const ok = v.matched === want
  if (!ok) fail++
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  mediaPosts=${String(mode).padEnd(9)} ${name.padEnd(18)}` +
    `${v.matched ? 'in' : 'out'}${v.matched ? '' : `  [${v.reason}]`}`)
}
if (cfg(undefined).mediaPosts !== 'allow') { console.log('  FAIL  default is not "allow"'); fail++ }
else console.log('  PASS  default when the key is absent is "allow"')
try { cfg('sometimes'); console.log('  FAIL  invalid mode accepted'); fail++ }
catch (err) { console.log(`  PASS  invalid mode refused: ${String(err).slice(0, 66)}`) }
console.log(fail ? `\n${fail} FAILED` : `\nAll ${cases.length + 2} cases passed`)
process.exit(fail ? 1 : 0)
