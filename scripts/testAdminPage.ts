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
  attrs: Record<string, string> = {}
  handlers: Record<string, Function> = {}
  className = ''
  textContent = ''
  value = ''
  checked = false
  disabled = false
  constructor(tag: string) {
    this.tagName = tag.toUpperCase()
  }
  set innerHTML(_v: string) {
    this.children = []
  }
  get innerHTML(): string {
    return ''
  }
  appendChild(c: El) {
    this.children.push(c)
    return c
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

const FILTERS = {
  ok: true,
  digest: 'abc123abc123',
  writable: true,
  filters: {
    _readme: 'a comment key the editor does not model',
    feeds: {
      coffee: {
        displayName: 'Coffee',
        includePatterns: [{ pattern: '\\bcoffee\\b', comment: 'the topic' }],
        excludePatterns: [{ pattern: '\\bdiscount\\b' }],
        excludeListUri: 'at://did:plc:x/app.bsky.graph.list/abc',
        retention: { type: 'hours', value: 72 },
      },
      radio: {
        includeDids: ['did:plc:someone'],
        retention: { type: 'count', value: 500 },
      },
    },
  },
}

const run = async () => {
  const script = ADMIN_PAGE.split('<script>')[1].split('</script>')[0]
  const app = new El('main')
  const created: El[] = []
  const doc = {
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
  const probes: any[] = []
  let statusFetches = 0
  const requested: string[] = []
  const fetchStub = (url: string, init?: any) => {
    const method = init?.method ?? (init?.body ? 'POST' : 'GET')
    requested.push(method + ' ' + url)
    let body: any = null
    // Exact paths. The first version matched with endsWith, so a call to
    // /admin/api/lab/measure — which does not exist — was answered as if it
    // were /admin/lab/measure, and the real 404 only ever showed up in a
    // browser.
    if (url === '/admin/api/status') { statusFetches++; body = STATUS }
    else if (url === '/admin/filters' && method === 'GET') body = JSON.parse(JSON.stringify(FILTERS))
    else if (url === '/admin/lab/measure') {
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
    else if (/^\/admin\/feed\/[^/]+\/record$/.test(url)) {
      body = { ok: true, record: { uri: 'at://did:plc:p/app.bsky.feed.generator/coffee',
        cid: 'bafy', displayName: 'Coffee, published', description: 'the real one',
        avatarCid: 'bafcid', did: 'did:plc:s', createdAt: '2026-01-01T00:00:00Z' } }
    }
    else if (url === '/admin/resolve/post') {
      resolved.push(JSON.parse(init.body).input)
      body = { ok: true, post: { uri: 'at://did:plc:mc/app.bsky.feed.post/3msc',
        did: 'did:plc:mc', handle: 'mcwyrm.bsky.social', text: 'a pinned post', exists: true } }
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
  const fn = new Function(
    'document', 'location', 'fetch', 'setTimeout', 'clearTimeout', 'confirm',
    script,
  )
  fn(doc, { pathname: '/admin' }, fetchStub,
     (cb: Function) => timers.push(cb), () => {}, () => true)
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

  console.log('\n── the editor shows one feed, chosen from a dropdown above it')
  const selects = find(app, 'select')
  check('there is a feed picker', selects.length > 0)
  const picker = selects[0]
  check('...with an option per feed', picker.children.length === 2,
    picker.children.map((o) => o.textContent).join(' / '))
  check('...naming the rkey as well as the display name',
    picker.children[0].textContent.includes('coffee'))
  const pickerIdx = walk(app).indexOf(picker)
  const firstBlock = walk(app).find((e) => e.className.includes('block'))!
  check('...positioned ABOVE the blocks', pickerIdx < walk(app).indexOf(firstBlock))

  console.log('\n── the blocks')
  for (const label of ['Input', 'Internal label', 'RegEx — keep #1', 'RegEx — remove #1',
                       'Remove if — item has labels', 'Remove — list of users',
                       'Pinned post', 'Sort by']) {
    check(`block: ${label}`, all.includes(label))
  }
  check('the pattern is loaded into its block',
    find(app, 'textarea').some((t) => t.value.includes('coffee')))
  check('its comment travels with it',
    find(app, 'input').some((i) => i.value === 'the topic'))
  check('the moderation list is loaded',
    find(app, 'input').some((i) => i.value.includes('app.bsky.graph.list')))
  check('target chips are rendered', all.includes('Post Text') && all.includes('Image Alt Text'))
  check('fixed blocks are marked as such', all.includes('fixed'))
  check('...and say replies are always dropped', all.includes('Always on'))

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
  check('the internal label says what it is for',
    all.includes('Only this page and the service log ever show it'))

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
  const countBtn = walk(app).find((e) => e.textContent === 'Count matches')!
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
  check('...naming what the include matched', why.includes('matched "coffee"'))
  check('...flagging when the DB and the filter disagree', why.includes('NOT stored'))
  // The other feeds here are unrelated to this one, so their "no pattern
  // matched" is noise: it must be collapsed until asked for.
  check('other feeds are folded away', !why.includes('not in includeDids'))
  check('...but counted', why.includes('other feeds (1)') && why.includes('none matched'))
  const more = walk(app).find((e) => (e.textContent || '').indexOf('other feeds') >= 0)!
  more.handlers['click']()
  const expanded = textOf(app)
  check('...and one click shows them', expanded.includes('not in includeDids'))

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

  console.log('\n── a pin can be pasted as a bsky.app link')
  const pinInput = find(app, 'input').find((i) =>
    (i.attrs.placeholder || '').indexOf('bsky.app/profile') >= 0)!
  check('the field asks for a link, not a URI', !!pinInput)
  pinInput.value = 'https://bsky.app/profile/mcwyrm.bsky.social/post/3mscgyghtjc2f'
  pinInput.handlers['change']()
  await settle()
  check('...and blurring resolves it', resolved.length === 1)
  check('...replacing the field with the at:// URI',
    pinInput.value === 'at://did:plc:mc/app.bsky.feed.post/3msc', pinInput.value)
  check('...showing whose post it is', textOf(app).includes('@mcwyrm.bsky.social'))

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

  console.log('\n── saving sends the WHOLE config, not just the open feed')
  const save = walk(app).find((e) => e.tagName === 'BUTTON' && e.textContent === 'Save')!
  save.handlers['click']()
  await settle()
  check('a PUT was sent', puts.length === 1)
  const sent = puts[0]?.filters
  check('...carrying both feeds', Object.keys(sent?.feeds ?? {}).join() === 'coffee,radio')
  check('...with the untouched feed byte-identical',
    JSON.stringify(sent.feeds.coffee) === JSON.stringify(FILTERS.filters.feeds.coffee))
  check('...preserving keys the editor does not model', sent._readme !== undefined)
  check('...and the digest it loaded', puts[0]?.expectedDigest === 'abc123abc123')

  console.log('\n── measuring an edit')
  const measure = walk(app).find((e) => e.textContent === 'Measure this edit')!
  measure.handlers['click']()
  await settle()
  check('the request goes to the route that exists',
    requested.some((r) => r === 'POST /admin/lab/measure'),
    requested.filter((r) => r.indexOf('measure') >= 0).join(' '))
  const measured = textOf(app)
  check('...and the result is shown',
    measured.includes('posts would be removed') && measured.includes('would remain'))
  check('...naming who would go', measured.includes('@dee'))

  console.log('\n── a status refresh must not disturb the editor')
  const beforePicker = find(app, 'select')[0]
  const beforeFetches = statusFetches
  await firePoll()
  check('the poll refetched the status', statusFetches === beforeFetches + 1)
  check('...but did not rebuild the editor', find(app, 'select')[0] === beforePicker)
  check('...leaving the chosen feed selected', find(app, 'select')[0].value === 'radio')

  console.log('\n── unsaved changes freeze the refresh')
  const pane = walk(app).find((e) => e.tagName === 'DIV' && !!e.handlers['input'])!
  // Not textarea[0] any more: the record card's description box now renders
  // first, and grabbing that one instead produced a confusing type error.
  const dids = find(app, 'textarea').find((t) => t.value.includes('did:plc:someone'))!
  dids.value = 'did:plc:someone\ndid:plc:another'
  dids.handlers['input']()
  pane.handlers['input']()   // the delegated listener the real DOM would bubble to
  check('the toolbar says the refresh is paused', textOf(app).includes('auto-refresh paused'))
  const held = statusFetches
  await firePoll()
  check('...and nothing was refetched', statusFetches === held)
  check('...while the edit survived',
    find(app, 'textarea').some((t) => t.value.includes('another')))

  console.log(`\n${pass === total ? 'All' : `${pass} of`} ${total} checks passed`)
  process.exit(pass === total ? 0 : 1)
}

run().catch((err) => {
  console.error(err)
  process.exit(1)
})
