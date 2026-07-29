import {
  loadFiltersOnce,
  matchesFeedVerbose,
  MatchablePost,
  FeedConfig,
} from '../src/filter'

// Smoke tests for the filter pipeline, run against filters.example.json:
//   FEEDGEN_FILTERS_PATH=./filters.example.json ts-node scripts/testFilter.ts
// (wired up as `yarn test:filters`). Point FEEDGEN_FILTERS_PATH at your real
// data/filters.json to sanity-check a config before deploying it.
//
// Two halves:
//   1. invariants checked against EVERY feed in whatever config is loaded,
//      so they stay useful once you have replaced the examples
//   2. cases for the example feeds, run only when those keys are present

const SOMEONE = 'did:plc:exampleexampleexample'
const EXAMPLE_AUTHOR = 'did:plc:XXXXXXXXXXXXXXXXXXXXXXXX'

let failed = 0
let checks = 0

const check = (name: string, got: boolean, want: boolean, note?: string) => {
  checks++
  const ok = got === want
  if (!ok) failed++
  console.log(
    `  ${ok ? 'PASS' : 'FAIL'}  ${name}` +
      (ok ? '' : ` (expected ${want}, got ${got})`) +
      (note && !got ? `  [${note}]` : ''),
  )
}

const verdict = (cfg: FeedConfig, post: MatchablePost, did = SOMEONE) =>
  matchesFeedVerbose(cfg, post, did)

const configs = loadFiltersOnce()

// ── 1. invariants, whatever is configured ───────────────────────────────
console.log('\n── invariants (every configured feed)')
for (const cfg of configs.values()) {
  const label = cfg.displayName ? `${cfg.key} (${cfg.displayName})` : cfg.key

  // Without a positive criterion a feed would match the whole firehose.
  check(
    `${label}: has a positive criterion`,
    cfg.include.length > 0 || cfg.includeDids.size > 0,
    true,
  )

  // Replies are dropped everywhere — these are top-level-post feeds by
  // construction.
  check(
    `${label}: drops replies`,
    verdict(cfg, { text: 'anything at all', reply: { parent: {} } }).matched,
    false,
  )

  if (cfg.includeDids.size > 0) {
    check(
      `${label}: rejects an unlisted author`,
      verdict(cfg, { text: 'hello' }, 'did:plc:notonthelist').matched,
      false,
    )
    if (cfg.include.length === 0) {
      // A pure author feed takes anything that account posts, text or not.
      const listed = [...cfg.includeDids][0]
      const own = verdict(cfg, { text: 'hello' }, listed)
      check(`${label}: accepts a listed author`, own.matched, true, own.reason)
    }
  } else {
    check(
      `${label}: rejects a post with no text, alt or links`,
      verdict(cfg, { text: '' }).matched,
      false,
    )
  }
}

// ── 2. cases for the example config ─────────────────────────────────────
type Case = {
  feed: string
  name: string
  post: MatchablePost
  did?: string
  expect: boolean
}

const exampleCases: Case[] = [
  {
    feed: 'my-feed',
    name: 'on-topic post',
    post: { text: 'A slow pour-over on a rainy morning' },
    expect: true,
  },
  {
    feed: 'my-feed',
    name: 'hashtag match',
    post: { text: 'first flat white of the day #CoffeeCommunity' },
    expect: true,
  },
  {
    feed: 'my-feed',
    name: 'match via alt text',
    post: {
      text: 'this morning',
      embed: {
        $type: 'app.bsky.embed.images',
        images: [{ alt: 'an aeropress on a kitchen counter' }],
      },
    },
    expect: true,
  },
  {
    feed: 'my-feed',
    name: 'marketplace excluded',
    post: { text: 'selling my espresso machine on ebay' },
    expect: false,
  },
  {
    feed: 'my-feed',
    name: 'price tag excluded',
    post: { text: 'fresh coffee beans, $18.50 a bag' },
    expect: false,
  },
  {
    // Must match an includePattern first, or this would pass for the wrong
    // reason — never reaching the exclude it is meant to exercise.
    feed: 'my-feed',
    name: 'homonym excluded even though the topic matches',
    post: { text: 'fresh coffee beans stacked on my coffee table books' },
    expect: false,
  },
  {
    feed: 'my-feed',
    name: 'unrelated post',
    post: { text: 'Beautiful sunset tonight' },
    expect: false,
  },

  {
    feed: 'my-hashtag-feed',
    name: 'hashtag in the post text',
    post: { text: 'tried a rosetta today #LatteArt' },
    expect: true,
  },
  {
    feed: 'my-hashtag-feed',
    name: "target 'text': an alt-text-only match does not count",
    post: {
      text: 'tried something new today',
      embed: {
        $type: 'app.bsky.embed.images',
        images: [{ alt: 'a cup showing #LatteArt' }],
      },
    },
    expect: false,
  },
  {
    feed: 'my-hashtag-feed',
    name: 'excluded by the link card alone',
    post: {
      text: 'new rosetta attempt #LatteArt',
      embed: {
        $type: 'app.bsky.embed.external',
        external: {
          uri: 'https://example.com/sale',
          title: 'Promo code inside',
          description: 'discount on beans',
        },
      },
    },
    expect: false,
  },

  {
    feed: 'my-author-feed',
    name: 'post from a listed account',
    post: { text: 'anything this account says' },
    did: EXAMPLE_AUTHOR,
    expect: true,
  },
  {
    feed: 'my-author-feed',
    name: 'identical post from anyone else',
    post: { text: 'anything this account says' },
    did: SOMEONE,
    expect: false,
  },
  {
    feed: 'my-author-feed',
    name: 'textless post from a listed account still counts',
    post: {
      text: '',
      embed: { $type: 'app.bsky.embed.images', images: [{ alt: '' }] },
    },
    did: EXAMPLE_AUTHOR,
    expect: true,
  },
]

const present = exampleCases.filter((c) => configs.has(c.feed))
if (present.length === 0) {
  console.log(
    '\n── example-config cases: skipped (no example feed keys in this ' +
      'config — expected once you have replaced them with your own)',
  )
} else {
  let lastFeed = ''
  for (const c of present) {
    const cfg = configs.get(c.feed)!
    if (c.feed !== lastFeed) {
      console.log(`\n── ${c.feed} (${cfg.displayName ?? '?'})`)
      lastFeed = c.feed
    }
    const v = verdict(cfg, c.post, c.did ?? SOMEONE)
    check(c.name, v.matched, c.expect, v.reason)
  }
}

if (failed > 0) {
  console.error(`\n${failed} of ${checks} check(s) failed`)
  process.exit(1)
}
console.log(`\nAll ${checks} checks passed`)
