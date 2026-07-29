// Measures per-instance Jetstream lag: median (now - record.createdAt)
// across 30 fresh create-commits from each public instance.
const WebSocket = require('ws')

const INSTANCES = [
  'wss://jetstream2.us-east.bsky.network',
  'wss://jetstream1.us-east.bsky.network',
  'wss://jetstream1.us-west.bsky.network',
  'wss://jetstream2.us-west.bsky.network',
]

const probe = (host) =>
  new Promise((resolve) => {
    const ages = []
    const ws = new WebSocket(host + '/subscribe?wantedCollections=app.bsky.feed.post')
    const done = (note) => {
      try { ws.close() } catch {}
      if (!ages.length) return resolve(`${host}  ${note ?? 'no data'}`)
      ages.sort((a, b) => a - b)
      const med = ages[Math.floor(ages.length / 2)]
      resolve(`${host}  median age of incoming posts: ${Math.round(med)}s (${ages.length} samples)`)
    }
    ws.on('message', (d) => {
      try {
        const e = JSON.parse(d.toString())
        if (e.kind === 'commit' && e.commit?.operation === 'create' && e.commit.record?.createdAt) {
          const age = (Date.now() - Date.parse(e.commit.record.createdAt)) / 1000
          if (Number.isFinite(age)) ages.push(age)
          if (ages.length >= 30) done()
        }
      } catch {}
    })
    ws.on('error', (err) => done('error: ' + err.message))
    setTimeout(() => done('timeout'), 15000)
  })

;(async () => {
  for (const h of INSTANCES) console.log(await probe(h))
})()
