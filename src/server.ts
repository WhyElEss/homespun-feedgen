import http from 'http'
import events from 'events'
import express from 'express'
import { DidResolver, MemoryCache } from '@atproto/identity'
import { createServer } from './lexicon'
import feedGeneration from './methods/feed-generation'
import describeGenerator from './methods/describe-generator'
import { createDb, Database, migrateToLatest } from './db'
import { JetstreamSubscription } from './subscription'
import { AppContext, Config } from './config'
import wellKnown from './well-known'
import { watchFilters } from './filter'
import { buildAlgos } from './algos'
import { createAdminRouter, startAdminServer } from './admin'
import { createAdminAuth, looksLikeHash } from './adminAuth'
import { collectStatus } from './adminStatus'

// The admin UI on the PUBLIC app. Off unless FEEDGEN_ADMIN_UI=on, because this
// app is what the Cloudflare tunnel points at — an install that does not ask
// for it must not get it. Two consequences worth stating plainly:
//
//   * a missing or malformed password hash is a startup ERROR, not a warning.
//     The alternative is an unauthenticated admin surface on a public hostname,
//     and refusing to start is the only failure mode that cannot be missed;
//   * a standby box must leave FEEDGEN_ADMIN_UI unset. It runs the same image
//     from the same tree and is reachable on its own hostname, so a copied .env
//     is all it takes to publish a second login page — see FAILOVER.md.
const mountAdminUi = (
  app: express.Application,
  ctx: AppContext,
  startedAt: number,
): void => {
  if ((process.env.FEEDGEN_ADMIN_UI ?? '').toLowerCase() !== 'on') return

  const passwordHash = process.env.FEEDGEN_ADMIN_PASSWORD_HASH ?? ''
  if (!passwordHash) {
    throw new Error(
      'FEEDGEN_ADMIN_UI=on but FEEDGEN_ADMIN_PASSWORD_HASH is not set — ' +
        'run `yarn adminPassword` and put the result in .env. Refusing to ' +
        'serve an admin UI with no password.',
    )
  }
  if (!looksLikeHash(passwordHash)) {
    throw new Error(
      'FEEDGEN_ADMIN_PASSWORD_HASH is not a scrypt hash produced by ' +
        '`yarn adminPassword` (expected scrypt$N$r$p$salt$key). Refusing to ' +
        'start with a password nobody could match.',
    )
  }

  // Today this only labels the box in the UI: there are no write endpoints yet.
  // It is set now so the standby is already configured safely before there are.
  const writable = (process.env.FEEDGEN_ADMIN_MODE ?? 'readonly').toLowerCase() === 'rw'

  app.use(
    '/admin',
    createAdminRouter({
      auth: createAdminAuth({ passwordHash }),
      page: true,
      status: () => collectStatus(ctx.db, ctx.cfg, startedAt, writable),
    }),
  )
  console.log(
    `admin: UI mounted at /admin on the public app (${
      writable ? 'rw' : 'read-only'
    }, password required)`,
  )
}

export class FeedGenerator {
  public app: express.Application
  public server?: http.Server
  public adminServer?: http.Server
  public db: Database
  public firehose: JetstreamSubscription
  public cfg: Config

  constructor(
    app: express.Application,
    db: Database,
    firehose: JetstreamSubscription,
    cfg: Config,
  ) {
    this.app = app
    this.db = db
    this.firehose = firehose
    this.cfg = cfg
  }

  static create(cfg: Config) {
    const app = express()
    const db = createDb(cfg.sqliteLocation)

    // Filters define which feeds exist, so they must be loaded before the
    // routing table is built. Throws on a broken config — failing loudly at
    // startup beats serving an empty feed.
    watchFilters()
    const algos = buildAlgos()

    const firehose = new JetstreamSubscription(db, cfg.subscriptionEndpoint)

    const didCache = new MemoryCache()
    const didResolver = new DidResolver({
      plcUrl: 'https://plc.directory',
      didCache,
    })

    const server = createServer({
      validateResponse: true,
      payload: {
        jsonLimit: 100 * 1024, // 100kb
        textLimit: 100 * 1024, // 100kb
        blobLimit: 5 * 1024 * 1024, // 5mb
      },
    })
    const ctx: AppContext = {
      db,
      didResolver,
      cfg,
      algos,
    }
    feedGeneration(server, ctx)
    describeGenerator(server, ctx)
    app.use(server.xrpc.router)
    app.use(wellKnown(ctx))
    mountAdminUi(app, ctx, Date.now())

    return new FeedGenerator(app, db, firehose, cfg)
  }

  async start(): Promise<http.Server> {
    await migrateToLatest(this.db)
    this.firehose.run(this.cfg.subscriptionReconnectDelay)
    this.server = this.app.listen(this.cfg.port, this.cfg.listenhost)
    await events.once(this.server, 'listening')
    // Separate listener, off unless FEEDGEN_ADMIN_PORT is set. Never routed
    // through the tunnel — see src/admin.ts.
    this.adminServer = await startAdminServer()
    return this.server
  }
}

export default FeedGenerator
