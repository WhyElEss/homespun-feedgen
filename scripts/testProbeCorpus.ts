import { runProbe, autoPurgeLimit, ProbeSpec } from './probeCorpus'
import { buildHaystacks, MatchablePost } from '../src/filter'
import { StoredPost } from '../src/adminLab'

// The measurement tool that the filter policy is written with. Its own
// arithmetic is worth pinning: a probe that quietly under-reports collateral is
// worse than none, because every decision downstream is made on its numbers.
//
// Self-contained. runProbe() takes posts and returns a report — no database, no
// AppView — which is the whole reason it is a separate function from the CLI.

let pass = 0
let total = 0
const check = (name: string, cond: boolean, detail = '') => {
  total++
  if (cond) pass++
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? `  [${detail}]` : ''}`)
}

const post = (handle: string, text: string, alt?: string): StoredPost => {
  const record: MatchablePost = alt
    ? { text, embed: { $type: 'app.bsky.embed.images', images: [{ alt }] } }
    : { text }
  return {
    uri: `at://did:plc:${handle}/app.bsky.feed.post/x`,
    did: `did:plc:${handle}`,
    handle,
    text,
    indexedAt: '2026-08-17T00:00:00.000Z',
    hay: buildHaystacks(record),
    record,
  }
}

const CORPUS: StoredPost[] = [
  post('ann', 'view from my window this morning'),
  post('bob', 'a screenshot of the game, looking out the window'),
  post('cat', 'Screenshots from Stellar Blade'),
  post('dee', 'the view from our window', 'a drawing of a cat'),
  post('eve', 'steam on the window #steam'),
]

console.log('── counting, and what it counted')
const spec: ProbeSpec = {
  candidates: [
    { name: 'screenshot', pattern: '\\bscreen\\s?shots?\\b' },
    { name: 'a drawing of', pattern: '\\ba drawing of\\b' },
    { name: 'nothing at all', pattern: 'zzzz' },
  ],
}
const r = runProbe(CORPUS, spec)
check('the corpus size is reported', r.stored === 5, String(r.stored))
check('a candidate counts its own hits', r.candidates[0].hits === 2, String(r.candidates[0].hits))
check('...as a percentage too', r.candidates[0].hitsPct === 40, String(r.candidates[0].hitsPct))
check('...and names what it matched',
  r.candidates[0].samples[0].matched.toLowerCase() === 'screenshot',
  r.candidates[0].samples[0].matched)
check('...with the post it matched in', r.candidates[0].samples[0].handle === 'bob')
// An alt is part of the haystack, and a probe that only read `text` would say 0
// here — which is exactly the bug that would hide every alt-only offender.
check('ALT TEXT is searched, not just the post text', r.candidates[1].hits === 1,
  String(r.candidates[1].hits))
check('a candidate that matches nothing says so', r.candidates[2].hits === 0)
check('the union is not the sum — it counts posts, not hits',
  r.union === 3, String(r.union))

console.log('\n── the auto-purge cap, mirrored from auto-purge.sh')
// LIMIT = min(5% of stored, 25), never below 1 — the SMALLER of the two, which
// "25 posts or 5%" does not say out loud.
check('5% while that is the smaller', autoPurgeLimit(200) === 10, String(autoPurgeLimit(200)))
check('...capped at 25 once 5% exceeds it', autoPurgeLimit(1000) === 25, String(autoPurgeLimit(1000)))
check('...never zero on a tiny feed', autoPurgeLimit(3) === 1, String(autoPurgeLimit(3)))
check('a sweep at the limit is allowed', !runProbe(
  CORPUS, { candidates: [{ name: 'one', pattern: 'steam' }] }).candidates[0].withheldIfSwept)
check('...and one over it is flagged as withheld', runProbe(
  CORPUS, { candidates: [{ name: 'most', pattern: 'window' }] }).candidates[0].withheldIfSwept)

console.log('\n── expectations')
const r2 = runProbe(CORPUS, {
  candidates: [{ name: 'screenshot', pattern: '\\bscreen\\s?shots?\\b' }],
  mustSurvive: ['view from my window', 'a screenshot is fine here'],
  mustDie: ['screenshot of the game', 'this one has no marker'],
})
check('a survivor that survives is kept', r2.survive[0].kept)
check('...one that does not is reported', !r2.survive[1].kept)
check('a post that must die and does is dropped', r2.die[0].dropped)
check('...one that does not is reported', !r2.die[1].dropped)

console.log('\n── replacing a live rule: the regression check')
const r3 = runProbe(CORPUS, { candidates: [{ name: 'narrower', pattern: 'Stellar Blade' }] },
  { againstPattern: '\\bscreen\\s?shots?\\b' })
check('a post the old rule caught and the new one misses is a REGRESSION',
  r3.regressions.length === 1 && r3.regressions[0].handle === 'bob',
  JSON.stringify(r3.regressions.map((x) => x.handle)))
const r4 = runProbe(CORPUS, { candidates: [{ name: 'wider', pattern: 'screenshot|screenshots' }] },
  { againstPattern: '\\bscreen\\s?shots?\\b' })
check('a widened rule reports none', r4.regressions.length === 0)
check('no --against means no regressions computed',
  runProbe(CORPUS, spec).regressions.length === 0)

console.log('\n── flags and targets')
check('case is ignored by default',
  runProbe(CORPUS, { candidates: [{ name: 'c', pattern: 'SCREENSHOT' }] }).candidates[0].hits === 2)
check('...and honoured when i is dropped',
  runProbe(CORPUS, { flags: 'mu', candidates: [{ name: 'c', pattern: 'SCREENSHOT' }] })
    .candidates[0].hits === 0)
// m is on by default because each alt is its own line in the joined haystack,
// which is what lets ^…$ pin a bot's stock caption.
check('^ anchors per LINE by default',
  runProbe(CORPUS, { candidates: [{ name: 'c', pattern: '^a drawing of a cat$' }] })
    .candidates[0].hits === 1)
check('target text alone does not see the alt',
  runProbe(CORPUS, { target: 'text', candidates: [{ name: 'c', pattern: 'a drawing of' }] })
    .candidates[0].hits === 0)
// g and y make RegExp.test stateful, so the same pattern would alternate
// between hit and miss down the corpus. filter.ts strips them; so does this.
check('g is stripped, so counting is not stateful',
  runProbe(CORPUS, { flags: 'gimu', candidates: [{ name: 'c', pattern: 'window' }] })
    .candidates[0].hits === 4,
  String(runProbe(CORPUS, { flags: 'gimu', candidates: [{ name: 'c', pattern: 'window' }] })
    .candidates[0].hits))

console.log('\n── a pattern that does not compile says which one')
let msg = ''
try {
  runProbe(CORPUS, { candidates: [{ name: 'broken one', pattern: '(unclosed' }] })
} catch (err) {
  msg = String((err as Error).message)
}
check('it throws rather than counting zero', msg !== '')
check('...naming the candidate', msg.includes('broken one'), msg)

console.log('\n── an empty corpus does not divide by zero')
const r5 = runProbe([], { candidates: [{ name: 'c', pattern: 'x' }] })
check('no NaN in the percentage', r5.candidates[0].hitsPct === 0)
check('...and the limit is still at least 1', r5.limit === 1)

console.log(pass === total ? `\nAll ${total} checks passed` : `\n${total - pass} of ${total} FAILED`)
process.exit(pass === total ? 0 : 1)
