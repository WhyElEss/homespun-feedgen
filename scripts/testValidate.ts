import { validateFilters, loadFiltersOnce, getFeedKeys } from '../src/filter'

// Covers validateFilters: the config layer's error messages, and the property
// that matters to anything editing a config from outside — checking a candidate
// must not disturb the config the service is currently serving.

const ok = (name: string, cond: boolean, detail = '') => {
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? `  [${detail}]` : ''}`)
  return cond
}

const good = () => ({
  feeds: {
    abc: {
      displayName: 'Example',
      includePatterns: [{ pattern: 'coffee' }],
      excludePatterns: [{ pattern: 'decaf', target: 'text|alt_text|link' }],
      retention: { type: 'hours', value: 72 },
    },
  },
})

// Returns the thrown message, or '' when the call unexpectedly succeeded.
const rejects = (raw: unknown): string => {
  try {
    validateFilters(raw)
    return ''
  } catch (err: any) {
    return String(err?.message ?? err)
  }
}

const run = () => {
  let pass = 0
  let total = 0
  const check = (name: string, cond: boolean, detail = '') => {
    total++
    if (ok(name, cond, detail)) pass++
  }

  console.log('\n── accepts a valid config')
  const compiled = validateFilters(good())
  check('returns one compiled feed', compiled.size === 1)
  check('keyed by rkey', compiled.has('abc'))
  check('include compiled', (compiled.get('abc')?.include.length ?? 0) === 1)
  check(
    'exclude target honoured',
    compiled.get('abc')?.exclude[0]?.target === 'text|alt_text|link',
  )
  check('retention carried', compiled.get('abc')?.retention.value === 72)

  console.log('\n── rejects malformed configs, naming the offending path')
  const cases: [string, unknown, string][] = [
    ['no feeds key', {}, 'feeds'],
    ['feeds is an array', { feeds: [] }, 'feeds'],
    ['feeds is empty', { feeds: {} }, 'empty'],
    [
      'feed with neither include nor dids',
      { feeds: { abc: { retention: { type: 'hours', value: 1 } } } },
      'entire firehose',
    ],
    [
      'invalid regex',
      { feeds: { abc: { includePatterns: [{ pattern: '(' }] } } },
      'includePatterns',
    ],
    [
      'includeDids holds a non-DID',
      { feeds: { abc: { includeDids: ['nope'] } } },
      'includeDids',
    ],
    [
      // The admin page's "Remove pin" must DELETE the key, never blank it. If it
      // ever writes '', this is the error the operator gets instead of a silent
      // half-removal that a later reader has to interpret.
      'an EMPTY pinnedPost is refused, not read as "no pin"',
      { feeds: { abc: { includePatterns: [{ pattern: 'x' }], pinnedPost: '' } } },
      'pinnedPost',
    ],
    [
      'pinnedPost is not a post URI',
      {
        feeds: {
          abc: { includePatterns: [{ pattern: 'x' }], pinnedPost: 'https://example.com' },
        },
      },
      'pinnedPost',
    ],
    [
      'unknown toggle value',
      { feeds: { abc: { includePatterns: [{ pattern: 'x' }], quotePosts: 'maybe' } } },
      'quotePosts',
    ],
    [
      'nonsense retention',
      {
        feeds: {
          abc: { includePatterns: [{ pattern: 'x' }], retention: { type: 'weeks', value: 2 } },
        },
      },
      'retention',
    ],
  ]
  for (const [name, raw, needle] of cases) {
    const msg = rejects(raw)
    check(name, msg.includes(needle), msg ? msg.slice(0, 60) : 'no error thrown')
  }

  console.log('\n── does not disturb the live config')
  // Install the real config first, then throw bad candidates at the validator.
  loadFiltersOnce()
  const before = getFeedKeys().join(',')
  check('a config is loaded to begin with', before.length > 0, before)
  rejects({ feeds: {} })
  rejects({ feeds: { zzz: { includePatterns: [{ pattern: '(' }] } } })
  validateFilters(good()) // a *successful* validate must not install either
  const after = getFeedKeys().join(',')
  check('live feed set unchanged', before === after, after)

  console.log(`\n${pass === total ? 'All' : `${pass} of`} ${total} checks passed`)
  if (pass !== total) process.exit(1)
}

run()
