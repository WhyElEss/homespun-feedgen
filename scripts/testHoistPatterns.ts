import { hoist, topSplit } from './hoistPatterns'

// The transformation is equivalence-preserving by construction, which is
// exactly the kind of claim that deserves a test: the failure mode is silent,
// and a config is not a place to find out.

let pass = 0
let total = 0
const check = (name: string, cond: boolean, detail = '') => {
  total++
  if (cond) pass++
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? `  [${detail}]` : ''}`)
}

console.log('── splitting on TOP-LEVEL | only')
check('a plain alternation', topSplit('a|b|c').length === 3)
check('| inside a group is not a split', topSplit('\\b(?:a|b)|\\bc').length === 2,
  JSON.stringify(topSplit('\\b(?:a|b)|\\bc')))
check('| inside a character class is not a split', topSplit('[a|b]|c').length === 2,
  JSON.stringify(topSplit('[a|b]|c')))
check('an ESCAPED pipe is not a split', topSplit('a\\|b|c').length === 2,
  JSON.stringify(topSplit('a\\|b|c')))
check('nested groups are counted right', topSplit('\\b(?:a(?:x|y)|b)|\\bc').length === 2)

console.log('\n── hoisting')
check('every branch shares \\b', hoist('\\ba|\\bb|\\bc') === '\\b(?:a|b|c)', String(hoist('\\ba|\\bb|\\bc')))
check('a single branch is left alone', hoist('\\ba') === null)
check('nothing to hoist returns null', hoist('a|b|c') === null)
check('one \\b branch among others is not worth it', hoist('#tag|\\ba') === null,
  String(hoist('#tag|\\ba')))
// Order is preserved: only consecutive runs are folded, in place.
check('a leading non-\\b branch keeps its place',
  hoist('#tag|\\ba|\\bb') === '#tag|\\b(?:a|b)', String(hoist('#tag|\\ba|\\bb')))
check('a trailing non-\\b branch keeps its place',
  hoist('\\ba|\\bb|#tag') === '\\b(?:a|b)|#tag', String(hoist('\\ba|\\bb|#tag')))
check('two runs either side of a non-\\b branch',
  hoist('\\ba|\\bb|#tag|\\bc|\\bd') === '\\b(?:a|b)|#tag|\\b(?:c|d)',
  String(hoist('\\ba|\\bb|#tag|\\bc|\\bd')))
check('trailing \\b inside a branch is untouched',
  hoist('\\bcat\\b|\\bdog\\b') === '\\b(?:cat\\b|dog\\b)', String(hoist('\\bcat\\b|\\bdog\\b')))

console.log('\n── the transformation matches the same strings')
const SAMPLES = [
  'a cat sat', 'concatenate', 'the dog barked', 'hotdog', '#tag here', 'nothing at all',
  'CAT in caps', 'a cat, a dog', 'scattered', 'dogged',
]
const same = (a: string) => {
  const b = hoist(a)
  if (!b) return true
  const ra = new RegExp(a, 'iu')
  const rb = new RegExp(b, 'iu')
  return SAMPLES.every((s) => {
    const ma = s.match(ra)
    const mb = s.match(rb)
    if (!!ma !== !!mb) return false
    return !ma || !mb || ma[0] === mb[0]
  })
}
check('verdict AND matched word survive, \\b run', same('\\bcat\\b|\\bdog\\b'))
check('...with a tag branch in front', same('#tag\\w*|\\bcat\\b|\\bdog\\b'))
check('...with a tag branch in the middle', same('\\bcat\\b|#tag\\w*|\\bdog\\b'))
check('...with \\w* tails', same('\\bcat\\w*|\\bdog\\w*'))

console.log(pass === total ? `\nAll ${total} checks passed` : `\n${total - pass} of ${total} FAILED`)
process.exit(pass === total ? 0 : 1)
