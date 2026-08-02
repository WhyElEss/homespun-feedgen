import fs from 'node:fs'
import http from 'http'
import express from 'express'
import { validateFilters } from './filter'

// A small side channel for tooling that edits the config — an admin UI, a
// deploy check, a pre-commit hook. It is NOT part of the feed API.
//
// Deliberately a SEPARATE listener rather than a route on the main app: that
// app sits behind the Cloudflare tunnel and is reachable from the internet.
// Nothing here should ever be. Off unless FEEDGEN_ADMIN_PORT is set, and bound
// to 127.0.0.1 unless you override it — reach it over an SSH tunnel.
//
//   GET  /admin/filters           the config as it is on disk
//   POST /admin/filters/validate  is this candidate loadable?
//
// There is deliberately no write endpoint yet. Writing is available in-process
// through writeFilters(); exposing it over HTTP needs an authentication story,
// and inventing one before there is a client to authenticate would be guessing.

// Read per request, never captured at module load: an import is evaluated
// before anything that sets the variable afterwards, which silently pinned this
// to the default and made the endpoint serve a different file than the caller
// meant. Same trap as PDS_URL in the avatar script.
const filtersPath = () => process.env.FEEDGEN_FILTERS_PATH ?? '/data/filters.json'

export const createAdminApp = (): express.Application => {
  const app = express()
  app.use(express.json({ limit: '1mb' }))

  app.get('/admin/filters', (_req, res) => {
    try {
      const raw = JSON.parse(fs.readFileSync(filtersPath(), 'utf8'))
      res.json({ ok: true, filters: raw })
    } catch (err: any) {
      res.status(500).json({ ok: false, error: String(err?.message ?? err) })
    }
  })

  // Compiling a candidate is cheap and side-effect free: compilePattern only
  // builds the RegExp, it never runs it, so a pathological pattern cannot burn
  // CPU here the way matching against it would.
  app.post('/admin/filters/validate', (req, res) => {
    try {
      const compiled = validateFilters(req.body)
      res.json({
        ok: true,
        feeds: [...compiled.values()].map((f) => ({
          key: f.key,
          displayName: f.displayName ?? null,
          includePatterns: f.include.length,
          excludePatterns: f.exclude.length,
          includeDids: f.includeDids.size,
          excludeListUri: f.excludeListUri ?? null,
          pinnedPost: f.pinnedPost ?? null,
          retention: f.retention,
        })),
      })
    } catch (err: any) {
      // The message already names the offending path, e.g.
      // feeds["abc"].includePatterns[2]: … — pass it through unchanged.
      res.status(400).json({ ok: false, error: String(err?.message ?? err) })
    }
  })

  return app
}

// Returns undefined when no admin port is configured, which is the default.
export const startAdminServer = async (): Promise<http.Server | undefined> => {
  const port = Number(process.env.FEEDGEN_ADMIN_PORT ?? '')
  if (!Number.isFinite(port) || port <= 0) return undefined
  const host = process.env.FEEDGEN_ADMIN_HOST ?? '127.0.0.1'

  const server = createAdminApp().listen(port, host)
  await new Promise((resolve) => server.once('listening', resolve))
  console.log(`admin: config API on http://${host}:${port} (not for public exposure)`)
  if (host !== '127.0.0.1' && host !== 'localhost') {
    console.warn(
      `admin: bound to ${host}, not loopback — make sure something in front of it ` +
        `requires authentication`,
    )
  }
  return server
}
