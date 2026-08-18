import dotenv from 'dotenv'
import fs from 'node:fs'
import { createDb } from '../src/db'
import { loadCorpus, StoredPost } from '../src/adminLab'
import { loadFiltersOnce, Target } from '../src/filter'

// "How many stored posts would this pattern take, and which ones?" — asked of a
// LIST of candidates at once, before any of them goes near filters.json.
//
// This is the measurement the whole filter policy is written from, and it had
// been rewritten as a throwaway five times in one day (a gatefold that is also
// a magazine word, #RSD that is also an ADHD tag, paintings, cartoons, six
// kinds of not-a-photograph). Every rewrite converged on the same four
// questions, so they are the tool:
//
//   * how many stored posts does each candidate touch, and what did it match?
//   * against the rule it is REPLACING, does it still catch everything that
//     one did — a widened pattern that quietly drops an arm is a regression
//     nothing else would report;
//   * do the sentences that must survive survive?
//   * do the posts that must die die?
//
// What it cannot do is the standing limit of every measurement here: it cannot
// show what a WIDENED INCLUDE would let in. The corpus is what a feed already
// holds, so a pattern is measurable on the exclude side and unmeasurable on the
// include side. See src/adminLab.ts.
//
// Usage:
//   yarn probeCorpus --feed <rkey> --pattern '<regex>' [--pattern '<regex>' ...]
//   yarn probeCorpus --feed <rkey> --spec <file.json>
//   yarn probeCorpus --feed <rkey> --spec <file.json> --json
//
//   --flags <iu>       default imu — m because an alt is its own line
//   --target <t>       text | text|alt_text | text|alt_text|link  (default the widest)
//   --samples <n>      how many matching posts to print per candidate (default 8)
//   --against <text>   compare with the LIVE exclude whose comment contains this
//                      substring, and report anything it catches that the
//                      candidates do not
//
// Spec file: { flags?, target?, against?, candidates: [{name, pattern}],
//              mustSurvive?: [string], mustDie?: [string] }

dotenv.config()

// Keep in step with scripts/auto-purge.sh: the sweep is withheld when it would
// take more than the SMALLER of 25 rows and 5% of what the feed holds.
const AUTO_PURGE_MAX_ABS = 25
const AUTO_PURGE_MAX_PCT = 5
export const autoPurgeLimit = (stored: number): number =>
  Math.max(1, Math.min(Math.floor((stored * AUTO_PURGE_MAX_PCT) / 100), AUTO_PURGE_MAX_ABS))

export type Candidate = { name: string; pattern: string }
export type ProbeSpec = {
  flags?: string
  target?: Target
  against?: string
  candidates: Candidate[]
  mustSurvive?: string[]
  mustDie?: string[]
}

export type CandidateReport = {
  name: string
  pattern: string
  hits: number
  hitsPct: number
  withheldIfSwept: boolean
  samples: { handle: string; matched: string; text: string }[]
}
export type ProbeReport = {
  stored: number
  limit: number
  candidates: CandidateReport[]
  union: number
  unionPct: number
  unionWithheld: boolean
  regressions: { handle: string; text: string }[]
  survive: { text: string; kept: boolean }[]
  die: { text: string; dropped: boolean }[]
}

const compile = (pattern: string, flags: string, what: string): RegExp => {
  try {
    // g and y make RegExp.test stateful, exactly as they do in filter.ts.
    return new RegExp(pattern, flags.replace(/[gy]/g, ''))
  } catch (err) {
    throw new Error(`${what} does not compile: ${(err as Error).message}`)
  }
}

// The whole of the measurement, with no database and no network in it, so a
// test can hand it posts it built itself.
export const runProbe = (
  posts: StoredPost[],
  spec: ProbeSpec,
  opts: { samples?: number; againstPattern?: string } = {},
): ProbeReport => {
  const flags = spec.flags ?? 'imu'
  const target: Target = spec.target ?? 'text|alt_text|link'
  const samples = opts.samples ?? 8
  const hay = (p: StoredPost) => p.hay[target] ?? ''
  const stored = posts.length
  const limit = autoPurgeLimit(stored)

  const compiled = spec.candidates.map((c) => ({ c, re: compile(c.pattern, flags, c.name) }))
  const candidates: CandidateReport[] = compiled.map(({ c, re }) => {
    const hit = posts.filter((p) => re.test(hay(p)))
    const pct = stored ? Math.round((1000 * hit.length) / stored) / 10 : 0
    return {
      name: c.name,
      pattern: c.pattern,
      hits: hit.length,
      hitsPct: pct,
      withheldIfSwept: hit.length > limit,
      samples: hit.slice(0, samples).map((p) => ({
        handle: p.handle,
        matched: String(hay(p).match(re)?.[0] ?? ''),
        text: hay(p).replace(/\s+/g, ' ').trim(),
      })),
    }
  })

  const anyHit = (s: string) => compiled.some(({ re }) => re.test(s))
  const union = posts.filter((p) => anyHit(hay(p))).length
  const unionPct = stored ? Math.round((1000 * union) / stored) / 10 : 0

  // A pattern that REPLACES a live one must still catch what that one caught.
  let regressions: { handle: string; text: string }[] = []
  if (opts.againstPattern) {
    const reOld = compile(opts.againstPattern, flags, 'the rule being replaced')
    regressions = posts
      .filter((p) => reOld.test(hay(p)) && !anyHit(hay(p)))
      .map((p) => ({ handle: p.handle, text: hay(p).replace(/\s+/g, ' ').trim() }))
  }

  return {
    stored,
    limit,
    candidates,
    union,
    unionPct,
    unionWithheld: union > limit,
    regressions,
    survive: (spec.mustSurvive ?? []).map((t) => ({ text: t, kept: !anyHit(t) })),
    die: (spec.mustDie ?? []).map((t) => ({ text: t, dropped: anyHit(t) })),
  }
}

