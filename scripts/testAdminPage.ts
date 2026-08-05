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
  let statusFetches = 0
  const fetchStub = (url: string, init?: any) => {
    const method = init?.method ?? (init?.body ? 'POST' : 'GET')
    let body: any = { ok: false }
    if (url.endsWith('/api/status')) { statusFetches++; body = STATUS }
    else if (url.endsWith('/filters') && method === 'GET') body = JSON.parse(JSON.stringify(FILTERS))
    else if (url.endsWith('/filters') && method === 'PUT') {
      puts.push(JSON.parse(init.body))
      body = { ok: true, digest: 'newdigest123', note: 'saved' }
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
  for (const label of ['Input', 'Feed name', 'RegEx — keep #1', 'RegEx — remove #1',
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

  console.log('\n── a status refresh must not disturb the editor')
  const beforePicker = find(app, 'select')[0]
  const beforeFetches = statusFetches
  await firePoll()
  check('the poll refetched the status', statusFetches === beforeFetches + 1)
  check('...but did not rebuild the editor', find(app, 'select')[0] === beforePicker)
  check('...leaving the chosen feed selected', find(app, 'select')[0].value === 'radio')

  console.log('\n── unsaved changes freeze the refresh')
  const pane = walk(app).find((e) => e.tagName === 'DIV' && !!e.handlers['input'])!
  const dids = find(app, 'textarea')[0]
  dids.value = 'did:plc:someone\ndid:plc:another'
  dids.handlers['input']()
  pane.handlers['input']()   // the delegated listener the real DOM would bubble to
  check('the toolbar says the refresh is paused', textOf(app).includes('auto-refresh paused'))
  const held = statusFetches
  await firePoll()
  check('...and nothing was refetched', statusFetches === held)
  check('...while the edit survived', find(app, 'textarea')[0].value.includes('another'))

  console.log(`\n${pass === total ? 'All' : `${pass} of`} ${total} checks passed`)
  process.exit(pass === total ? 0 : 1)
}

run().catch((err) => {
  console.error(err)
  process.exit(1)
})
