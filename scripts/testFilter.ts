import { matchesFeed, loadFilters, MatchablePost } from '../src/filter'

// Smoke tests for the filter pipeline, run against filters.example.json:
//   FEEDGEN_FILTERS_PATH=./filters.example.json ts-node scripts/testFilter.ts
// (wired up as `yarn test:filters`). Point FEEDGEN_FILTERS_PATH at your
// real data/filters.json to sanity-check a config before deploying it —
// but then adjust the expectations below to your own patterns.

loadFilters()

const cases: { name: string; post: MatchablePost; expect: boolean }[] = [
  {
    name: 'plain topic post',
    post: { text: 'Dialed in a new espresso this morning' },
    expect: true,
  },
  {
    name: 'hashtag',
    post: { text: 'Saturday brew #CoffeeCommunity' },
    expect: true,
  },
  {
    name: 'match via image alt text',
    post: {
      text: 'Look at this!',
      embed: {
        $type: 'app.bsky.embed.images',
        images: [{ alt: 'latte art in a white cup' }],
      },
    },
    expect: true,
  },
  {
    name: 'reply removed',
    post: { text: 'espresso is life', reply: { parent: {} } },
    expect: false,
  },
  {
    name: 'self-labeled removed',
    post: { text: 'espresso', labels: { values: [{ val: 'sexual' }] } },
    expect: false,
  },
  {
    name: 'marketplace excluded',
    post: { text: 'Selling my espresso machine on ebay' },
    expect: false,
  },
  {
    name: 'price tag excluded',
    post: { text: 'Espresso beans, $19.99 a bag' },
    expect: false,
  },
  {
    name: 'exclude via external link card',
    post: {
      text: 'Great deal on an aeropress',
      embed: {
        $type: 'app.bsky.embed.external',
        external: { uri: 'https://www.ebay.com/itm/123', title: 'listing' },
      },
    },
    expect: false,
  },
  {
    name: 'gif allowed by example config',
    post: {
      text: 'pour over time',
      embed: {
        $type: 'app.bsky.embed.external',
        external: { uri: 'https://media.tenor.com/x/coffee.gif' },
      },
    },
    expect: true,
  },
  {
    name: 'no text no alt',
    post: { text: '' },
    expect: false,
  },
  {
    name: 'unrelated post',
    post: { text: 'Beautiful sunset tonight' },
    expect: false,
  },
]

let failed = 0
for (const c of cases) {
  const got = matchesFeed(c.post)
  const ok = got === c.expect
  if (!ok) failed++
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${c.name} (expected ${c.expect}, got ${got})`)
}
if (failed > 0) {
  console.error(`\n${failed} case(s) failed`)
  process.exit(1)
}
console.log('\nAll cases passed')
