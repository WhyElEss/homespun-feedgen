// Runs the admin page's inlined script against a stub DOM and asserts what it
// builds. Usage: ts-node scripts/testAdminPage.ts
//
// Everything else about the page is covered by parsing it, which proves only
// that it is syntactically valid — a page that throws on the first render is
// still perfectly parseable. The property that actually matters here cannot be
// eyeballed either: the editor shows ONE feed, but saves the WHOLE config, so a
// bug that drops the other three would look completely normal on screen.
import { ADMIN_PAGE } from '../src/adminPage'

let pass = 0
let total = 0
const check = (name: string, cond: boolean, detail = '') => {
  total++
  if (cond) pass++
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? `  [${detail}]` : ''}`)
}

class El {
  tagName: string
  children: El[] = []
  parent: El | null = null
  attrs: Record<string, string> = {}
  handlers: Record<string, Function> = {}
  className = ''
  textContent = ''
  value = ''
  checked = false
  disabled = false
  // Set by the tests that drive an <input type=file>; the page reads .files[0].
  files: any[] | null = null
  constructor(tag: string) {
    this.tagName = tag.toUpperCase()
  }
  set innerHTML(_v: string) {
    this.children.forEach((c) => (c.parent = null))
    this.children = []
  }
  get innerHTML(): string {
    return ''
  }
  appendChild(c: El) {
    c.parent = this
    this.children.push(c)
    return c
  }
  // Element.remove() is how the re-auth overlay takes itself down. The stub not
  // having it would have made that path throw only in a real browser.
  remove() {
    if (!this.parent) return
    const i = this.parent.children.indexOf(this)
    if (i >= 0) this.parent.children.splice(i, 1)
    this.parent = null
  }
  setAttribute(k: string, v: string) {
    this.attrs[k] = v
  }
  getAttribute(k: string) {
    return this.attrs[k]
  }
  addEventListener(ev: string, fn: Function) {
    this.handlers[ev] = fn
  }
  focus() {}
  select() {}
}

const walk = (el: El, out: El[] = []): El[] => {
  out.push(el)
  el.children.forEach((c) => walk(c, out))
  return out
}
const textOf = (el: El): string =>
  walk(el)
    .map((e) => e.textContent)
    .filter(Boolean)
    .join(' | ')
const find = (root: El, tag: string): El[] =>
  walk(root).filter((e) => e.tagName === tag.toUpperCase())

const STATUS = {
  ok: true,
  status: {
    generatedAt: new Date().toISOString(),
    box: { name: 'pi', hostname: 'pi', pid: 1, node: 'v20', uptimeSec: 10, processUptimeSec: 10 },
    service: {
      hostname: 'feed.example.com',
      serviceDid: 'did:plc:s',
      publisherDid: 'did:plc:p',
      port: 3000,
      subscriptionEndpoint: 'wss://jet1.example',
      writable: true,
    },
    filters: { path: '/data/filters.json', exists: true, modified: null, sizeBytes: 10, sha256: 'abc123abc123' },
    gc: { lastAt: '2026-08-04T20:00:00.000Z', agoSec: 300, nextInSec: 3300,
          intervalSec: 3600, failures: 0 },
    cursors: [
      { service: 'wss://jet2.example', cursor: 1, at: '2026-07-29T04:29:21.000Z', lagSec: 600000 },
      { service: 'wss://jet1.example', cursor: 2, at: '2026-08-04T20:00:00.000Z', lagSec: 5 },
    ],
    feeds: [
      { key: 'coffee', displayName: 'Coffee', routed: true, rows: 100, oldest: null, newest: null,
        retention: { type: 'hours', value: 72 }, includePatterns: 1, excludePatterns: 1,
        includeDids: 0, excludeListUri: null, pinnedPost: null },
      { key: 'radio', displayName: 'Radio', routed: true, rows: 500, oldest: null, newest: null,
        retention: { type: 'count', value: 500 }, includePatterns: 0, excludePatterns: 0,
        includeDids: 1, excludeListUri: null, pinnedPost: null },
    ],
  },
}

// The activity payload is anchored to the real clock, because the page turns
// these UTC buckets into the reader's own local hours and a fixed fixture would
// only line up in one time zone.
const HOURS24 = (() => {
  const top = Math.floor(Date.now() / 3600000) * 3600000
  const out: string[] = []
  for (let i = 23; i >= 0; i--) out.push(new Date(top - i * 3600000).toISOString().slice(0, 13))
  return out
})()

// Four removed posts, ALL of them from hour 20 while the sweep itself ran in
// hour 23. That gap is the entire point of the card — a sweep removes posts
// from earlier hours — so the fixture must not accidentally line the two up.
const PURGED_ROWS = [0, 1, 2, 3].map((i) => ({
  feed: 'coffee',
  uri: `at://did:plc:spam/app.bsky.feed.post/rk${i}`,
  handle: 'spammer',
  text: 'buy my thing',
  why: 'on moderation list',
  indexedAt: HOURS24[20] + ':1' + i + ':00.000Z',
  kind: 'blocklist',
})).concat([{
  // Older than the chart. The live box produced exactly this on the first run:
  // a sweep of three whose two oldest had arrived the previous day, so the row
  // read -3 while one column lit up.
  feed: 'coffee',
  uri: 'at://did:plc:spam/app.bsky.feed.post/rkold',
  handle: 'spammer',
  text: 'buy my thing',
  why: 'on moderation list',
  indexedAt: new Date(Date.parse(HOURS24[0] + ':00:00.000Z') - 5 * 3600000).toISOString(),
  kind: 'blocklist',
}])

const ACTIVITY = {
  ok: true,
  activity: {
    generatedAt: new Date().toISOString(),
    hours: HOURS24,
    feeds: [
      {
        key: 'coffee',
        stored: HOURS24.map((_, i) => (i === 22 ? 7 : i === 20 ? 3 : 0)),
        purged: HOURS24.map((_, i) => (i === 20 ? 4 : 0)),
        floor: null,
      },
      {
        key: 'radio',
        stored: HOURS24.map((_, i) => (i === 22 ? 2 : 0)),
        purged: HOURS24.map(() => 0),
        // Count retention that has already eaten the first ten hours shown.
        floor: HOURS24[10] + ':00:00.000Z',
      },
    ],
    events: [
      {
        at: HOURS24[23] + ':10:00.000Z',
        kind: 'blocklist',
        total: 5,
        byFeed: [{ feed: 'coffee', count: 5 }],
        rows: PURGED_ROWS,
        omitted: 0,
      },
    ],
    withheld: [
      { at: HOURS24[18] + ':05:00.000Z', mode: 'rejected', count: 180, stored: 1400, limit: 25 },
    ],
    notes: [],
  },
}

const FILTERS = {
  ok: true,
  digest: 'abc123abc123',
  writable: true,
  filters: {
    _readme: 'a comment key the editor does not model',
    feeds: {
      coffee: {
        displayName: 'Coffee',
        _note: 'a key the editor does not model',
        includePatterns: [{ pattern: '\\bcoffee\\b', comment: 'the topic' }],
        excludePatterns: [{ pattern: '\\bdiscount\\b' }],
        excludeListUri: 'at://did:plc:x/app.bsky.graph.list/abc',
        retention: { type: 'hours', value: 72 },
      },
      radio: {
        includeDids: ['did:plc:someone'],
        retention: { type: 'count', value: 500 },
        // A pin that is already IN the config. Without one, "Remove pin" could
        // only ever be tested against a pin added in the same session, and the
        // branch that reports a saved pin being cleared would never run.
        pinnedPost: 'at://did:plc:someone/app.bsky.feed.post/pinned1',
      },
      // The minimum a feed can be: no retention, no name, nothing optional.
      // Here because rendering it must not EDIT it — a default written into the
      // draft while drawing the page would mark it unsaved before it was
      // touched, and then save a key nobody added.
      plain: {
        includePatterns: [{ pattern: '\\bplain\\b' }],
      },
    },
  },
}

