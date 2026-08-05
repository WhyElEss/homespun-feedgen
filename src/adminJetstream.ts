import WebSocket from 'ws'

// Measuring how far behind each public Jetstream instance is, on demand.
//
// This is scripts/probeJetstream.js as a button, and it exists because one of
// the public instances can fall HOURS behind while still emitting fresh
// event timestamps — so the cursor looks healthy and the feed quietly serves
// stale posts. The only reliable tell is the median age of the posts arriving,
// which is what this measures.
//
// It cannot switch the endpoint. That is read once at startup from
// FEEDGEN_SUBSCRIPTION_ENDPOINT, the file it lives in is not mounted into the
// container, and a container does not restart itself. The UI hands over the
// exact line and command instead of pretending otherwise.

export const KNOWN_INSTANCES = [
  'wss://jetstream1.us-east.bsky.network',
  'wss://jetstream2.us-east.bsky.network',
  'wss://jetstream1.us-west.bsky.network',
  'wss://jetstream2.us-west.bsky.network',
]

// Enough samples for a median to mean something, few enough that a healthy
// instance answers in well under a second. A lagging instance is behind in
// TIME, not in rate, so it delivers just as fast — the timeout is for an
// instance that is actually down.
const SAMPLES = 20
const TIMEOUT_MS = 8000

export type InstanceReading = {
  endpoint: string
  medianAgeSec: number | null
  samples: number
  error: string | null
}

const probeOne = (endpoint: string): Promise<InstanceReading> =>
  new Promise((resolve) => {
    const ages: number[] = []
    let settled = false
    let ws: WebSocket

    const done = (error: string | null) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      try {
        ws.close()
      } catch {
        /* already closing */
      }
      if (!ages.length) {
        resolve({ endpoint, medianAgeSec: null, samples: 0, error: error ?? 'no data' })
        return
      }
      ages.sort((a, b) => a - b)
      resolve({
        endpoint,
        medianAgeSec: Math.round(ages[Math.floor(ages.length / 2)]),
        samples: ages.length,
        error: null,
      })
    }

    const timer = setTimeout(() => done('timed out'), TIMEOUT_MS)

    try {
      ws = new WebSocket(`${endpoint}/subscribe?wantedCollections=app.bsky.feed.post`)
    } catch (err: any) {
      resolve({ endpoint, medianAgeSec: null, samples: 0, error: String(err?.message ?? err) })
      return
    }

    ws.on('message', (data) => {
      try {
        const e = JSON.parse(data.toString())
        if (
          e.kind === 'commit' &&
          e.commit?.operation === 'create' &&
          e.commit.record?.createdAt
        ) {
          // Against record.createdAt, not the event time: an instance that has
          // fallen behind still stamps its events with the moment it forwards
          // them, which is exactly why the cursor cannot reveal this.
          const age = (Date.now() - Date.parse(e.commit.record.createdAt)) / 1000
          if (Number.isFinite(age)) ages.push(age)
          if (ages.length >= SAMPLES) done(null)
        }
      } catch {
        /* a malformed frame is not worth failing the probe over */
      }
    })
    ws.on('error', (err: any) => done(String(err?.message ?? err)))
    ws.on('close', () => done(null))
  })

// All instances at once. Serially this would take as long as the slowest four
// put together, and the connections are short-lived enough that the concurrent
// load is a blip even on a Pi.
export const probeInstances = async (configured: string): Promise<InstanceReading[]> => {
  const list = [...KNOWN_INSTANCES]
  if (configured && !list.includes(configured)) list.unshift(configured)
  return Promise.all(list.map(probeOne))
}
