import fs from 'node:fs'
import { validateFilters, matchesFeedVerbose, buildHaystacks, MatchablePost, Target } from '../src/filter'

// Hoist a repeated leading \b out of an alternation:
//
//     \bA|\bB|\bC   ->   \b(?:A|B|C)
//
// The two are equivalent by construction — \b is a zero-width assertion, so it
// is evaluated at the same position whichever branch follows it — and V8
// charges very differently for them, because the second form tests the boundary
// ONCE per position instead of once per branch. Measured on real feed configs:
// 1.9x on a five-branch block, 6x on eight, 14x on fifteen.
//
// WHERE IT PAYS depends on which side of the config the block is on.
// matchesFeedVerbose runs the include first and returns early, so an exclude
// only ever runs on posts the include already accepted. Hoisting an INCLUDE
// block is felt on every post the firehose delivers; hoisting an exclude is
// felt on the posts a feed actually collects, on purgePosts --rejected replays
// and on the admin Lab's counting.
//
// Usage:
//   npx ts-node scripts/hoistPatterns.ts <filters.json>            report only
//   npx ts-node scripts/hoistPatterns.ts <filters.json> --out <f>  write a candidate
//   npx ts-node scripts/hoistPatterns.ts <filters.json> --out <f> --verify <corpus.jsonl>
//
// --verify replays every record in a JSONL capture (one {record:…} per line,
// the shape scripts/captureFirehose.js writes) through the WHOLE chain under
// both configs and compares the verdict AND the reason string. The reason
// carries the word that fired, which is what would move if a hoist reordered
// branches — so comparing it is the check, not a nicety.

// Split a pattern on TOP-LEVEL | only — not inside (), [] or after a backslash.
export const topSplit = (pattern: string): string[] => {
  const out: string[] = []
  let buf = ''
  let depth = 0
  let inClass = false
  let escaped = false
  for (const ch of pattern) {
    if (escaped) { buf += ch; escaped = false; continue }
    if (ch === '\\') { buf += ch; escaped = true; continue }
    if (inClass) { buf += ch; if (ch === ']') inClass = false; continue }
    if (ch === '[') { buf += ch; inClass = true; continue }
    if (ch === '(') { depth++; buf += ch; continue }
    if (ch === ')') { depth--; buf += ch; continue }
    if (ch === '|' && depth === 0) { out.push(buf); buf = ''; continue }
    buf += ch
  }
  out.push(buf)
  return out
}

// Only CONSECUTIVE runs are hoisted, and they are replaced in place, so branch
// ORDER never moves. Alternation is ordered and hay.match(re)[0] is what the
// admin panel prints as "dropped on <word>": reordering would change that
// string on any post two branches both match.
export const hoist = (pattern: string): string | null => {
  const parts = topSplit(pattern)
  if (parts.length < 2) return null
  const out: string[] = []
  let run: string[] = []
  let changed = false
  const flush = () => {
    if (run.length >= 2) { out.push('\\b(?:' + run.map((p) => p.slice(2)).join('|') + ')'); changed = true }
    else out.push(...run)
    run = []
  }
  for (const p of parts) {
    if (p.startsWith('\\b')) run.push(p)
    else { flush(); out.push(p) }
  }
  flush()
  return changed ? out.join('|') : null
}

type Block = { comment?: string; pattern: string; target?: Target; flags?: string }

