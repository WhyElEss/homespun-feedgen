import fs from 'node:fs'
import path from 'node:path'
import http from 'http'
import express from 'express'
import { validateFilters, writeFilters } from './filter'
import { AdminAuth } from './adminAuth'
import { StatusSnapshot, shortDigest } from './adminStatus'
import { ADMIN_PAGE } from './adminPage'

// The admin surface: a config side channel, a status view, and the UI that
// renders them.
//
// It exists in two shapes, and the difference between them is the whole
// security story:
//
//   * createAdminApp() — a SEPARATE listener, no authentication, off unless
//     FEEDGEN_ADMIN_PORT is set, bound to 127.0.0.1. Reach it over an SSH
//     tunnel. This is what shipped first and what tooling on the box uses.
//   * createAdminRouter({ auth, status, page }) — the same routes with every
//     data route behind a password, for mounting on the public app. server.ts
//     refuses to mount it there without `auth`.
//
// GET /filters serves the real patterns, so it is no less sensitive than a
// write endpoint would be: the filters of these feeds are private on purpose.
// Everything except the page itself and the login route is guarded.
//
//   GET  /                     the UI (unauthenticated: it IS the login form)
//   POST /api/login            password -> session cookie
//   POST /api/logout           drop the session
//   GET  /api/status           what this box is doing        [guarded]
//   GET  /filters              the config as it is on disk   [guarded]
//   POST /filters/validate     is this candidate loadable?   [guarded]
//
// There is still deliberately no write endpoint. Writing is available
// in-process through writeFilters(); putting it on HTTP is the next step and
// deserves its own review rather than a quiet addition to a status page.

// Read per request, never captured at module load: an import is evaluated
// before anything that sets the variable afterwards, which silently pinned this
// to the default and made the endpoint serve a different file than the caller
// meant. Same trap as PDS_URL in the avatar script.
const filtersPath = () => process.env.FEEDGEN_FILTERS_PATH ?? '/data/filters.json'

export type AdminRouterOptions = {
  // When present, every data route requires a session and the login routes are
  // mounted. When absent the routes are open — only ever do that on loopback.
  auth?: AdminAuth
  // When present, GET /api/status is served from it.
  status?: () => Promise<StatusSnapshot>
  // Serve the HTML page at the mount root.
  page?: boolean
  // Enables PUT /filters. False on a standby: its config is overwritten by the
  // primary every 10 minutes, so an edit there is not a risk, it is a lie.
  writable?: boolean
  // When present, POST /lab/measure is served from it.
  lab?: (feed: string, filters: unknown, refresh: boolean) => Promise<unknown>
}

// Kept next to the config, so a restore of data/ carries the history with it.
const BACKUP_DIR = 'filters-backups'
const KEEP_BACKUPS = 50

// The service can hot-reload a broken-in-spirit config in ~10 s and auto-purge
// can act on it within 5 minutes, so the previous file is the realistic undo.
// writeFilters() is atomic but keeps no history of its own.
const backupCurrent = (file: string, stamp: string): string | null => {
  if (!fs.existsSync(file)) return null
  const dir = path.join(path.dirname(file), BACKUP_DIR)
  fs.mkdirSync(dir, { recursive: true })
  const dest = path.join(dir, `filters.json.${stamp}`)
  fs.copyFileSync(file, dest)
  const kept = fs
    .readdirSync(dir)
    .filter((f) => f.startsWith('filters.json.'))
    .sort()
  for (const old of kept.slice(0, Math.max(0, kept.length - KEEP_BACKUPS))) {
    fs.rmSync(path.join(dir, old), { force: true })
  }
  return dest
}

