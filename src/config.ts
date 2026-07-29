import { Database } from './db'
import { DidResolver } from '@atproto/identity'
import {
  QueryParams,
  OutputSchema as AlgoOutput,
} from './lexicon/types/app/bsky/feed/getFeedSkeleton'

export type AlgoHandler = (
  ctx: AppContext,
  params: QueryParams,
) => Promise<AlgoOutput>

export type AppContext = {
  db: Database
  didResolver: DidResolver
  cfg: Config
  // rkey -> handler, built from the feeds declared in filters.json
  algos: Record<string, AlgoHandler>
}

export type Config = {
  port: number
  listenhost: string
  hostname: string
  sqliteLocation: string
  subscriptionEndpoint: string
  serviceDid: string
  publisherDid: string
  subscriptionReconnectDelay: number
}