if (require.main === module) {
  const [, , path] = process.argv
  const arg = (n: string) => {
    const i = process.argv.indexOf(`--${n}`)
    return i >= 0 ? process.argv[i + 1] : undefined
  }
  if (!path) {
    console.error('usage: hoistPatterns <filters.json> [--out <file>] [--verify <capture.jsonl>]')
    process.exit(2)
  }
  const raw = JSON.parse(fs.readFileSync(path, 'utf8'))
  const changes: { where: string; a: string; b: string; flags: string }[] = []

  for (const [rkey, feed] of Object.entries<any>(raw.feeds ?? {})) {
    const name = feed.displayName ?? rkey
    for (const group of ['includePatterns', 'excludePatterns'] as const) {
      for (const block of (feed[group] ?? []) as Block[]) {
        const h = hoist(block.pattern)
        if (!h) continue
        const branches = topSplit(block.pattern).length
        changes.push({
          where: `${name} / ${group.slice(0, 7)} / ${(block.comment ?? block.pattern).slice(0, 44)}`,
          a: block.pattern,
          b: h,
          flags: block.flags ?? 'iu',
        })
        console.log(`  ${String(branches).padStart(3)} branches  ${name} / ${group.slice(0, 7)} / ${(block.comment ?? block.pattern).slice(0, 44)}`)
        block.pattern = h
      }
    }
  }
  console.log(`\n${changes.length} pattern(s) can be hoisted`)
  if (!changes.length) process.exit(0)

  // Per-pattern timing and equivalence. Both are timed in ALTERNATING rounds
  // and the minimum kept — whichever runs first otherwise pays for the JIT
  // compile and the later one looks faster than it is.
  const verifyPath = arg('verify')
  if (verifyPath) {
    const records: MatchablePost[] = []
    for (const line of fs.readFileSync(verifyPath, 'utf8').split('\n')) {
      if (!line.trim()) continue
      try { records.push(JSON.parse(line).record ?? JSON.parse(line)) } catch { /* skip */ }
    }
    const hays = records.map((r) => buildHaystacks(r)['text|alt_text|link'])
    console.log(`\nequivalence and cost over ${records.length} captured records\n`)
    let bad = 0
    for (const { where, a, b, flags } of changes) {
      const f = (flags || 'iu').replace(/[gy]/g, '')
      const ra = new RegExp(a, f)
      const rb = new RegExp(b, f)
      let hits = 0
      let differ = 0
      for (const h of hays) {
        const ma = h.match(ra)
        const mb = h.match(rb)
        if (!!ma !== !!mb) differ++
        else if (ma && mb && ma[0] !== mb[0]) differ++
        if (ma) hits++
      }
      const once = (re: RegExp) => {
        const t0 = process.hrtime.bigint()
        for (const h of hays) re.test(h)
        return Number(process.hrtime.bigint() - t0) / 1000 / Math.max(1, hays.length)
      }
      let ta = Infinity
      let tb = Infinity
      for (let r = 0; r < 5; r++) {
        if (r % 2 === 0) { ta = Math.min(ta, once(ra)); tb = Math.min(tb, once(rb)) }
        else { tb = Math.min(tb, once(rb)); ta = Math.min(ta, once(ra)) }
      }
      bad += differ
      console.log(`${ta.toFixed(1).padStart(7)} -> ${tb.toFixed(1).padStart(7)} µs  ${(ta / tb).toFixed(1).padStart(5)}x  ${String(hits).padStart(4)} hits  ${differ ? '!! ' + differ + ' DIFFER' : ' ok '}  ${where}`)
    }

    // ...and the check that actually matters: the whole chain, both configs.
    const live = validateFilters(JSON.parse(fs.readFileSync(path, 'utf8')))
    const cand = validateFilters(raw)
    let chainDiff = 0
    for (const [rkey, cfg] of live) {
      const other = cand.get(rkey)
      if (!other) continue
      for (const rec of records) {
        const va = matchesFeedVerbose(cfg, rec, 'did:plc:x')
        const vb = matchesFeedVerbose(other, rec, 'did:plc:x')
        if (va.matched !== vb.matched || (va.reason ?? '') !== (vb.reason ?? '')) chainDiff++
      }
    }
    console.log(`\nwhole-chain verdicts over ${records.length} records x ${live.size} feeds: ${chainDiff} differ`)
    if (bad || chainDiff) {
      console.error('\nNOT EQUIVALENT — do not install')
      process.exit(1)
    }
    console.log('EQUIVALENT — nothing changed but the cost')
  }

  const out = arg('out')
  if (out) {
    fs.writeFileSync(out, JSON.stringify(raw, null, 1))
    console.log(`\nwritten: ${out}`)
  } else {
    console.log('\n(report only — pass --out <file> to write a candidate)')
  }
}