const arg = (name: string): string | undefined => {
  const i = process.argv.indexOf(`--${name}`)
  return i >= 0 ? process.argv[i + 1] : undefined
}
const args = (name: string): string[] => {
  const out: string[] = []
  process.argv.forEach((a, i) => {
    if (a === `--${name}` && process.argv[i + 1]) out.push(process.argv[i + 1])
  })
  return out
}

const cut = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1) + '…' : s)

const print = (r: ProbeReport, spec: ProbeSpec, feed: string) => {
  console.log(`\nfeed ${feed} — ${r.stored} stored posts, target ${spec.target ?? 'text|alt_text|link'}`)
  console.log(`auto-purge would withhold a sweep of more than ${r.limit} of them\n`)
  for (const c of r.candidates) {
    console.log(`${c.name}`)
    console.log(`  ${c.pattern}`)
    console.log(`  -> ${c.hits} of ${r.stored} (${c.hitsPct}%)` +
      (c.withheldIfSwept ? '  ** over the auto-purge cap: the sweep would be WITHHELD **' : ''))
    for (const s of c.samples) {
      console.log(`     @${s.handle}  matched ${JSON.stringify(s.matched)}`)
      console.log(`        ${cut(s.text, 140)}`)
    }
    if (c.hits > c.samples.length) console.log(`     …and ${c.hits - c.samples.length} more`)
    console.log()
  }
  if (r.candidates.length > 1) {
    console.log(`all candidates together: ${r.union} of ${r.stored} (${r.unionPct}%)` +
      (r.unionWithheld ? '  ** over the cap **' : ''))
  }
  if (spec.against) {
    console.log(`\nagainst the live rule matching "${spec.against}":`)
    if (!r.regressions.length) console.log('  no regression — everything it caught is still caught')
    else {
      console.log(`  REGRESSION: ${r.regressions.length} post(s) it caught and these do not`)
      r.regressions.forEach((x) => console.log(`     @${x.handle}  ${cut(x.text, 120)}`))
    }
  }
  if (r.survive.length) {
    console.log('\nmust survive:')
    r.survive.forEach((x) =>
      console.log(`  ${x.kept ? 'kept   ' : 'DROPPED'}  ${JSON.stringify(cut(x.text, 110))}`))
  }
  if (r.die.length) {
    console.log('\nmust die:')
    r.die.forEach((x) =>
      console.log(`  ${x.dropped ? 'dropped' : 'KEPT   '}  ${JSON.stringify(cut(x.text, 110))}`))
  }
  const bad = r.survive.filter((x) => !x.kept).length + r.die.filter((x) => !x.dropped).length +
    r.regressions.length
  console.log(bad ? `\n${bad} EXPECTATION(S) NOT MET` : '\nall expectations met')
  return bad
}

const main = async () => {
  const feed = arg('feed')
  if (!feed) {
    console.error('--feed <rkey> is required. See the header of this file for usage.')
    process.exit(2)
  }
  const specPath = arg('spec')
  const spec: ProbeSpec = specPath
    ? JSON.parse(fs.readFileSync(specPath, 'utf8'))
    : { candidates: args('pattern').map((p, i) => ({ name: `pattern ${i + 1}`, pattern: p })) }
  if (arg('flags')) spec.flags = arg('flags')
  if (arg('target')) spec.target = arg('target') as Target
  if (!spec.candidates?.length) {
    console.error('nothing to probe: give --pattern at least once, or --spec with candidates')
    process.exit(2)
  }

  // The rule being replaced is looked up by its COMMENT, not by its position:
  // order carries no meaning in filters.json and an index goes stale the moment
  // anything above it is edited.
  let againstPattern: string | undefined
  if (spec.against) {
    const cfg = loadFiltersOnce().get(feed)
    if (!cfg) throw new Error(`no feed "${feed}" in the config`)
    const found = cfg.exclude.filter((p) => (p.comment ?? '').includes(spec.against!))
    if (found.length !== 1) {
      throw new Error(`--against "${spec.against}" matches ${found.length} exclude blocks; ` +
        'it has to name exactly one')
    }
    againstPattern = found[0].re.source
  }

  const db = createDb(process.env.FEEDGEN_SQLITE_LOCATION ?? '/data/db.sqlite')
  const { posts, missing } = await loadCorpus(db, feed)
  if (missing) console.log(`(${missing} stored row(s) the AppView would not return — not measured)`)
  const report = runProbe(posts, spec, {
    samples: arg('samples') ? Number(arg('samples')) : undefined,
    againstPattern,
  })
  if (process.argv.includes('--json')) {
    console.log(JSON.stringify({ feed, ...report }, null, 2))
    process.exit(0)
  }
  process.exit(print(report, spec, feed) ? 1 : 0)
}

if (require.main === module) {
  main().catch((e) => {
    console.error(String(e.message ?? e))
    process.exit(1)
  })
}
