import fs from 'node:fs'
import { ADMIN_PAGE } from '../src/adminPage'

// Renders the admin page to a standalone HTML file with `fetch` stubbed, so it
// can be LOOKED at in a browser.
//
// This exists because `testAdminPage` runs the page's script against a stub DOM
// that has no layout and no eyes. It can prove a node was built and an attribute
// set; it cannot see that a caret reads as a bullet, that two rows sit flush
// against each other with 0px between them, or that a six-digit field is as wide
// as its card. Every one of those shipped, was reported from real use, and was
// found in a browser against this rig.
//
// It had been rewritten from scratch three times in one day before it became a
// file — the same signal that turned nine deletion scripts into purgePosts and
// five measurement scripts into probeCorpus.
//
// Usage:
//   yarn previewAdminPage [--out <path>] [--fixture <file.json>]
//
//   --out       where to write the HTML (default ./preview-admin.html)
//   --fixture   JSON whose top-level keys REPLACE the defaults below, one
//               section at a time: status | activity | filters | totp | record
//
// Serve the file rather than opening it from disk — the page anchors its calls
// to location.pathname, and a file:// path makes those unreadable:
//
//   python3 -m http.server 8899   # then http://127.0.0.1:8899/preview-admin.html

const arg = (name: string): string | undefined => {
  const i = process.argv.indexOf(`--${name}`)
  return i >= 0 ? process.argv[i + 1] : undefined
}

export type Fixtures = Record<string, unknown>

// Matched in ORDER, by substring. The real page mounts at /admin and its own
// tests match exact paths on purpose — a wrong prefix still ends with the right
// suffix, which is how a call to a route that does not exist once looked fine.
// A preview cannot do that: it is served from wherever you put the file, so the
// mount point is unknown. Order is what keeps it honest — "api/status" has to be
// tried before "status", and "totp/status" before both.
export const ROUTES: [string, string][] = [
  ['api/status', 'status'],
  ['totp/status', 'totp'],
  ['activity', 'activity'],
  ['/record', 'record'],
  ['filters', 'filters'],
]

// The body this URL should answer with, or null for "no such route" — which the
// stub turns into a 404 whose json() REJECTS, because that is what express does
// with an unmatched route and what the page has to survive.
export const routeFor = (url: string, fixtures: Fixtures): unknown => {
  for (const [needle, key] of ROUTES) {
    if (url.indexOf(needle) > -1) return fixtures[key] ?? null
  }
  return null
}