// The page loads no external resource of any kind, so the policy can say so.
// Without frame-ancestors a login form is clickjackable; without form-action an
// injected form could still post the password somewhere else.
const securityHeaders: express.RequestHandler = (_req, res, next) => {
  res.setHeader(
    'Content-Security-Policy',
    "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; " +
      "connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  )
  res.setHeader('X-Frame-Options', 'DENY')
  res.setHeader('X-Content-Type-Options', 'nosniff')
  res.setHeader('Referrer-Policy', 'no-referrer')
  res.setHeader('Cache-Control', 'no-store')
  next()
}

export const createAdminRouter = (opts: AdminRouterOptions = {}): express.Router => {
  const router = express.Router()
  router.use(securityHeaders)
  router.use(express.json({ limit: '1mb' }))

  // A malformed body must not fall through to express's HTML error page: every
  // client here speaks JSON and would report "unexpected token <" instead.
  router.use(((err, _req, res, next) => {
    if (err) {
      res.status(400).json({ ok: false, error: 'malformed request body' })
      return
    }
    next()
  }) as express.ErrorRequestHandler)

  if (opts.page) {
    router.get('/', (_req, res) => {
      res.type('html').send(ADMIN_PAGE)
    })
  }

  // Login and logout must sit in front of the guard, or signing in would
  // require being signed in.
  if (opts.auth) router.use(opts.auth.routes)

  const guard: express.RequestHandler = opts.auth
    ? opts.auth.guard
    : (_req, _res, next) => next()

  if (opts.status) {
    const status = opts.status
    router.get('/api/status', guard, async (_req, res) => {
      try {
        res.json({ ok: true, status: await status() })
      } catch (err: any) {
        res.status(500).json({ ok: false, error: String(err?.message ?? err) })
      }
    })
  }

  router.get('/filters', guard, (_req, res) => {
    try {
      const buf = fs.readFileSync(filtersPath())
      res.json({
        ok: true,
        filters: JSON.parse(buf.toString('utf8')),
        // The client sends this back on save. It is how a second editor, a hand
        // edit over ssh, or the standby sync gets noticed instead of clobbered.
        digest: shortDigest(buf),
        writable: opts.writable === true,
      })
    } catch (err: any) {
      res.status(500).json({ ok: false, error: String(err?.message ?? err) })
    }
  })

  router.put('/filters', guard, (req, res) => {
    if (!opts.writable) {
      res.status(403).json({
        ok: false,
        error:
          'this box is read-only. On a standby the config is replaced by the ' +
          'primary every 10 minutes, so an edit here would be silently undone — ' +
          'edit on the primary instead.',
      })
      return
    }
    const body: any = req.body ?? {}
    const file = filtersPath()
    try {
      const currentBuf = fs.readFileSync(file)
      const currentDigest = shortDigest(currentBuf)
      if (body.expectedDigest !== currentDigest) {
        res.status(409).json({
          ok: false,
          error:
            'the config on disk changed since it was loaded — reload before ' +
            'saving, or your edit would drop whatever changed in between.',
          expected: body.expectedDigest ?? null,
          actual: currentDigest,
        })
        return
      }

      const compiled = validateFilters(body.filters)
      const current = JSON.parse(currentBuf.toString('utf8'))
      const before = Object.keys(current?.feeds ?? {}).sort().join(',')
      const after = [...compiled.keys()].sort().join(',')
      if (before !== after) {
        // buildAlgos() reads the config once, at startup, so a feed added here
        // would be configured but not routed, and one removed would still be
        // routed while matching nothing. filter.ts only warns about that in the
        // log — a UI should refuse rather than produce it.
        res.status(400).json({
          ok: false,
          error:
            'adding or removing a feed needs a service restart, because the ' +
            'routing table is built at startup. Edit the file on the box and ' +
            'restart instead.',
          before,
          after,
        })
        return
      }

      const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..+/, 'Z')
      const backup = backupCurrent(file, stamp)
      writeFilters(body.filters, file)
      const newDigest = shortDigest(fs.readFileSync(file))
      console.log(`admin: filters saved (digest ${currentDigest} -> ${newDigest})`)
      res.json({
        ok: true,
        digest: newDigest,
        backup,
        note:
          'The service reloads within ~10s. Any change to this file also makes ' +
          'auto-purge replay the filter over stored posts within 5 minutes, and ' +
          'the standby picks the file up within 10.',
      })
    } catch (err: any) {
      res.status(400).json({ ok: false, error: String(err?.message ?? err) })
    }
  })

  if (opts.lab) {
    const lab = opts.lab
    router.post('/lab/measure', guard, async (req, res) => {
      const body: any = req.body ?? {}
      if (typeof body.feed !== 'string' || !body.feed) {
        res.status(400).json({ ok: false, error: 'feed is required' })
        return
      }
      try {
        res.json({ ok: true, result: await lab(body.feed, body.filters, body.refresh === true) })
      } catch (err: any) {
        res.status(400).json({ ok: false, error: String(err?.message ?? err) })
      }
    })
  }

  // Compiling a candidate is cheap and side-effect free: compilePattern only
  // builds the RegExp, it never runs it, so a pathological pattern cannot burn
  // CPU here the way matching against it would.
  router.post('/filters/validate', guard, (req, res) => {
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

  return router
}

export const createAdminApp = (): express.Application => {
  const app = express()
  app.use('/admin', createAdminRouter())
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
