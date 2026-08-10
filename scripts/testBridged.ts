import { validateFilters, matchesFeedVerbose, MatchablePost } from '../src/filter'

// The bridgedPosts toggle. Bridgy Fed federates fediverse (Mastodon and the
// rest) accounts into Bluesky and stamps every record it creates with
// bridgyOriginalUrl / bridgyOriginalText. Those two fields are the only
// reliable mark: the filter never sees an author handle, the DID is an
// ordinary did:plc, and a bridge whose handle fails to resolve appears as
// "handle.invalid" rather than "<user>.<instance>.ap.brid.gy" — so a rule
// written against the handle would miss it even if handles were available.
//
// Self-contained on purpose: no fixture file, so this runs anywhere without
// FEEDGEN_FILTERS_PATH pointing at something first.

const KEY = 'f'
const SOMEONE = 'did:plc:exampleexampleexample'
const config = (mode?: string) => ({
  feeds: {
    [KEY]: {
      includePatterns: [{ pattern: '\\bvinyl\\b' }],
      ...(mode ? { bridgedPosts: mode } : {}),
    },
  },
})
const cfg = (mode?: string) => validateFilters(config(mode)).get(KEY)!

const text = 'a fine vinyl record'
type Case = [string, string | undefined, MatchablePost, boolean]
const cases: Case[] = [
  // exclude — every shape of bridged record goes
  ['url only', 'exclude', { text, bridgyOriginalUrl: 'https://example.social/@user/1' }, false],
  ['text only', 'exclude', { text, bridgyOriginalText: '<p>hi</p>' }, false],
  ['both', 'exclude', { text, bridgyOriginalUrl: 'https://a/b', bridgyOriginalText: '<p>x</p>' }, false],
  ['native post', 'exclude', { text }, true],
  // an unknown field is untrusted input: only a string counts
  ['non-string url', 'exclude', { text, bridgyOriginalUrl: 42 as unknown as string }, true],
  ['null url', 'exclude', { text, bridgyOriginalUrl: null as unknown as string }, true],
  // allow / absent — the toggle must not change a config that never set it
  ['bridged, allow', 'allow', { text, bridgyOriginalUrl: 'https://a/b' }, true],
  ['bridged, key absent', undefined, { text, bridgyOriginalUrl: 'https://a/b' }, true],
  // only — the inverse feed
  ['bridged, only', 'only', { text, bridgyOriginalUrl: 'https://a/b' }, true],
  ['native, only', 'only', { text }, false],
  // the gate must not rescue a post that fails the include anyway
  ['bridged and off-topic', 'allow', { text: 'nothing relevant here', bridgyOriginalUrl: 'https://a/b' }, false],
]

let fail = 0
for (const [name, mode, post, want] of cases) {
  const v = matchesFeedVerbose(cfg(mode), post, SOMEONE)
  const ok = v.matched === want
  if (!ok) fail++
  console.log(
    `  ${ok ? 'PASS' : 'FAIL'}  bridgedPosts=${String(mode).padEnd(9)} ${name.padEnd(22)}` +
      `${v.matched ? 'in' : 'out'}${v.matched ? '' : `  [${v.reason}]`}`,
  )
}

// The default has to stay "allow": every existing config predates this key and
// must keep taking bridged posts until someone says otherwise.
if (cfg(undefined).bridgedPosts !== 'allow') {
  console.log('  FAIL  default is not "allow"')
  fail++
} else {
  console.log('  PASS  default when the key is absent is "allow"')
}

// A bad value is refused at compile time, like every other toggle.
try {
  cfg('sometimes')
  console.log('  FAIL  an invalid mode was accepted')
  fail++
} catch (err) {
  console.log(`  PASS  invalid mode refused: ${String(err).slice(0, 72)}`)
}

console.log(fail ? `\n${fail} FAILED` : `\nAll ${cases.length + 2} cases passed`)
process.exit(fail ? 1 : 0)