// A day of plausible traffic, anchored to the real clock: the page turns UTC
// hour buckets into the reader's local hours, so a fixed timestamp would only
// line up in one time zone.
export const defaultFixtures = (now: number = Date.now()): Fixtures => {
  const top = Math.floor(now / 3600000) * 3600000
  const hours: string[] = []
  for (let i = 23; i >= 0; i--) hours.push(new Date(top - i * 3600000).toISOString().slice(0, 13))
  const iso = new Date(now).toISOString()
  const shape = [1, 0, 0, 1, 0, 2, 3, 5, 4, 7, 9, 6, 8, 11, 9, 12, 14, 10, 13, 17, 15, 19, 22, 6]

  return {
    status: { ok: true, status: {
      generatedAt: iso,
      box: { name: 'box', hostname: 'box', pid: 1, node: 'v20', uptimeSec: 900000, processUptimeSec: 90000 },
      service: { hostname: 'feed.example.com', serviceDid: 'did:plc:service',
                 publisherDid: 'did:plc:publisher', port: 3000,
                 subscriptionEndpoint: 'wss://jetstream1.example', writable: true },
      filters: { path: '/data/filters.json', exists: true, modified: iso,
                 sizeBytes: 4096, sha256: 'abc123abc123' },
      gc: { lastAt: iso, agoSec: 300, nextInSec: 3300, intervalSec: 3600, failures: 0 },
      cursors: [{ service: 'wss://jetstream1.example', cursor: 2, at: iso, lagSec: 3 }],
      feeds: [
        { key: 'coffee', displayName: 'Coffee', routed: true, rows: 942, oldest: null, newest: null,
          retention: { type: 'hours', value: 72 }, includePatterns: 3, excludePatterns: 9,
          includeDids: 0, excludeListUri: 'at://did:plc:publisher/app.bsky.graph.list/abc',
          pinnedPost: null },
        { key: 'radio', displayName: 'Radio', routed: true, rows: 500, oldest: null, newest: null,
          retention: { type: 'count', value: 500 }, includePatterns: 0, excludePatterns: 0,
          includeDids: 1, excludeListUri: null, pinnedPost: null },
      ],
    } },

    // Both series, a retention floor on the count-based feed, an applied sweep
    // whose rows arrived HOURS before it ran, and a refused one. That covers
    // every branch the card has.
    activity: { ok: true, activity: {
      generatedAt: iso,
      hours,
      feeds: [
        { key: 'coffee', stored: shape,
          purged: hours.map((_, i) => (i === 9 ? 3 : i === 10 ? 1 : 0)), floor: null },
        { key: 'radio', stored: hours.map((_, i) => (i < 8 ? 0 : 2)),
          purged: hours.map(() => 0), floor: hours[8] + ':00:00.000Z' },
      ],
      events: [{
        at: hours[19] + ':10:00.000Z', kind: 'blocklist', total: 4,
        byFeed: [{ feed: 'coffee', count: 4 }],
        rows: [0, 1, 2, 3].map((i) => ({
          feed: 'coffee',
          uri: 'at://did:plc:someone/app.bsky.feed.post/rk' + i,
          handle: 'someone.example.com',
          text: 'a post that the sweep removed, shown so the row has something to say',
          why: 'on moderation list',
          indexedAt: hours[i < 3 ? 9 : 10] + ':2' + i + ':00.000Z',
          kind: 'blocklist',
        })),
        omitted: 0,
      }],
      withheld: [{ at: hours[14] + ':05:00.000Z', mode: 'rejected', feed: 'coffee',
                   count: 180, stored: 1400, limit: 25 }],
      notes: [],
    } },

    filters: { ok: true, digest: 'abc123abc123', writable: true, filters: { feeds: {
      coffee: { displayName: 'Coffee',
                includePatterns: [{ pattern: '\\bcoffee\\b', comment: 'the topic' }],
                excludePatterns: [{ pattern: '\\bdiscount\\b', comment: 'storefronts / deals' }],
                excludeListUri: 'at://did:plc:publisher/app.bsky.graph.list/abc',
                retention: { type: 'hours', value: 72 } },
      radio: { displayName: 'Radio', includeDids: ['did:plc:someone'],
               retention: { type: 'count', value: 500 } },
    } } },

    totp: { ok: true, enabled: true, source: 'file', managedHere: true, broken: false,
            file: '/data/admin-totp.json' },

    record: { ok: true, record: { displayName: 'Coffee', description: 'A feed about coffee.',
                                  avatar: null }, avatarUrl: null },
  }
}

// Splice the stub in AHEAD of the page's own script, so window.fetch is already
// replaced when the page runs.
//
// The replacement is a FUNCTION on purpose: a string replacement would treat $&
// and $' in the fixtures as backreferences and quietly corrupt them.
export const buildPreview = (page: string, fixtures: Fixtures): string => {
  const stub =
    '<script>(function(){' +
    'var R=' + JSON.stringify(fixtures) + ';' +
    'var ROUTES=' + JSON.stringify(ROUTES) + ';' +
    'window.fetch=function(u){' +
    'var p=String(u),b=null,i;' +
    'for(i=0;i<ROUTES.length;i++){if(p.indexOf(ROUTES[i][0])>-1){b=R[ROUTES[i][1]]||null;break;}}' +
    'if(b===null){return Promise.resolve({status:404,ok:false,' +
    'json:function(){return Promise.reject(new Error("not JSON"));}});}' +
    'return Promise.resolve({status:200,ok:true,' +
    'json:function(){return Promise.resolve(b);}});};' +
    '})();</script>'

  if (page.indexOf('<script>') < 0) throw new Error('the page has no <script> to precede')
  return page.replace('<script>', () => stub + '<script>')
}

const main = () => {
  const out = arg('out') ?? './preview-admin.html'
  let fixtures = defaultFixtures()
  const file = arg('fixture')
  if (file) {
    const given = JSON.parse(fs.readFileSync(file, 'utf8')) as Fixtures
    // Section at a time, so a fixture naming only `activity` still gets a
    // working status, filters and record and the page renders at all.
    fixtures = { ...fixtures, ...given }
    console.log(`fixture: replaced ${Object.keys(given).join(', ')}`)
  }
  fs.writeFileSync(out, buildPreview(ADMIN_PAGE, fixtures))
  console.log(`wrote ${out} (${fs.statSync(out).size} bytes)`)
  console.log('serve it — the page anchors its calls to location.pathname:')
  console.log('  python3 -m http.server 8899')
}

if (require.main === module) {
  try {
    main()
  } catch (e: any) {
    console.error(String(e?.message ?? e))
    process.exit(1)
  }
}
