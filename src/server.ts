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
import { startAdminServer } from './admin'

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