const run = async () => {
  const script = ADMIN_PAGE.split('<script>')[1].split('</script>')[0]
  const css = ADMIN_PAGE.split('<style>')[1].split('</style>')[0]
  const app = new El('main')
  const created: El[] = []
  // The page binds Cmd+S here. Without this the stub had no addEventListener at
  // all, so the guard around it was the only thing keeping the page from
  // throwing on load — which is not a thing to leave to a guard.
  const docHandlers: Record<string, Function> = {}
  const doc = {
    addEventListener: (ev: string, fn: Function) => { docHandlers[ev] = fn },
    getElementById: () => app,
    createElement: (tag: string) => {
      const el = new El(tag)
      created.push(el)
      return el
    },
    createTextNode: (text: string) => {
      const el = new El('#text')
      el.textContent = text
      return el
    },
  }
  const puts: any[] = []
  const resolved: string[] = []
  const resolvedLists: string[] = []
  const probes: any[] = []
  const measures: any[] = []
  const published: any[] = []
  let totpBegins = 0
  let statusFetches = 0
  // Flipped on to simulate the session idling out — an hour of sitting on the
  // page with an unsaved edit is an ordinary afternoon, not an edge case.
  let unauthorized = false
  let loginAttempts = 0
  // Flipped by the test that checks the quiet case: no purges in the window has
  // to read as a sentence, not as a blank strip that looks broken.
  let activityEmpty = false
  const requested: string[] = []
  const fetchStub = (url: string, init?: any) => {
    const method = init?.method ?? (init?.body ? 'POST' : 'GET')
    requested.push(method + ' ' + url)
    const isAuthRoute = /\/admin\/api\/(login|login-meta|logout)$/.test(url)
    if (url === '/admin/api/login') loginAttempts++
    if (unauthorized && !isAuthRoute) {
      return Promise.resolve({
        status: 401, ok: false,
        json: () => Promise.resolve({ ok: false, error: 'not signed in' }),
      })
    }
    let body: any = null
    // Exact paths. The first version matched with endsWith, so a call to
    // /admin/api/lab/measure — which does not exist — was answered as if it
    // were /admin/lab/measure, and the real 404 only ever showed up in a
    // browser.
    if (url === '/admin/api/status') { statusFetches++; body = STATUS }
    else if (url === '/admin/activity') {
      body = activityEmpty
        ? { ok: true, activity: { ...ACTIVITY.activity, feeds: [], events: [],
                                  withheld: [], notes: [] } }
        : ACTIVITY
    }
    else if (url === '/admin/filters' && method === 'GET') body = JSON.parse(JSON.stringify(FILTERS))
    else if (url === '/admin/lab/measure') {
      // Measure posts assembled() — the whole candidate config with the draft
      // spliced in — so it doubles as a window onto the draft at any moment,
      // without having to Save to find out what the editor is holding.
      measures.push(JSON.parse(init.body))
      body = { ok: true, result: { feed: 'coffee', stored: 100, unretrievable: 0,
        keptNow: 98, keptAfter: 97, removed: 1, removedPct: 1,
        wouldExceedAutoPurgeCap: false, cachedAt: '2026-08-04T20:00:00.000Z',
        note: 'measured', samples: [{ uri: 'at://1', handle: 'dee', text: 'sponsored',
          indexedAt: '2026-08-04T19:00:00.000Z', reason: 'excluded by /sponsored/' }] } }
    }
    else if (url === '/admin/jetstream/probe') {
      body = { ok: true, readings: [
        { endpoint: 'wss://jet1.example', medianAgeSec: 3, samples: 20, error: null },
        { endpoint: 'wss://jet2.example', medianAgeSec: 6800, samples: 20, error: null },
        { endpoint: 'wss://jet3.example', medianAgeSec: null, samples: 0, error: 'timed out' },
      ] }
    }
    else if (url === '/admin/api/login-meta') { body = { ok: true, totpRequired: true } }
    else if (url === '/admin/api/login') { unauthorized = false; body = { ok: true } }
    else if (url === '/admin/api/logout') { body = { ok: true } }
    else if (url === '/admin/totp/status') {
      body = { ok: true, enabled: false, broken: false, source: null,
               managedHere: true, file: '/data/admin-totp.json' }
    }
    else if (url === '/admin/totp/begin') {
      totpBegins++
      body = { ok: true, secret: 'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP',
               uri: 'otpauth://totp/x', expiresInSec: 600, note: 'not enabled yet' }
    }
    else if (url === '/admin/identity') {
      body = { ok: true, identity: { serviceDid: 'did:plc:s', handle: 'me.example',
        feedEndpoint: 'https://old.example.com', expectedEndpoint: 'https://feed.example.com',
        matches: false, pds: 'https://pds.example', note: 'Bluesky calls a DIFFERENT hostname.' } }
    }
    else if (url === '/admin/lab/probe') {
      probes.push(JSON.parse(init.body))
      body = { ok: true, result: { feed: 'coffee', stored: 100, hits: 2, hitsPct: 2,
        wouldExceedAutoPurgeCap: false, cachedAt: '2026-08-04T20:00:00.000Z',
        note: 'Counted over the posts this feed already holds.',
        samples: [{ uri: 'at://1', handle: 'ann', text: 'fresh coffee', matched: 'coffee' }] } }
    }
    else if (url === '/admin/whynot' && JSON.parse(init.body).input.includes('blocked')) {
      // The case the whole panel exists for: a post that matched its way in and
      // was then thrown out by one token of a forty-token alternation.
      body = { ok: true, result: {
        uri: 'at://did:plc:a/app.bsky.feed.post/2', did: 'did:plc:a', handle: 'ann.example',
        createdAt: '2026-08-04T10:00:00.000Z', embed: 'none', isReply: false,
        text: 'become a major solo artist', alt: '',
        feeds: [
          { key: 'coffee', displayName: 'Coffee', stored: false, wouldIndex: false,
            reason: 'excluded by "artist" (offtopic: 3D/models/art/etc) — /\\b(?:animation|3Dprint…/ on text|alt_text|link',
            includeMatch: 'coffee', includeTarget: 'text|alt_text',
            excludeMatch: 'artist', excludeComment: 'offtopic: 3D/models/art/etc',
            excludeTarget: 'text|alt_text|link', mutedByList: false, disagrees: false },
        ] } }
    }
    else if (url === '/admin/whynot') {
      body = { ok: true, result: {
        uri: 'at://did:plc:a/app.bsky.feed.post/1', did: 'did:plc:a', handle: 'ann.example',
        createdAt: '2026-08-04T10:00:00.000Z', embed: 'none', isReply: false,
        text: 'fresh coffee', alt: '',
        feeds: [
          { key: 'coffee', displayName: 'Coffee', stored: false, wouldIndex: true,
            reason: null, includeMatch: 'coffee', includeTarget: 'text|alt_text',
            mutedByList: false, disagrees: true },
          { key: 'radio', displayName: 'Radio', stored: false, wouldIndex: false,
            reason: 'author did:plc:a not in includeDids', includeMatch: null,
            includeTarget: null, mutedByList: false, disagrees: false },
        ] } }
    }
    else if (/^\/admin\/feed\/[^/]+\/record$/.test(url) && method === 'POST') {
      published.push({ url, payload: JSON.parse(init.body) })
      body = { ok: true, uri: 'at://did:plc:p/app.bsky.feed.generator/x',
               cid: 'bafy2', changed: ['avatar'] }
    }
    else if (/^\/admin\/feed\/[^/]+\/record$/.test(url)) {
      body = { ok: true, record: { uri: 'at://did:plc:p/app.bsky.feed.generator/coffee',
        cid: 'bafy', displayName: 'Coffee, published', description: 'the real one',
        avatarCid: 'bafcid', did: 'did:plc:s', createdAt: '2026-01-01T00:00:00Z' } }
    }
    else if (url === '/admin/resolve/list') {
      resolvedLists.push(JSON.parse(init.body).input)
      body = { ok: true, list: { uri: 'at://did:plc:y5/app.bsky.graph.list/3msv',
        did: 'did:plc:y5', name: 'blocked accounts', purpose: 'curatelist',
        count: 2, exists: true } }
    }
    else if (url === '/admin/resolve/post') {
      resolved.push(JSON.parse(init.body).input)
      body = { ok: true, post: { uri: 'at://did:plc:mc/app.bsky.feed.post/3msc',
        did: 'did:plc:mc', handle: 'mcwyrm.bsky.social', text: 'a pinned post', exists: true } }
    }
    else if (url === '/admin/filters/validate') {
      const sent = JSON.parse(init.body)
      // A pattern that will not compile is the likeliest thing to happen here,
      // so the fixture can produce one on demand.
      if (JSON.stringify(sent).includes('(((')) {
        return Promise.resolve({
          status: 400, ok: false,
          json: () => Promise.resolve({ ok: false,
            error: 'feeds["coffee"].includePatterns[1] (no comment): SyntaxError: Invalid regular expression' }),
        })
      }
      body = { ok: true, feeds: [
        { key: 'coffee', includePatterns: 1, excludePatterns: 1, includeDids: 0 },
        { key: 'radio', includePatterns: 0, excludePatterns: 0, includeDids: 1 },
      ] }
    }
    else if (url === '/admin/filters' && method === 'PUT') {
      puts.push(JSON.parse(init.body))
      body = { ok: true, digest: 'newdigest123', note: 'saved' }
    }
    if (body === null) {
      // What express really does with an unmatched route: HTML, not JSON. The
      // browser then fails in JSON.parse, which is how this surfaced.
      return Promise.resolve({
        status: 404, ok: false,
        json: () => Promise.reject(new SyntaxError('not JSON')),
      })
    }
    return Promise.resolve({ status: 200, ok: true, json: () => Promise.resolve(body) })
  }

  // Capturing the scheduled callback is what lets the refresh be fired on
  // demand: the whole point of these last checks is what a poll does to an
  // editor someone is using.
  const timers: Function[] = []
  // The page checks window.matchMedia before autofocusing; the stub has no
  // window at all, which is exactly the "not available" branch it must survive.
  // Reads back whatever the test put on the fake File. Synchronous on purpose:
  // the page's own callback is what is under test, not the browser's plumbing.
  class FileReaderStub {
    result = ''
    onload: Function | null = null
    readAsDataURL(f: any) {
      this.result = f.dataUrl
      if (this.onload) this.onload()
    }
  }
  const fn = new Function(
    'document', 'location', 'fetch', 'setTimeout', 'clearTimeout', 'confirm',
    'setInterval', 'FileReader',
    script,
  )
  fn(doc, { pathname: '/admin' }, fetchStub,
     (cb: Function) => timers.push(cb), () => {}, () => true,
     () => {}, FileReaderStub)
  const settle = async () => {
    for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r))
  }
  const firePoll = async () => {
    const cb = timers.pop()
    if (cb) cb()
    await settle()
  }

  await settle()

  const all = textOf(app)
  console.log('\n── the status view still renders')
  check('the box name is shown', all.includes('pi'))
  check('feeds are listed', all.includes('Coffee') && all.includes('Radio'))
  check('the live cursor is badged', all.includes('5s'))
  check('the stale cursor is labelled instead', all.includes('not in use'))

  console.log('\n── the last 24 hours')
  const statusPane = () => walk(app).find((e) => e.attrs.id === 'panel-status')!
  const actCard = walk(statusPane()).find((e) => e.className.split(' ').indexOf('act') > -1)!
  check('the card is on the Status tab', !!actCard)
  // A stub DOM has no layout, so a bar's height — which lives in a style
  // attribute nothing here can measure — is not a testable property. The
  // numbers have to be readable as data or this chart is untested.
  const colsIn = (root: El) => walk(root).filter((e) => e.attrs['data-hour'] !== undefined)
  const cols = colsIn(actCard)
  check('one column per hour', cols.length === 24, String(cols.length))
  check('a bar carries its own numbers',
    cols[22].attrs['data-stored'] === '7' && cols[22].attrs['data-purged'] === '0')
  // The sweep ran in hour 23; these four went into hour 20, where they arrived.
  check('removed posts go back into the hour they ARRIVED, not the hour swept',
    cols[20].attrs['data-stored'] === '3' && cols[20].attrs['data-purged'] === '4')
  check('...so the hour of the sweep gains nothing', cols[23].attrs['data-purged'] === '0')
  check('the hour still filling is marked', cols[23].className.includes('partial'))
  // "18:00" alone does not say whether the column covers 17-18 or 18-19 —
  // which is exactly what got asked. A bucket is [HH:00, HH+1:00).
  check('a column names the hour RANGE it covers, not just its start',
    /^\d\d:00–\d\d:00 — /.test(cols[22].attrs.title || ''), cols[22].attrs.title)
  check('...and no completed hour is', !cols[22].className.includes('partial'))

  const actText = () => textOf(walk(statusPane())
    .find((e) => e.className.split(' ').indexOf('act') > -1)!)
  // One clock, and it is stated. The second lane that used to carry sweep
  // times was measured pixel-exact against the columns and STILL read as
  // broken — a sweep at 03:40 empties the 02:00 bar, so its mark stood beside
  // the bar it had emptied rather than above it.
  check('the chart says which clock its bars are on',
    actText().includes('placed by when a post arrived'))
  check('...and there is no second lane to disagree with them',
    !ADMIN_PAGE.includes("class: 'lane'") && !ADMIN_PAGE.includes("class: 'mark'"))
  check('the sweep is listed with its count', actText().includes('−5'))
  check('...and what triggered it', actText().includes('blocklist'))
  check('...naming the account nobody would have seen otherwise',
    actText().includes('@spammer'))
  check('...and how the post read', actText().includes('buy my thing'))
  check('a sweep the cap refused is shown too', actText().includes('held back'))
  check('...with what it would have taken', actText().includes('180 of 1400'))

  const outLinks = find(actCard, 'a').filter((a) => (a.attrs.href || '').includes('bsky.app'))
  check('a removed post can still be opened', outLinks.length === 5)
  check('...without handing Bluesky the admin URL',
    outLinks[0].attrs.rel === 'noreferrer noopener')

  const sweepBtn = walk(actCard).find((e) => e.className === 'btitle')!
  check('a sweep starts collapsed', sweepBtn.attrs['aria-expanded'] === 'false')
  sweepBtn.handlers['click']()
  check('...and opens', sweepBtn.attrs['aria-expanded'] === 'true')
  check('...highlighting the hours its posts came from',
    cols[20].className.includes('hi') && !cols[22].className.includes('hi'))
  // Four rows off one blocklist entry share one reason, and printing it under
  // each is the same sentence four times — the volume at which a hint stops
  // being read, which the pattern groups already learned once.
  check('one shared reason is stated once, not per row',
    actText().split('All removed: on moderation list').length - 1 === 1 &&
      actText().split('removed: on moderation list').length - 1 === 1)
  // Otherwise the row says -5 while one column lights up, and the chart looks
  // like it disagrees with the number next to it.
  check('rows older than the chart are counted, not quietly dropped',
    actText().includes('1 of these arrived before this window'))

  const refreshNow = walk(app).find((e) => e.textContent === 'Refresh')!
  refreshNow.handlers['click']()
  await settle()
  check('an open sweep survives a Refresh, like every other pane state',
    walk(statusPane()).find((e) => e.className === 'btitle')!.attrs['aria-expanded'] === 'true')

  const actPicker = find(app, 'select')[0]
  actPicker.value = 'radio'
  actPicker.handlers['change']()
  await settle()
  const radioCols = colsIn(statusPane())
  check('the chart follows the feed picker', radioCols[22].attrs['data-stored'] === '2')
  // A zero here means "retention already took it", which is a different fact
  // from "nothing arrived" and must not be drawn as the same bar.
  check('...marking the hours retention has already cut',
    radioCols[5].className.includes('outside'))
  check('...and leaving the rest alone', !radioCols[22].className.includes('outside'))
  actPicker.value = 'coffee'
  actPicker.handlers['change']()
  await settle()
  check('switching back restores the first feed',
    colsIn(statusPane())[22].attrs['data-stored'] === '7')

  activityEmpty = true
  refreshNow.handlers['click']()
  await settle()
  // A feed is selected here, so the sentence is the scoped one. Asserted on the
  // behaviour — words, naming this feed, mentioning the window — rather than on
  // the exact string, which is the kind of check that turns a wording decision
  // into a failing build.
  check('a quiet day says so in words rather than showing an empty strip',
    /Nothing was removed from this feed .*last 24 hours/.test(textOf(statusPane())))
  activityEmpty = false
  refreshNow.handlers['click']()
  await settle()
  check('...and the numbers come back', colsIn(statusPane())[22].attrs['data-stored'] === '7')
  // The mode pill wears the chart's own orange, so it must not fall back to the
  // generic --warn pill: assert the CLASS on the row, since the colour itself
  // lives in the stylesheet and is checked there.
  const sweepPill = walk(statusPane()).find((e) => e.className === 'pill purged')
  check('a sweep names its mode in the chart\'s colour',
    !!sweepPill && sweepPill.textContent === 'blocklist', sweepPill?.textContent)
  check('...and no sweep row is left on the generic warn pill',
    !walk(statusPane()).some((e) => e.className === 'pill warn' &&
      ['filter', 'blocklist', 'manual'].includes(e.textContent)))

  console.log('\n── the editor shows one feed, chosen from a dropdown above it')
  const selects = find(app, 'select')
  check('there is a feed picker', selects.length > 0)
  const picker = selects[0]
  check('...with an option per feed', picker.children.length === 3,
    picker.children.map((o) => o.textContent).join(' / '))
  // A <select> is as wide as its longest option, which is what pushed the page
  // off a phone screen. The name alone; the rest goes on the line below.
  check('...labelled by name only', picker.children[0].textContent === 'Coffee')
  check('...with the rkey and count underneath it instead',
    textOf(app).includes('coffee — 100 posts stored'))
  const pickerIdx = walk(app).indexOf(picker)
  const firstBlock = walk(app).find((e) => e.className.includes('block'))!
  check('...positioned ABOVE the blocks', pickerIdx < walk(app).indexOf(firstBlock))

  console.log('\n── the tabs')
  const tabBtn = (label: string) =>
    walk(app).find((e) => e.attrs.role === 'tab' && e.textContent === label)!
  const panelOf = (id: string) => walk(app).find((e) => e.attrs.id === 'panel-' + id)!
  check('there is a tablist', walk(app).some((e) => e.attrs.role === 'tablist'))
  for (const label of ['Filters', 'Lab', 'Record', 'Status', 'Security']) {
    check(`tab: ${label}`, !!tabBtn(label))
  }
  check('Filters is the one open', tabBtn('Filters').attrs['aria-selected'] === 'true')
  check('...and only it is a tab stop', tabBtn('Lab').attrs.tabindex === '-1')
  check('the other panels are hidden, not absent',
    panelOf('lab').className === 'hidden' && panelOf('status').className === 'hidden')
  // Hidden, not removed — that is what lets a half-typed pattern and an open
  // 2FA enrolment survive being navigated away from.
  check('...so the status panel still holds its content',
    textOf(panelOf('status')).includes('Retention sweep'))
  check('the feed picker sits outside the tabs, above them',
    !walk(panelOf('filters')).some((e) => e.attrs.id === 'feedsel') &&
      walk(app).some((e) => e.attrs.id === 'feedsel'))

  console.log('\n── the blocks')
  for (const label of ['Input', 'Remove if — item has labels', 'Remove — list of users',
                       'Always applied — no setting for these']) {
    check(`block: ${label}`, all.includes(label))
  }
  check('patterns are grouped under one header each',
    all.includes('A post enters the feed if ANY of these match') &&
      all.includes('A post is dropped if ANY of these match'))
  // Thirteen copies of one sentence is the volume at which nobody reads it.
  check('...said once per group, not once per pattern',
    all.split('A post is dropped if ANY').length - 1 === 1)
  check('each group has its own add button',
    walk(app).filter((e) => e.textContent === '+ Add pattern').length === 2)
  check('the pattern is loaded into its block',
    find(app, 'textarea').some((t) => t.value.includes('coffee')))
  check('its comment travels with it',
    find(app, 'input').some((i) => i.value === 'the topic'))
  check('the moderation list is loaded',
    find(app, 'input').some((i) => i.value.includes('app.bsky.graph.list')))
  check('target chips are rendered', all.includes('Post Text') && all.includes('Image Alt Text'))
  check('fixed blocks are marked as such', all.includes('fixed'))
  check('...and say replies are always dropped', all.includes('Replies are removed'))

  // "RegEx — remove #7" told you nothing and went stale the moment anything
  // above it was deleted. The comment is where the editorial reason lives, so a
  // shut list of them reads as the policy it is.
  console.log('\n── a pattern block calls itself by its comment')
  const titles = walk(app).filter((e) => e.className === 'ptitle').map((e) => e.textContent)
  check('the commented pattern is titled by its comment',
    titles.indexOf('the topic') >= 0, titles.join(' / '))
  check('...and one without a comment falls back to the expression',
    titles.indexOf('\\bdiscount\\b') >= 0, titles.join(' / '))
  check('no block is numbered any more', !all.includes('RegEx — keep #1'))
  const patBlock = walk(app).find((e) =>
    e.className.includes('block') && textOf(e).includes('the topic'))!
  const patBody = walk(patBlock).find((e) => e.className.indexOf('bbody') === 0)!
  check('a block with something in it starts shut',
    patBody.className.includes('hidden'), patBody.className)
  const disclosure = walk(patBlock).find((e) => e.className === 'btitle')!
  check('...saying so to a screen reader', disclosure.attrs['aria-expanded'] === 'false')
  // The caret was the character U+25B8, "BLACK RIGHT-POINTING SMALL TRIANGLE",
  // and small is the point: it read as a bullet at any font-size, so nobody
  // could tell the row opened. It is drawn in CSS off aria-expanded now, and
  // carries no text at all — assert that, or the glyph creeps back.
  const caret = walk(patBlock).find((e) => e.className === 'caret')!
  check('...with a caret that is drawn, not typed', caret.textContent === '', caret.textContent)
  check('...sized in pixels and rotated by state',
    /\.btitle \.caret \{[^}]*border-left: \d+px solid/.test(css) &&
      /\.btitle\[aria-expanded="true"\] \.caret \{[^}]*rotate\(90deg\)/.test(css))
  const bodyTextarea = find(patBlock, 'textarea')[0]
  disclosure.handlers['click']()
  check('opening it shows the body', !patBody.className.includes('hidden'))
  check('...updating aria-expanded', disclosure.attrs['aria-expanded'] === 'true')
  // Collapsing that destroyed the field would be the same bug as the redraw it
  // replaced, one level down.
  check('...and it is the same textarea, not a rebuilt one',
    find(patBlock, 'textarea')[0] === bodyTextarea)
  disclosure.handlers['click']()
  check('shutting it hides the body again', patBody.className.includes('hidden'))

  // The loop this project actually runs on is: edit a token, measure, decide.
  // It used to mean copying the expression into the Lab further down the page
  // and setting the target again by hand — four steps of clerical work between
  // the question and the answer, which is how measuring stops happening.
  console.log('\n── a pattern can measure itself')
  // Scoped to the panel: the Lab has a button of the same name, and searching
  // the whole page found that one first.
  const countBtns = walk(panelOf('filters')).filter((e) => e.textContent === 'Count matches')
  check('every pattern block offers a count', countBtns.length === 2, `${countBtns.length}`)
  const beforeProbes = probes.length
  countBtns[1].handlers['click']()
  await settle()
  check('...asking about this feed', probes[beforeProbes]?.feed === 'coffee')
  check('...with this block\'s own expression',
    probes[beforeProbes]?.pattern === '\\bdiscount\\b', probes[beforeProbes]?.pattern)
  check('...and its own target, not the Lab default',
    probes[beforeProbes]?.target === 'text|alt_text|link')
  // For an exclude the count is not an indication, it is the answer.
  check('...reporting an exclude as what would leave',
    textOf(app).includes('2 of 100 stored would go'))
  const countAll = walk(app).filter((e) => e.textContent === 'Count all')
  check('a whole group can be counted at once', countAll.length === 2)

  console.log('\n── the action bar')
  const bar = walk(app).find((e) => e.className.indexOf('actions') === 0)!
  check('the actions are in a bar of their own', !!bar)
  check('...carrying Save', walk(bar).some((e) => e.textContent === 'Save'))
  check('...and the unsaved marker', walk(bar).some((e) => e.className.includes('warn-text')))
  check('...shown while the filters are open', !bar.className.includes('hidden'))
  check('...with room reserved for it', app.className === 'hasbar')

  // Every one of these used to go through redraw(), which empties the block
  // list and builds it again. That is the same act the 30s poll was removed for
  // — it just had a person pressing it rather than a timer. Rebuilding a
  // textarea destroys its undo history, so a chip pressed halfway through
  // writing an alternation cost whoever pressed it their Cmd+Z, and it reverted
  // anything held only in the DOM (see the record card, further down).
  //
  // Node IDENTITY is the assertion, because a rebuilt block looks identical in
  // every other respect: same tag, same value, same position.
  console.log('\n── editing a block does not rebuild the page under you')
  const patArea = find(app, 'textarea').find((t) => t.value.includes('coffee'))!
  const altChip = walk(app).find((e) => e.textContent === 'Image Alt Text')!
  check('the alt-text chip starts on', altChip.className.includes('on'))
  check('...and says so to a screen reader', altChip.attrs['aria-pressed'] === 'true')
  altChip.handlers['click']()
  check('toggling it keeps the very same textarea node',
    find(app, 'textarea').find((t) => t.value.includes('coffee')) === patArea)
  check('...repaints only that chip', !altChip.className.includes('on'))
  check('...updates aria-pressed with it', altChip.attrs['aria-pressed'] === 'false')
  check('...and marks the draft dirty', textOf(app).includes('unsaved change'))

  // The confirm() this replaced asked "Save <rkey>?" and said nothing
  // about the content — so it was answered yes every time, which is a reflex
  // and not a check.
  console.log('\n── Save says what it is about to do')
  check('the change is named, not just counted',
    textOf(app).includes('target text + alt → post text'), textOf(app).slice(0, 0))
  check('...and counted in the marker',
    textOf(app).includes('1 unsaved change to Coffee'))
  check('...under a heading that totals them',
    textOf(app).includes('Unsaved changes (1)'))
  check('...saying what Save will actually do',
    textOf(app).includes('keeping a backup') && textOf(app).includes('within five minutes'))

  const measureBtn = walk(app).find((e) => e.textContent === 'Measure')!
  const draftNow = async () => {
    measureBtn.handlers['click']()
    await settle()
    return measures[measures.length - 1]?.filters?.feeds?.coffee
  }
  check('...having actually changed the target in the draft',
    (await draftNow())?.includePatterns?.[0]?.target === 'text')

  // The × is one mis-tap away from an alternation built up over months, and the
  // draft is its only copy until Save.
  console.log('\n── removing a pattern can be undone')
  const xs = walk(app).filter((e) => e.className === 'x')
  check('each pattern block has a remove button', xs.length === 2)
  check('...labelled for a screen reader, not just "×"',
    xs[1].attrs['aria-label'] === 'Remove \\bdiscount\\b',
    xs[1].attrs['aria-label'])
  xs[1].handlers['click']()
  const removed = textOf(app)
  check('removing it says what went', removed.includes('Removed: \\bdiscount\\b'))
  check('...and offers Undo', walk(app).some((e) => e.textContent === 'Undo'))
  check('...having taken it out of the draft',
    ((await draftNow())?.excludePatterns || []).length === 0)
  const undo = walk(app).find((e) => e.textContent === 'Undo')!
  undo.handlers['click']()
  const restored = await draftNow()
  check('Undo puts the pattern back', restored?.excludePatterns?.length === 1)
  check('...the same one, at its own position',
    restored?.excludePatterns?.[0]?.pattern === '\\bdiscount\\b',
    JSON.stringify(restored?.excludePatterns))
  check('...and takes the offer away', !walk(app).some((e) => e.textContent === 'Undo'))

  console.log('\n── adding a pattern appends rather than rebuilding')
  const addKeep = walk(app).filter((e) => e.textContent === '+ Add pattern')[0]
  addKeep.handlers['click']()
  check('the existing textarea is still the same node',
    find(app, 'textarea').find((t) => t.value.includes('coffee')) === patArea)
  check('...and the draft has the new pattern',
    ((await draftNow())?.includePatterns || []).length === 2)

  // The whole reason tabs are switched by toggling .hidden rather than by
  // rendering the chosen one: an edit in progress must not be a thing you can
  // lose by looking at something else.
  console.log('\n── moving between tabs keeps everything alive')
  const beforeTabs = find(app, 'textarea').find((t) => t.value.includes('coffee'))!
  tabBtn('Status').handlers['click']()
  check('the tab follows the click', tabBtn('Status').attrs['aria-selected'] === 'true')
  check('...hiding the filters', panelOf('filters').className === 'hidden')
  check('...but the bar stays, because there are unsaved changes',
    !walk(app).find((e) => e.className.indexOf('actions') === 0)!.className.includes('hidden'))
  tabBtn('Filters').handlers['click']()
  check('coming back finds the very same field',
    find(app, 'textarea').find((t) => t.value.includes('coffee')) === beforeTabs)
  // A Refresh rebuilds the status and security panels; the open tab is held
  // outside them so it cannot be reset by that.
  tabBtn('Security').handlers['click']()
  walk(app).find((e) => e.textContent === 'Refresh')!.handlers['click']()
  await settle()
  check('a Refresh does not throw you back to the first tab',
    tabBtn('Security').attrs['aria-selected'] === 'true')
  tabBtn('Filters').handlers['click']()

  console.log('\n── opening a feed does not count as editing it')
  picker.value = 'plain'
  picker.handlers['change']()
  await settle()
  check('a feed with nothing optional set opens clean',
    !textOf(app).includes('unsaved changes'))
  measureBtn.handlers['click']()
  await settle()
  const plain = measures[measures.length - 1]?.filters?.feeds?.plain
  check('...and drawing it added no retention key',
    !!plain && plain.retention === undefined, JSON.stringify(plain))
  picker.value = 'coffee'
  picker.handlers['change']()
  await settle()

  console.log('\n── the record card is separate from the filters')
  check('the card is shown', all.includes('Feed record — what readers see'))
  check('...loading the PUBLISHED name, not the internal label',
    find(app, 'input').some((i) => i.value === 'Coffee, published'))
  check('...and the published description',
    find(app, 'textarea').some((t) => t.value === 'the real one'))
  check('...with the avatar proxied through this origin, not a CDN',
    find(app, 'img').some((i) => (i.attrs.src || '').indexOf('/admin/feed/') === 0))
  check('...asking for an app password, and saying it is not stored',
    all.includes('forgotten') && all.includes('APP PASSWORD'))
  check('...with its own publish button, separate from Save',
    walk(app).some((e) => e.textContent === 'Publish to Bluesky'))
  check('there is no field for the internal label any more',
    !find(app, 'input').some((i) => (i.attrs.placeholder || '') === 'label for logs'))

  console.log('\n── the Jetstream instances panel')
  check('the configured endpoint is listed before any measurement',
    all.includes('jet1.example') && all.includes('in use'))
  const measureLag = walk(app).find((e) => e.textContent === 'Measure lag')!
  measureLag.handlers['click']()
  await settle()
  const probed2 = textOf(app)
  check('...every instance appears after measuring',
    probed2.includes('jet2.example') && probed2.includes('jet3.example'))
  check('...a badly lagging one is reported in hours', probed2.includes('2h'))
  check('...an unreachable one shows its error', probed2.includes('timed out'))
  // The results must survive the 30s refresh that redraws the status pane.
  await firePoll()
  check('...and the readings survive a status refresh',
    textOf(app).includes('jet2.example'))

  const useThis = walk(app).find((e) => e.textContent === 'use this')!
  check('a non-active instance offers a switch', !!useThis)
  check('...and that column is labelled', probed2.includes('Ingest source'))
  useThis.handlers['click']()
  await settle()
  const chosen = textOf(app)
  check('...which hands over the exact .env line',
    chosen.includes('FEEDGEN_SUBSCRIPTION_ENDPOINT="wss://jet2.example"'))
  check('...and the restart command', chosen.includes('docker compose up -d feedgen'))
  check('...saying plainly that the page cannot do it itself',
    chosen.includes('cannot restart itself'))

  console.log('\n── the identity check')
  const idBtn = walk(app).find((e) => e.textContent === 'Check identity')!
  check('it is a button, not part of the refresh', !!idBtn)
  check('...and asks nothing until pressed', !all.includes('This box expects'))
  idBtn.handlers['click']()
  await settle()
  const ident = textOf(app)
  check('...reporting what Bluesky calls', ident.includes('https://old.example.com'))
  check('...against what this box expects', ident.includes('https://feed.example.com'))
  check('...and flagging the mismatch', ident.includes('MISMATCH'))

  console.log('\n── the retention sweep is reported')
  check('the last sweep is shown', all.includes('Retention sweep'))
  check('...with when the next one is due', all.includes('Next in'))

  console.log('\n── probing a single pattern')
  const countBtn = walk(panelOf('lab')).find((e) => e.textContent === 'Count matches')!
  check('there is a probe button', !!countBtn)
  const patField = find(app, 'input').find((i) =>
    (i.attrs.placeholder || '').indexOf('other term') >= 0)!
  patField.value = '\\bcoffee\\b'
  countBtn.handlers['click']()
  await settle()
  check('...it asks about the open feed', probes[0]?.feed === 'coffee')
  check('...case-insensitively by default', probes[0]?.flags === 'iu')
  check('...over text, alt and links by default',
    probes[0]?.target === 'text|alt_text|link')
  const probed = textOf(app)
  check('...reporting the count and the share',
    probed.includes('posts touched') && probed.includes('of 100 stored'))
  check('...and what it matched in each', probed.includes('Matched'))

  // The field takes a JS RegExp and nothing on the page said what \b, a bare
  // word or a trailing * actually catch. A disclosure, so the card stays three
  // controls and a sentence for anyone who already knows.
  console.log('\n── the regex reference under Try a pattern')
  const labText = textOf(panelOf('lab'))
  check('whyNot is asked first, the probe comes after it',
    labText.indexOf('Why is this post (not) in a feed?') <
      labText.indexOf('Try a pattern'))
  const rxToggle = walk(panelOf('lab')).find((e) =>
    (e.textContent || '').includes('Regex — what each form catches'))!
  check('the probe card offers a reference', !!rxToggle)
  const rxBody = rxToggle.parent!.parent!.children[1]
  check('...shut to start with',
    rxToggle.attrs['aria-expanded'] === 'false' && rxBody.className === 'hidden')
  rxToggle.handlers['click']()
  check('...opening on one click',
    rxToggle.attrs['aria-expanded'] === 'true' && rxBody.className === '')
  const rx = textOf(rxBody)
  // Examples, not definitions. "\b is a word boundary" is exactly the sentence
  // that cannot be applied to the token in front of you.
  //
  // Matched as whole CELLS, not as substrings of the panel: every expression
  // here is discussed again in the notes below the tables, so a check on the
  // panel text alone went on passing with the examples deleted — and the
  // examples are the half that was asked for.
  const rxCells = walk(rxBody).map((e) => e.textContent)
  check('...answering in examples, both sides of each one',
    rx.includes('Catches') && rx.includes('Leaves alone'))
  check('...so the \\b row says what it lets through and what it does not',
    rxCells.includes('\\bvinyl\\b') && rx.includes('vinylcollector'))
  // The four-backslash trap, seen from the far end: with two, every expression
  // in this table would render as a little box.
  check('...with real backslashes, not backspaces',
    rx.includes('\\b') && !rx.includes('\u0008'))
  check('...* shown repeating one letter, not standing in for a word',
    rxCells.includes('vinyl*') && rxCells.includes('viny · vinyl · vinylll'))
  check('...the Cyrillic trap gets a row, and the fix the row beneath it',
    rxCells.includes('\\bвинил\\b') &&
      rxCells.includes('(?<!\\p{L})винил(?!\\p{L})'))
  // Phrases only the notes use — 'not a wildcard' also sits in a table cell,
  // so asking for that would be the examples answering for the prose again.
  check('...and the traps are spelled out under the tables',
    rx.includes('repeats whatever stands immediately before it') &&
      rx.includes('cannot see Cyrillic') && rx.includes('Type ONE backslash'))
  rxToggle.handlers['click']()
  check('...and it shuts again', rxBody.className === 'hidden')

  console.log('\n── the whyNot panel')
  check('the panel is there', all.includes('Why is this post (not) in a feed?'))
  // Both the pin field and this one accept a post link, and the pin block is
  // declared later in this file — so pick by position, not by identity.
  const linkFields = find(app, 'input').filter((i) =>
    (i.attrs.placeholder || '').indexOf('bsky.app/profile') >= 0)
  const whyInput = linkFields[linkFields.length - 1]
  const explain = walk(app).find((e) => e.textContent === 'Explain')!
  check('...with a field and a button', !!whyInput && !!explain)
  whyInput.value = 'https://bsky.app/profile/ann.example/post/1'
  explain.handlers['click']()
  await settle()
  const why = textOf(app)
  check('...answering for the feed being edited', why.includes('Coffee'))
  check('...with its verdict', why.includes('matches'))
  check('...naming what the include matched',
    why.includes('Matched on') && why.includes('"coffee"'))
  check('...flagging when the DB and the filter disagree', why.includes('NOT stored'))
  // The other feeds here are unrelated to this one, so their "no pattern
  // matched" is noise: it must be collapsed until asked for.
  check('other feeds are folded away', !why.includes('not in includeDids'))
  check('...but counted', why.includes('other feeds (1)') && why.includes('none matched'))
  const more = walk(app).find((e) => (e.textContent || '').indexOf('other feeds') >= 0)!
  more.handlers['click']()
  const expanded = textOf(app)
  check('...and one click shows them', expanded.includes('not in includeDids'))

  // The bug this panel was reported for: a dropped post said only which RULE
  // fired, and the rule is an alternation of a hundred branches. Naming the
  // rule without naming the branch is not an answer — you cannot act on it.
  console.log('\n── a dropped post names the word, not just the rule')
  whyInput.value = 'https://bsky.app/profile/ann.example/post/blocked'
  explain.handlers['click']()
  await settle()
  const blocked = textOf(app)
  check('the matched word is quoted', blocked.includes('"artist"'), blocked.slice(0, 0))
  check('...and it is marked up, not buried in a sentence',
    walk(app).some((e) => e.className === 'hit' && e.textContent === '"artist"'))
  check('...the rule is named alongside it',
    blocked.includes('offtopic: 3D/models/art/etc'))
  check('...and where it matched', blocked.includes('text, alt text and links'))
  // Either half alone is a riddle: it got in on one word and was thrown out on
  // another, and both are worth knowing.
  check('...plus how it got as far as the exclude gate',
    blocked.includes('It had matched') && blocked.includes('"coffee"'))
  // With a named rule there is nothing left for the expression to add, so it
  // is not shown at all — the rule name is what finds the block in the editor.
  check('the truncated expression is gone entirely', !blocked.includes('animation'))

  console.log('\n── the new-feed wizard')
  const newBtn = walk(app).find((e) => e.textContent === '+ New feed')!
  check('there is a way in', !!newBtn)
  check('...closed to begin with', !all.includes('Record key (rkey)'))
  newBtn.handlers['click']()
  const wiz = textOf(app)
  check('...opening the form', wiz.includes('Record key (rkey)'))
  check('...warning the rkey is permanent', wiz.includes('cannot be changed later'))
  check('...and that a restart is still needed', wiz.includes('restart'))

  // A \b written with one backslash too few stops being a word boundary and
  // becomes the BACKSPACE character, which the browser draws as a little box.
  // Nothing else notices: the page parses, renders and behaves normally.
  // These rules are the difference between a page that fits a phone and one
  // that slides sideways; each was added after a real overflow, and deleting
  // any of them brings that overflow back silently.
  console.log('\n── the page is allowed to fit a narrow screen')
  for (const rule of [
    '.kv dd { min-width: 0; overflow-wrap: anywhere; }',
    '.picker select { flex: 1; min-width: 0;',
    '@media (max-width: 40rem)',
    'flex-direction: column',
    'grid-template-columns: 1fr',
  ]) {
    check(`css keeps: ${rule.slice(0, 46)}`, css.includes(rule))
  }
  check('a value with nowhere to break still may', css.includes('.kv dd { min-width: 0; overflow-wrap: anywhere; }'))
  // The regression this replaced: 'anywhere' on cells crushed the table into
  // the viewport and broke words by the letter instead of scrolling.
  check('table cells break at words, never mid-word',
    css.includes('th, td { overflow-wrap: break-word; }') &&
      !css.includes('th, td, .mono'))
  check('a table keeps a floor so its container scrolls',
    css.includes('.wrap table { min-width: 30rem; }'))

  // Reported from real use: on the Security card the password field sat flush
  // against the "two-factor ON" pill — a measured 0px between two rows, which
  // reads as one control growing out of another. `.row.wrapx` zeroed the top
  // margin so a row OPENING a card would not push off the edge, and took it
  // from every following row as well.
  check('consecutive rows keep a gap between them',
    css.includes('.row.wrapx:not(:first-child) { margin-top: .7rem; }'))
  // Same row, second cause: input[type=text] is width:100% for the login form,
  // so every control in that row claimed a full line and it stacked into three.
  check('a six-digit field is six digits wide', css.includes('input.code { width: 9rem;'))
  // Two rules both match input[type=text]; the later one wins. While they
  // disagreed a text field was 35px beside a 39px password field and a 39px
  // button, so any row mixing them came out stepped.
  const cssRulesForPad = css.replace(/\/\*[\s\S]*?\*\//g, '').match(/[^{}]+\{[^}]*\}/g) || []
  const padOf = (sel: string) => {
    const m = cssRulesForPad.find((r) => r.trim().startsWith(sel))
    return (m?.match(/padding:\s*([^;]+);/) || [])[1]?.trim()
  }
  check('text and password fields declare the same padding',
    padOf('input[type=password], input[type=text]') === padOf('input[type=text], input[type=number]'),
    `${padOf('input[type=password], input[type=text]')} vs ${padOf('input[type=text], input[type=number]')}`)
  // A field is as much a touch target as a button. The 44px rule had been
  // given to buttons alone, which left every mixed row stepped by 5px.
  check('fields get the same touch target as the buttons beside them',
    css.includes('input:not([type=file]), select { min-height: 44px; }'))

  // Reported from a screenshot. The chrome row mixes a 1.1rem title, a .85em
  // mono box name and a pill, and a pill is a box rather than a word: its
  // border and padding sit outside the text a baseline would match. Measured in
  // a browser, the three centres were 42.89 / 44.76 / 44.70 — the title ~2px
  // high and the oval visibly lifted off the line. Centring makes them agree to
  // 0.01px. Assert both halves: baseline coming back is the regression.
  check('the chrome row centres its title, box name and pill',
    css.includes('header { display: flex; align-items: center;') &&
      !/header \{[^}]*align-items: baseline/.test(css))
  // The picker sat flush on the header's rule — a measured 0px, which reads as
  // the select hanging off the border rather than starting a section. 1rem is
  // the gap the tabs already keep below it, so the row sits evenly between.
  check('the feed picker keeps a gap below the header rule',
    /\.picker \{[^}]*margin: 1rem 0 \.8rem;/.test(css))

  // A pill or a button SHOULD flip with the theme; a data series should not —
  // the same bar changing hue because the phone went dark is a different
  // reading of the same number. Declared once outside the media query.
  check('the chart palette is one palette in both themes',
    css.includes('--chart-stored: #6ea8fe;') && css.includes('--chart-removed: #f97316;'))
  // The dark BLOCK, not everything after it: the rules further down USE these
  // variables, and a search over the remainder of the sheet matches a use as
  // readily as a redefinition. The first attempt did exactly that and failed.
  const darkStart = css.indexOf('@media (prefers-color-scheme: dark)')
  const darkBlock = css.slice(darkStart, css.indexOf('\n  }', darkStart))
  check('...and the dark theme does not redefine it',
    darkStart > -1 && !darkBlock.includes('--chart-stored:') &&
      !darkBlock.includes('--chart-removed:'),
    darkBlock.slice(0, 60))
  check('the series use it rather than --accent/--warn',
    css.includes('.act .seg.stored { background: var(--chart-stored);') &&
      css.includes('.act .seg.purged { background: var(--chart-removed);'))
  // By request: the mode pill names the amber above it, so it wears the SAME
  // orange. --warn would be a second orange for one idea, and the pill sits
  // directly under the bars it describes.
  check('a sweep\'s mode pill takes the chart orange, not --warn',
    css.includes('.pill.purged { color: var(--chart-removed); }'))
  // The symptom this prevents: the page is built by script after the first
  // layout, so iOS keeps a layout viewport sized to whatever JS injected and
  // lets the whole page be dragged sideways until a pinch resets it.
  // iOS zooms the page in when focus enters a control under 16px and never
  // zooms out again — the single cause of "opens at ~105% and drags sideways".
  // iOS zooms the page in when focus enters a control under 16px and does NOT
  // zoom back out on blur. `font: inherit` on a 15px page is exactly that, and
  // a 16px rule in a media query loses the cascade to input[type=...] — which
  // is how the password and 2FA fields stayed 15px while everything else was
  // "fixed". Assert the outcome, not the intention: every typable control
  // declares 16px itself, and none of them inherits its size.
  // Comments stripped first. The pattern below treats everything between one }
  // and the next { as a selector, so a comment that merely MENTIONS a textarea
  // gets glued onto the rule after it — and that rule is then held to a
  // requirement about form controls it was never part of. The check is about
  // rules; a comment is not one.
  const cssRules = css.replace(/\/\*[\s\S]*?\*\//g, '')
  const controlRules = cssRules.match(/[^{}]*(?:input|select|textarea)[^{}]*\{[^}]*\}/g) || []
  const typable = controlRules.filter((r) => !r.includes('type=file'))
  check('every typable control declares its own size', typable.length >= 4, `${typable.length} rules`)
  check('...and all of them are 16px',
    typable.every((r) => !/font(-size)?\s*:/.test(r) || r.includes('16px')),
    typable.filter((r) => /font(-size)?\s*:/.test(r) && !r.includes('16px')).join(' | ').slice(0, 90))
  check('no control takes its size from `font: inherit`',
    !/(?:input|select|textarea)[^{}]*\{[^}]*font:\s*inherit/.test(cssRules))
  // iOS ignores overflow-x: hidden on html/body — it has to be on a wrapper,
  // which is what <main> is. An earlier fix put it only on the root and did
  // nothing at all.
  check('the wrapper, not the root, is what blocks sideways scrolling',
    css.includes('position: relative; overflow-x: hidden; overscroll-behavior-x: none;'))
  check('no legacy -webkit-overflow-scrolling to override it',
    !css.includes('-webkit-overflow-scrolling'))
  check('grid children may shrink too', css.includes('.grid > * { min-width: 0; }'))
  check('a card is sized by its container, not by the table inside it',
    css.includes('width: 100%; max-width: 100%; }'))
  check('the page uses one gutter for both edges',
    css.includes('padding: 1.5rem var(--gutter) 3rem') &&
      css.includes('padding: 1rem var(--gutter) 3rem'))
  check('nothing may exceed its container',
    css.includes('input, select, textarea, img, pre { max-width: 100%; }'))

  // The page is one template literal, so a backtick anywhere inside it — in a
  // comment, in a code span — ends the string early and breaks the build. It
  // has now happened once with backslashes and once with backticks.
  console.log('\n── the page source stays inside its template literal')
  check('no stray backticks in the rendered page', !ADMIN_PAGE.slice(1, -1).includes('`'))
  // A pill that wraps in a narrow column becomes a circle, because of its own
  // 999px radius. Both badge shapes must stay on one line.
  check('badges never wrap into circles',
    /\.pill \{[^}]*white-space: nowrap/.test(ADMIN_PAGE) &&
      /\.chip \{[^}]*white-space: nowrap/.test(ADMIN_PAGE))

  console.log('\n── nothing invisible leaks into the UI')
  const CTRL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/
  const dirty = walk(app).filter(
    (e) => CTRL.test(e.attrs.placeholder || '') || CTRL.test(e.textContent || ''),
  )
  check(
    'no control characters in any label or placeholder',
    dirty.length === 0,
    dirty.map((e) => JSON.stringify(e.attrs.placeholder || e.textContent)).join(' '),
  )
  // The check above walks the DOM, so it can only see what the page BUILDS.
  // Four backspaces reached the live page anyway, all of them in COMMENTS: a
  // comment sits inside the template literal like everything else, so a bare
  // \b in one is an escape too. Harmless inside a //, invisible in a diff, and
  // no reason to keep — this is the check that would have said so.
  const ctrlLines = ADMIN_PAGE.split('\n').filter((l) => CTRL.test(l))
  check('nor anywhere else in the page, comments included',
    ctrlLines.length === 0, JSON.stringify(ctrlLines[0] || ''))

  console.log('\n── retention offers a fixed set of ages')
  const inputBlock = walk(app).find((e) => e.textContent === 'Input')!
  const retSelects = find(app, 'select')
  const ages = retSelects.find((sel) =>
    sel.children.some((o) => o.textContent.indexOf('168 hours') === 0))
  check('the age list is a dropdown', !!ages && !!inputBlock)
  check('...offering exactly 3 / 12 / 24 / 72 / 168',
    ages!.children.map((o) => o.attrs.value).join(',') === '3,12,24,72,168',
    ages!.children.map((o) => o.attrs.value).join(','))
  check('...with the feed\'s own value selected', ages!.value === '72')
  check('...spelling the long ones out in days',
    ages!.children.some((o) => o.textContent === '72 hours (3 days)'))

  console.log('\n── the moderation list can be pasted as a bsky.app link')
  const listInput = find(app, 'input').find((i) =>
    (i.attrs.placeholder || '').indexOf('/lists/') >= 0)!
  check('the field asks for a link, not only a URI', !!listInput)
  listInput.value = 'https://bsky.app/profile/stanislavski.me/lists/3msv'
  listInput.handlers['blur']()
  await settle()
  check('...and blurring resolves it', resolvedLists.length === 1)
  check('...replacing a web link with the at:// URI the config needs',
    listInput.value === 'at://did:plc:y5/app.bsky.graph.list/3msv', listInput.value)
  check('...naming the list and how many accounts are on it',
    textOf(app).includes('blocked accounts') && textOf(app).includes('2 accounts'))

  console.log('\n── a pin can be pasted as a bsky.app link')
  const pinInput = find(app, 'input').find((i) =>
    (i.attrs.placeholder || '').indexOf('/post/') >= 0)!
  check('the field asks for a link, not a URI', !!pinInput)
  pinInput.value = 'https://bsky.app/profile/mcwyrm.bsky.social/post/3mscgyghtjc2f'
  pinInput.handlers['change']()
  await settle()
  check('...and blurring resolves it', resolved.length === 1)
  check('...replacing the field with the at:// URI',
    pinInput.value === 'at://did:plc:mc/app.bsky.feed.post/3msc', pinInput.value)
  check('...showing whose post it is', textOf(app).includes('@mcwyrm.bsky.social'))

  // It edits filters.json, so it used to sit with the other config blocks. The
  // user asked for it on the Lab tab; what has to stay true is that it still
  // feeds the SAME draft and goes out with the same Save.
  console.log('\n── the pin block lives on the Lab tab')
  check('the card is in the Lab panel',
    textOf(panelOf('lab')).includes('Pinned post'))
  // Not a text search: the unsaved-changes card lives on the Filters tab and
  // legitimately says "Pinned post set" while a pin is being edited. What must
  // have moved is the heading, so look for that.
  check('...as an h2 above a card, the way every other section on Lab is built',
    walk(panelOf('lab')).some((e) =>
      e.tagName === 'H2' && e.textContent === 'Pinned post'))
  check('...and NOT as a filter block, whose label sits inside the card',
    !walk(app).some((e) => e.className === 'blabel' && e.textContent === 'Pinned post'))
  check('...so it is gone from the filter blocks entirely',
    !walk(panelOf('filters')).some((e) =>
      e.tagName === 'H2' && e.textContent === 'Pinned post'))
  check('...ahead of the two diagnostics on that tab',
    textOf(panelOf('lab')).indexOf('Pinned post') <
      textOf(panelOf('lab')).indexOf('Why is this post (not) in a feed?'))
  check('...and it says the Save it belongs to is the shared one',
    textOf(panelOf('lab')).includes('same Save'))

  console.log('\n── Remove pin')
  const removeBtn = walk(panelOf('lab')).find((e) => e.textContent === 'Remove pin')!
  check('the button is there', !!removeBtn)
  check('...enabled while a pin is set', !removeBtn.disabled)
  removeBtn.handlers['click']()
  check('...clearing the field', pinInput.value === '')
  check('...disabling itself once there is nothing left to remove',
    removeBtn.disabled === true)
  check('...saying the removal is only in the draft',
    textOf(panelOf('lab')).includes('press Save'))
  // This feed has no pin in the saved config, so removing the one resolved a
  // moment ago puts the draft back where it started — the summary should lose
  // its entry, not gain a second one.
  check('...and the unsaved-changes summary drops the pin entry',
    !textOf(app).includes('Pinned post set'))

  const undoBtn = walk(panelOf('lab')).find((e) => e.textContent === 'Undo')!
  check('an Undo sits beside the message', !!undoBtn)
  undoBtn.handlers['click']()
  check('...putting the URI back',
    pinInput.value === 'at://did:plc:mc/app.bsky.feed.post/3msc', pinInput.value)
  check('...re-enabling Remove', !removeBtn.disabled)
  check('...and the summary reports the pin again',
    textOf(app).includes('Pinned post set'))

  console.log('\n── only the selected feed is shown')
  check('the other feed is not in the editor', !all.includes('did:plc:someone'))
  picker.value = 'radio'
  picker.handlers['change']()
  const radio = textOf(app)
  // The DIDs live in a textarea's value, not in its text content — the first
  // version of this check looked only at text and reported a working editor as
  // broken.
  check('switching the picker redraws for that feed',
    radio.includes('Authors — keep only these DIDs') &&
      find(app, 'textarea').some((t) => t.value.includes('did:plc:someone')))
  check('...and drops the first feed\'s patterns',
    !find(app, 'textarea').some((t) => t.value.includes('discount')))
  check('...showing its own retention unit', radio.includes('newest posts'))

  // The case the button actually exists for: a pin that is in the saved config,
  // taken off. The feed switch also proves the card is redrawn per feed rather
  // than carrying the previous feed's pin across.
  console.log('\n── removing a pin that was already saved')
  const radioPin = find(panelOf('lab'), 'input').find((i) =>
    (i.attrs.placeholder || '').indexOf('bsky.app/profile') >= 0)!
  check('the card shows this feed\'s own pin',
    radioPin.value === 'at://did:plc:someone/app.bsky.feed.post/pinned1',
    radioPin.value)
  const radioRemove = walk(panelOf('lab')).find((e) => e.textContent === 'Remove pin')!
  radioRemove.handlers['click']()
  check('...and removing it is reported as a change to save',
    textOf(app).includes('Pinned post cleared'))
  // Put it back: what this suite checks about the PUT below is the shape of the
  // whole config, and leaving a removal armed would make that a different test.
  walk(panelOf('lab')).find((e) => e.textContent === 'Undo')!.handlers['click']()
  check('...and Undo takes that back too',
    !textOf(app).includes('Pinned post cleared'))

  console.log('\n── saving sends the WHOLE config, not just the open feed')
  const save = walk(app).find((e) => e.tagName === 'BUTTON' && e.textContent === 'Save')!
  save.handlers['click']()
  await settle()
  check('a PUT was sent', puts.length === 1)
  const sent = puts[0]?.filters
  check('...carrying every feed', Object.keys(sent?.feeds ?? {}).join() === 'coffee,radio,plain',
    Object.keys(sent?.feeds ?? {}).join())
  check('...with the untouched feed byte-identical',
    JSON.stringify(sent.feeds.coffee) === JSON.stringify(FILTERS.filters.feeds.coffee))
  check('...preserving keys the editor does not model', sent._readme !== undefined)
  check('...and the digest it loaded', puts[0]?.expectedDigest === 'abc123abc123')

  // The editor stopped showing displayName; it must not have stopped saving it.
  // Same for any key it never modelled — the draft is a copy of the whole feed.
  picker.value = 'coffee'
  picker.handlers['change']()
  await settle()
  save.handlers['click']()
  await settle()
  const openFeed = puts[puts.length - 1]?.filters?.feeds?.coffee
  check('the open feed keeps a name the editor no longer shows',
    openFeed?.displayName === 'Coffee')
  check('...and keeps keys it never modelled', openFeed?._note !== undefined)
  // Put the picker back where the later sections expect to find it.
  picker.value = 'radio'
  picker.handlers['change']()
  await settle()

  // Reading the table and then hunting for the same feed in a dropdown was two
  // steps for one intention.
  console.log('\n── the feed table is a way in, not just a readout')
  const statusPanel = panelOf('status')
  const rowPick = walk(statusPanel).find((e) =>
    e.className === 'linkish' && e.textContent === 'Coffee')!
  check('a feed in the table can be clicked', !!rowPick)
  rowPick.handlers['click']()
  await settle()
  check('...which opens it in the editor', find(app, 'select')[0].value === 'coffee')
  check('...on the filters tab', tabBtn('Filters').attrs['aria-selected'] === 'true')
  // Scoped to the feed table, not to the panel. Taking the first link in the
  // whole panel stopped meaning "the first feed" the moment a card with links
  // of its own was added above it — the same collision that made the Lab's
  // "Count matches" drive the wrong control once.
  const feedTable = find(statusPanel, 'table').find((t) =>
    find(t, 'th').some((th) => th.textContent === 'rkey'))!
  const out = find(feedTable, 'a')[0]
  check('...and each row links to the live feed',
    (out?.attrs.href || '').indexOf('https://bsky.app/profile/did:plc:p/feed/') === 0,
    out?.attrs.href)
  // The avatars are proxied through this origin precisely so that nothing here
  // tells Bluesky the admin URL exists. A bare link out would undo that.
  check('...without handing Bluesky the referrer',
    (out?.attrs.rel || '').includes('noreferrer') &&
      out?.attrs.referrerpolicy === 'no-referrer')
  check('...and the page says so for everything else too',
    ADMIN_PAGE.includes('<meta name="referrer" content="no-referrer">'))

  console.log('\n── Cmd+S saves')
  const dids2 = find(app, 'textarea').find((t) => t.value.includes('coffee'))!
  dids2.value = '\\bcoffee\\b|\\bmocha\\b'
  dids2.handlers['input']()
  const putsBeforeKey = puts.length
  docHandlers['keydown']({ key: 's', metaKey: true, preventDefault: () => {} })
  await settle()
  check('the shortcut is bound', puts.length === putsBeforeKey + 1)
  check('...and it sent the edit', JSON.stringify(puts[puts.length - 1]?.filters?.feeds?.coffee)
    .includes('mocha'))
  docHandlers['keydown']({ key: 's', metaKey: true, preventDefault: () => {} })
  await settle()
  // Nothing to save is not a reason to write the file again.
  check('...and does nothing when there is nothing to save',
    puts.length === putsBeforeKey + 1)

  // Put the picker back where the later sections expect to find it — clicking
  // a row in the feed table moved it.
  picker.value = 'radio'
  picker.handlers['change']()
  await settle()

  // Validate answered in the one-line strip at the bottom of the window while
  // Measure got a block of stat tiles — the same kind of question, two very
  // different sizes of answer.
  console.log('\n── Validate answers in the same shape as Measure')
  // Self-contained: the feed left open by the section above has no patterns to
  // break, and a section that depends on where the last one stopped is how an
  // unrelated check fails four sections downstream.
  picker.value = 'coffee'
  picker.handlers['change']()
  await settle()
  const validate = walk(app).find((e) => e.textContent === 'Validate')!
  validate.handlers['click']()
  await settle()
  const valid = textOf(app)
  check('the counts get tiles, not a footnote',
    valid.includes('keep patterns') && valid.includes('remove patterns') &&
      valid.includes('author DIDs'))
  check('...and it says nothing was written', valid.includes('Save is what installs it'))

  // A pattern that will not compile is the likeliest thing to happen here, and
  // the error names the path it choked on — which is exactly what a 6rem
  // scrollable strip is worst at showing.
  const inc = find(app, 'textarea').find((t) => t.value.includes('coffee'))!
  const wasPattern = inc.value
  inc.value = '((('
  inc.handlers['input']()
  validate.handlers['click']()
  await settle()
  const refused = textOf(app)
  check('a refused config gets a block of its own', refused.includes('Config refused'))
  check('...naming the path it choked on',
    refused.includes('includePatterns[1]') || refused.includes('Invalid regular expression'),
    refused.includes('Config refused') ? 'block present' : 'no block')
  check('...and saying the running config is untouched',
    refused.includes('still running the config it already had'))
  inc.value = wasPattern
  inc.handlers['input']()
  picker.value = 'radio'
  picker.handlers['change']()
  await settle()

  console.log('\n── measuring an edit')
  const measure = walk(app).find((e) => e.textContent === 'Measure')!
  measure.handlers['click']()
  await settle()
  check('the request goes to the route that exists',
    requested.some((r) => r === 'POST /admin/lab/measure'),
    requested.filter((r) => r.indexOf('measure') >= 0).join(' '))
  const measured = textOf(app)
  check('...and the result is shown',
    measured.includes('posts would be removed') && measured.includes('would remain'))
  check('...naming who would go', measured.includes('@dee'))

  console.log('\n── setting up two-factor survives a refresh')
  const setup = walk(app).find((e) => e.textContent === 'Set up two-factor')!
  check('the Security panel offers it', !!setup)
  setup.handlers['click']()
  await settle()
  check('...the key is shown', textOf(app).includes('JBSWY3DPEHPK3PXP'))
  // The whole point: you leave for a password manager and come back, and the
  // panel must not have folded back to the button under you. Nothing refreshes
  // on its own any more, but a manual Refresh must not do it either.
  const refreshDuringEnrol = walk(app).find((e) => e.textContent === 'Refresh')!
  refreshDuringEnrol.handlers['click']()
  await settle()
  const afterRefresh = textOf(app)
  check('...and is STILL shown after a refresh', afterRefresh.includes('JBSWY3DPEHPK3PXP'))
  check('...which did not ask for a new key', totpBegins === 1)
  // Leave it closed, or every later poll in this file stays suppressed — which
  // is the behaviour under test, and would look like a different bug.
  const cancelEnrol = walk(app).find((e) => e.textContent === 'Cancel')!
  cancelEnrol.handlers['click']()
  await settle()
  check('cancelling puts the button back', textOf(app).includes('Set up two-factor'))

  console.log('\n── there is NO auto-refresh, and the page says how old it is')
  const beforePicker = find(app, 'select')[0]
  const beforeFetches = statusFetches
  check('nothing was scheduled to refetch', timers.length === 0, `${timers.length} timers`)
  check('the header states the age of the reading',
    textOf(app).includes('just now') || textOf(app).includes('as of'))

  console.log('\n── a manual Refresh must not disturb the editor')
  const refreshBtn = walk(app).find((e) => e.textContent === 'Refresh')!
  refreshBtn.handlers['click']()
  await settle()
  check('it refetched the status', statusFetches === beforeFetches + 1)
  check('...but did not rebuild the editor', find(app, 'select')[0] === beforePicker)
  check('...leaving the chosen feed selected', find(app, 'select')[0].value === 'radio')
  const dids = find(app, 'textarea').find((t) => t.value.includes('did:plc:someone'))!
  dids.value = 'did:plc:someone\ndid:plc:another'
  dids.handlers['input']()
  refreshBtn.handlers['click']()
  await settle()
  check('...and an unsaved edit survives it',
    find(app, 'textarea').some((t) => t.value.includes('another')))

  // The record card is refilled by every redraw(), and it used to be refilled
  // from the last PUBLISHED record — so a description typed here and not yet
  // published was reverted by any redraw at all. The state lives outside the
  // DOM now, keyed by rkey, which is the same treatment jetstream/identity/
  // totpEnrol get in the status pane.
  console.log('\n── unpublished record edits survive a redraw')
  const recDesc = find(app, 'textarea').find((t) => t.value === 'the real one')!
  check('the card is showing the published description', !!recDesc)
  recDesc.value = 'edited, not published'
  recDesc.handlers['input']()
  const descNow = () =>
    find(app, 'textarea').filter((t) => (t.attrs.placeholder || '').indexOf('description shown') === 0)[0]
  picker.value = 'coffee'
  picker.handlers['change']()
  await settle()
  check('switching feeds does not carry the edit across',
    descNow()?.value === 'the real one', descNow()?.value)
  picker.value = 'radio'
  picker.handlers['change']()
  await settle()
  check('...and coming back finds it still there',
    descNow()?.value === 'edited, not published', descNow()?.value)

  // The pending avatar was a single variable, so it was armed for whichever
  // feed happened to be open when Publish was pressed — an image chosen for one
  // feed would have been written to another feed's record on the PDS.
  console.log('\n── a chosen avatar belongs to the feed it was chosen for')
  const AVATAR = 'data:image/png;base64,AAA'
  const fileInput = find(app, 'input').filter((i) => i.attrs.type === 'file')[0]
  const avatarSrc = () => find(app, 'img').filter((i) => i.className === 'avatar')[0]?.attrs.src
  fileInput.files = [{ name: 'logo.png', size: 2048, dataUrl: AVATAR }]
  fileInput.handlers['change']()
  check('choosing one previews it', avatarSrc() === AVATAR, avatarSrc())
  check('...saying it is not published yet', textOf(app).includes('not published yet'))
  picker.value = 'coffee'
  picker.handlers['change']()
  await settle()
  check('the other feed shows its OWN avatar, not the pending one',
    (avatarSrc() || '').indexOf('/admin/feed/coffee/avatar') === 0, avatarSrc())
  picker.value = 'radio'
  picker.handlers['change']()
  await settle()
  check('...and the pending one is still pending on its own feed',
    avatarSrc() === AVATAR, avatarSrc())

  const publish = walk(app).find((e) => e.textContent === 'Publish to Bluesky')!
  // This one leaves the box: it writes to your repository on the PDS under
  // credentials just typed, where Save only touches a file here. Filled red by
  // request — an outline is mostly card colour whatever its border does, which
  // is why the first attempt still read as brick rather than as a danger zone.
  check('the button that writes to your PDS is marked as the danger it is',
    publish.className === 'outgoing' &&
      css.includes('button.outgoing { background: var(--danger); border-color: var(--danger);') &&
      css.includes('color: var(--on-fill); font-weight: 600; }'),
    publish.className)
  // --danger is an action colour and --bad is status text; they are different
  // reds on purpose, and both themes must declare the new one or the button
  // falls back to an unstyled background in one of them.
  check('...in a red of its own, declared in both themes',
    css.includes('--danger: #e02d22;') && darkBlock.includes('--danger: #ff4d43;') &&
      !css.includes('button.outgoing { background: none;'))
  publish.handlers['click']()
  await settle()
  check('publishing writes to the feed the image was chosen for',
    published[0]?.url === '/admin/feed/radio/record', published[0]?.url)
  check('...carrying that image', published[0]?.payload?.avatarBase64 === AVATAR)
  check('...and the description typed alongside it',
    published[0]?.payload?.description === 'edited, not published')

  // The session idles out after an hour. Everything below is about what that
  // must not cost: replacing the page with the login form throws away an edit
  // that exists nowhere else.
  console.log('\n── every .msg is announced, not just shown')
  const msgs = walk(app).filter((e) => /(^| )msg( |$)/.test(e.className))
  check('there are message areas to check', msgs.length > 0, `${msgs.length}`)
  check('...and all of them carry role=status',
    msgs.every((e) => e.attrs.role === 'status'),
    msgs.filter((e) => e.attrs.role !== 'status').map((e) => e.className).join(' / '))

  // The login form is the first thing every visitor sees and nothing here had
  // ever rendered it. It also reaches for window.matchMedia, which does not
  // exist in this stub — the branch has to survive that.
  console.log('\n── the login form renders')
  const signOut = walk(app).find((e) => e.textContent === 'Sign out')!
  signOut.handlers['click']()
  await settle()
  const login = textOf(app)
  check('signing out shows the form', login.includes('feedgen admin'))
  const fields = find(app, 'input')
  check('...with a username, a password and a code field', fields.length === 3,
    fields.map((f) => f.attrs.placeholder || f.attrs.type).join(' / '))
  check('...the username field is real, not readonly',
    !fields.some((f) => f.attrs.readonly !== undefined))
  check('...and it asked whether a second factor is needed',
    requested.some((r) => r.indexOf('/admin/api/login-meta') > 0))

  // Signing back in through the real form, which is also how the editor below
  // gets rebuilt.
  const loginForm = find(app, 'form')[0]
  fields[0].value = 'admin'
  fields[1].value = 'hunter2'
  loginForm.handlers['submit']({ preventDefault: () => {} })
  await settle()
  check('...and signing in brings the page back', textOf(app).includes('Coffee'))

  // An hour on the page with an unsaved edit is an ordinary afternoon. What
  // used to happen next: the 401 replaced the whole page with the login form,
  // and the edit — which existed nowhere else — went with it.
  console.log('\n── an expired session does not take unsaved work with it')
  const live = find(app, 'textarea').find((t) => t.value.includes('coffee'))!
  live.value = '\\bcoffee\\b|\\bespresso\\b'
  live.handlers['input']()
  const putsBefore = puts.length
  unauthorized = true
  const saveBtn = walk(app).find((e) => e.tagName === 'BUTTON' && e.textContent === 'Save')!
  saveBtn.handlers['click']()
  await settle()
  const overlay = walk(app).find((e) => e.className === 'modal')
  check('it asks for the password again, over the page', !!overlay)
  check('...saying what happened', textOf(app).includes('Session expired'))
  check('...leaving the unsaved edit exactly where it was',
    find(app, 'textarea').some((t) => t.value.includes('espresso')))
  check('...and the editor still standing behind it',
    walk(app).some((e) => e.attrs.id === 'feedsel'))
  // Re-sending the PUT unasked would replay a write against a config that may
  // have moved on — the clobber the digest guard exists to prevent.
  check('...having retried nothing on its own', puts.length === putsBefore)

  find(app, 'input').filter((i) => i.attrs.type === 'password')
    .forEach((i) => { i.value = 'hunter2' })
  const reauthForm = overlay!.children[0]
  reauthForm.handlers['submit']({ preventDefault: () => {} })
  await settle()
  check('signing in dismisses the prompt',
    !walk(app).some((e) => e.className === 'modal'))
  check('...and the edit is still there to save',
    find(app, 'textarea').some((t) => t.value.includes('espresso')))
  saveBtn.handlers['click']()
  await settle()
  check('...which now goes through', puts.length === putsBefore + 1)

  // With nothing to lose, the full login form is still the right answer.
  unauthorized = true
  walk(app).find((e) => e.textContent === 'Refresh')!.handlers['click']()
  await settle()
  check('a clean editor just gets the login form back',
    textOf(app).includes('Your session ended'))
  check('...and no prompt on top of it',
    !walk(app).some((e) => e.className === 'modal'))

  console.log('\n── filled surfaces are legible in both themes')
  // White text on the dark theme's lighter accents measured 2.4:1 and 2.25:1
  // against the 4.5:1 ordinary text needs. One variable, because each theme
  // keeps its fills at the opposite end of the scale from its text.
  check('there is a foreground colour for filled surfaces',
    css.includes('--on-fill: #ffffff;') && css.includes('--on-fill: #0b1220;'))
  check('...and the primary button uses it',
    /button\.primary \{[^}]*color: var\(--on-fill\)/.test(css))
  check('...as does a selected chip',
    /\.chip\.on \{[^}]*color: var\(--on-fill\)/.test(css))
  check('no filled surface hard-codes white any more',
    !/(?:button\.primary|\.chip\.on) \{[^}]*color: #fff/.test(css))

  console.log(`\n${pass === total ? 'All' : `${pass} of`} ${total} checks passed`)
  process.exit(pass === total ? 0 : 1)
}

run().catch((err) => {
  console.error(err)
  process.exit(1)
})
