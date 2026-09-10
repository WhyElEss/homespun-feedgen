// Keep a slice of the live firehose, whole, for offline measurement.
//
// WHY THIS EXISTS. The posts a feed already holds can size an EXCLUDE exactly —
// replay it and count what stops matching. They can say nothing at all about a
// widened INCLUDE, because the posts it would newly admit were never stored,
// and app.bsky.feed.searchPosts is 403 without auth. The only population that
// answers that question is the firehose, so you have to catch some of it and
// keep it.
//
//   CAP_MATCH     a JS regex source, case-insensitive. REQUIRED, and it should
//                 be deliberately much broader than any include you are
//                 considering — you are sampling the population you will choose
//                 from, not testing a candidate.
//   CAP_OUT       output path, JSONL, appended (default ./capture.jsonl)
//   CAP_MINUTES   how long to run (default 360)
//   CAP_ENDPOINT  Jetstream host (default jetstream2.us-east.bsky.network)
//
//   docker compose run -d --rm -v "$PWD/cap:/cap" \
//     -v "$PWD/scripts/captureFirehose.js:/app/captureFirehose.js" \
//     -e CAP_MATCH='coffee|espresso|#latte' -e CAP_OUT=/cap/coffee.jsonl \
//     -e CAP_MINUTES=900 <service> node /app/captureFirehose.js
//
// Run it DETACHED (`run -d`) and stage it somewhere that survives a reboot —
// /tmp does not, and a lost overnight capture cannot be re-taken. Mount the
// script under /app, not an arbitrary path: node resolves node_modules upward
// from the script, and `ws` lives in /app/node_modules.
//
// WHAT TO EXPECT. Roughly 3300 posts/minute arrive on app.bsky.feed.post. A
// narrow subject is rare in that: a capture for "any mention of a window in ten
// languages" kept ~0.2% of them, one for a twice-yearly record-shop event kept
// ~0.07%. So a useful sample takes hours, not minutes, and the thing you are
// hunting — genuine posts an include is MISSING — turns up in single figures.
// Plan an overnight run and read every refusal that carried a picture.
const WebSocket = require('ws')
const fs = require('node:fs')

const OUT = process.env.CAP_OUT || './capture.jsonl'
const MINUTES = Number(process.env.CAP_MINUTES || 360)
const ENDPOINT = process.env.CAP_ENDPOINT || 'wss://jetstream2.us-east.bsky.network'
if (!process.env.CAP_MATCH) {
  console.error('CAP_MATCH is required — a regex source for the research prefilter')
  process.exit(2)
}
let NET
try {
  NET = new RegExp(process.env.CAP_MATCH, 'i')
} catch (err) {
  console.error(`CAP_MATCH does not compile: ${err.message}`)
  process.exit(2)
}

// The same three haystacks the filter uses, so a capture can be replayed
// through filter.ts without surprises about where a match came from.
const altTexts = (rec) => {
  const out = []
  const walk = (em) => {
    if (!em) return
    for (const k of ['images', 'items']) {
      if (Array.isArray(em[k])) for (const i of em[k]) if (i && i.alt) out.push(i.alt)
    }
    if (em.alt) out.push(em.alt)
    if (em.video && em.video.alt) out.push(em.video.alt)
    if (em.external) {
      if (em.external.title) out.push(em.external.title)
      if (em.external.description) out.push(em.external.description)
    }
    if (em.media) walk(em.media)
  }
  walk(rec && rec.embed)
  return out
}
const linkStrings = (rec) => {
  const out = []
  const em = rec && rec.embed
  if (em && em.external && em.external.uri) out.push(em.external.uri)
  for (const f of (rec && rec.facets) || []) {
    for (const ft of f.features || []) if (ft.uri) out.push(ft.uri)
  }
  return out
}

let seen = 0
let kept = 0
let ws
let lastMsg = Date.now()
const stream = fs.createWriteStream(OUT, { flags: 'a' })

const connect = () => {
  ws = new WebSocket(`${ENDPOINT}/subscribe?wantedCollections=app.bsky.feed.post`)
  ws.on('message', (d) => {
    lastMsg = Date.now()
    let e
    try { e = JSON.parse(d.toString()) } catch { return }
    if (e.kind !== 'commit' || !e.commit || e.commit.operation !== 'create') return
    const rec = e.commit.record
    if (!rec) return
    seen++
    const hay = [rec.text || ''].concat(altTexts(rec)).concat(linkStrings(rec)).join('\n')
    if (!NET.test(hay)) return
    kept++
    stream.write(JSON.stringify({ did: e.did, rkey: e.commit.rkey, time_us: e.time_us, record: rec }) + '\n')
  })
  ws.on('error', () => {})
  ws.on('close', () => setTimeout(connect, 2000))
}
connect()

// A half-open socket is the documented way this ingest dies quietly: no 'close'
// event, no 'error', just silence. The service's own subscription carries the
// same watchdog for the same reason.
const watchdog = setInterval(() => {
  if (Date.now() - lastMsg > 30000) { try { ws.terminate() } catch { /* already gone */ } }
}, 10000)
const tick = setInterval(() => console.log(new Date().toISOString(), 'seen', seen, 'kept', kept), 300000)

setTimeout(() => {
  clearInterval(tick)
  clearInterval(watchdog)
  console.log('DONE seen', seen, 'kept', kept)
  try { ws.close() } catch { /* already gone */ }
  stream.end(() => process.exit(0))
}, MINUTES * 60 * 1000)
