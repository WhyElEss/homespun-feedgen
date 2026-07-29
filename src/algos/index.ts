import { AlgoHandler } from '../config'
import { getFeedKeys } from '../filter'
import { makeHandler } from './feed'

// The set of feeds is whatever /data/filters.json declares. Call this only
// after the filters have been loaded. The routing table is then fixed for the
// lifetime of the process: a feed added by a later hot reload is not served
// until restart, and filter.ts warns when that happens.
export const buildAlgos = (): Record<string, AlgoHandler> => {
  const algos: Record<string, AlgoHandler> = {}
  for (const key of getFeedKeys()) {
    algos[key] = makeHandler(key)
  }
  const keys = Object.keys(algos)
  console.log(`algos: serving ${keys.length} feed(s): ${keys.join(', ')}`)
  return algos
}
