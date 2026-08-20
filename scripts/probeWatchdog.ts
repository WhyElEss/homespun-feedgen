import fs from 'node:fs'
import { WebSocketServer } from 'ws'
import { createDb, migrateToLatest } from '../src/db'
import { JetstreamSubscription, IDLE_TIMEOUT_MS } from '../src/subscription'
import { loadFiltersOnce } from '../src/filter'

// Does the ingest recover from a connection that dies without saying so?
//
// This is the failure the idle watchdog exists for, and it cannot be reached
// through the real Jetstream: the socket has to go quiet while staying open.
// So the probe brings its own server. It runs two phases against ONE
// subscription, in the order the outage actually happened:
//
//   1. the server talks. Nothing may be cut -- a watchdog that churns a
//      healthy connection is worse than none.
//   2. the server goes silent, without closing anything. The socket stays
//      open at both ends, exactly as a half-open one does, and the reconnect
//      must happen anyway.
//
//   docker compose run --rm feedgen yarn probeWatchdog
//
// Takes a little over two minutes. Exits non-zero if either phase fails.

const FIXTURE = '/tmp/watchdog-probe-filters.json'

// src/filter.ts resolves FEEDGEN_FILTERS_PATH at import time, so setting it
// here would be too late -- and if the inherited value happened to point at a
// real config, the fixture below would overwrite it. Refuse instead: the
// package.json alias sets the variable on the command line.
if (process.env.FEEDGEN_FILTERS_PATH !== FIXTURE) {
  console.error(
    `probeWatchdog: run it as "yarn probeWatchdog", which sets\n` +
      `  FEEDGEN_FILTERS_PATH=${FIXTURE}\n` +
      `(currently ${process.env.FEEDGEN_FILTERS_PATH ?? 'unset'})`,
  )
  process.exit(2)
}

fs.writeFileSync(
  FIXTURE,
  JSON.stringify({
    feeds: {
      probe: {
        includePatterns: [{ pattern: 'coffee' }],
        retention: { type: 'hours', value: 1 },
      },
    },
  }),
)

const PORT = Number(process.env.PROBE_PORT ?? 8099)
const RECONNECT_DELAY_MS = 3_000
// Long enough that a watchdog with an off-by-one would have fired.
const CHATTY_MS = IDLE_TIMEOUT_MS + 15_000
// The watchdog checks on an interval, so the reconnect lands a little after
// the timeout; the delay before redialling is on top of that.
const GRACE_MS = IDLE_TIMEOUT_MS + RECONNECT_DELAY_MS + 25_000

const started = Date.now()
const t = () => Math.round((Date.now() - started) / 1000)

const done = (ok: boolean, msg: string) => {
  console.log(`\n${ok ? 'PASS' : 'FAIL'}  ${msg}`)
  process.exit(ok ? 0 : 1)
}

let sent = 0
const event = () =>
  JSON.stringify({
    did: 'did:plc:probe',
    time_us: Date.now() * 1000,
    kind: 'commit',
    commit: {
      rev: '1',
      operation: 'create',
      collection: 'app.bsky.feed.post',
      rkey: `probe${sent}`,
      cid: 'bafyprobe',
      record: { $type: 'app.bsky.feed.post', text: 'coffee' },
    },
  })

const run = async () => {
  loadFiltersOnce()
  const db = createDb(':memory:')
  await migrateToLatest(db)

  let connections = 0
  let silentAt: number | undefined

  const wss = new WebSocketServer({ host: '127.0.0.1', port: PORT })

  wss.on('connection', (socket) => {
    connections++

    if (connections === 1) {
      console.log(`  t+${t()}s  connected; the server talks for ${CHATTY_MS / 1000}s`)
      const chatter = setInterval(() => {
        socket.send(event())
        sent++
        if (sent % 3 === 0) console.log(`  t+${t()}s  ${sent} events delivered, still one connection`)
      }, 5_000)

      setTimeout(() => {
        clearInterval(chatter)
        silentAt = Date.now()
        console.log(
          `  t+${t()}s  the server goes silent -- nothing is closed, the socket stays open`,
        )
        setTimeout(
          () =>
            done(
              false,
              `no reconnect ${Math.round(GRACE_MS / 1000)}s after the stream went silent ` +
                `(${sent} events delivered, ${connections} connection(s) total)`,
            ),
          GRACE_MS,
        )
      }, CHATTY_MS)
      return
    }

    if (silentAt === undefined) {
      done(
        false,
        `reconnected at t+${t()}s while the server was still talking -- ` +
          `the watchdog is cutting healthy connections`,
      )
      return
    }

    const after = Math.round((Date.now() - silentAt) / 1000)
    console.log(`  t+${t()}s  reconnected`)
    done(
      true,
      `${sent} events kept the connection alive, then silence was noticed ` +
        `and redialled ${after}s later`,
    )
  })

  const sub = new JetstreamSubscription(db, `ws://127.0.0.1:${PORT}`)
  await sub.run(RECONNECT_DELAY_MS)
}

run().catch((err) => {
  console.error(err)
  process.exit(1)
})
