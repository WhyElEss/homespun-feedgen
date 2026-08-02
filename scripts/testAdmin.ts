import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createAdminApp, startAdminServer } from '../src/admin'
import { writeFilters, validateFilters } from '../src/filter'

// Covers the config side channel and the atomic write behind it.

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'feedgen-admin-'))
const FILTERS = path.join(TMP, 'filters.json')

const good = {
  feeds: {
    abc: {
      displayName: 'Example',
      includePatterns: [{ pattern: 'coffee' }],
      retention: { type: 'hours', value: 72 },
    },
  },
}
const bad = { feeds: { abc: { includePatterns: [{ pattern: '(' }] } } }

fs.writeFileSync(FILTERS, JSON.stringify(good, null, 2))
process.env.FEEDGEN_FILTERS_PATH = FILTERS

let pass = 0
let total = 0
const check = (name: string, cond: boolean, detail = '') => {
  total++
  if (cond) pass++
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? `  [${detail}]` : ''}`)
}

const run = async () => {
  console.log('\n── the admin listener is off by default')
  delete process.env.FEEDGEN_ADMIN_PORT
  check('no port configured means no server', (await startAdminServer()) === undefined)

  console.log('\n── the endpoints')
  const server = createAdminApp().listen(0, '127.0.0.1')
  await new Promise((r) => server.once('listening', r))
  const base = `http://127.0.0.1:${(server.address() as any).port}`

  const get = await fetch(`${base}/admin/filters`)
  const getBody: any = await get.json()
  check('GET returns the file', get.status === 200 && getBody.ok === true)
  check('...with its contents', getBody.filters?.feeds?.abc !== undefined)

  const post = async (body: unknown) => {
    const r = await fetch(`${base}/admin/filters/validate`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
    return { status: r.status, body: (await r.json()) as any }
  }

  const okRes = await post(good)
  check('a valid candidate is accepted', okRes.status === 200 && okRes.body.ok === true)
  check('...summarised per feed', okRes.body.feeds?.[0]?.key === 'abc', JSON.stringify(okRes.body.feeds?.[0] ?? {}).slice(0, 70))

  const badRes = await post(bad)
  check('an invalid candidate is rejected', badRes.status === 400 && badRes.body.ok === false)
  check(
    '...naming the offending path',
    String(badRes.body.error).includes('includePatterns'),
    String(badRes.body.error).slice(0, 60),
  )

  const junkRes = await post({ nonsense: true })
  check('junk is rejected, not crashed on', junkRes.status === 400)

  // Validation must not have touched the file on disk.
  check(
    'validating never writes',
    JSON.parse(fs.readFileSync(FILTERS, 'utf8')).feeds.abc.displayName === 'Example',
  )
  server.close()

  console.log('\n── writeFilters')
  const next = JSON.parse(JSON.stringify(good))
  next.feeds.abc.displayName = 'Renamed'
  writeFilters(next, FILTERS)
  check(
    'a valid config is persisted',
    JSON.parse(fs.readFileSync(FILTERS, 'utf8')).feeds.abc.displayName === 'Renamed',
  )
  check(
    'no temporary file is left behind',
    fs.readdirSync(TMP).filter((f) => f.includes('.tmp-')).length === 0,
    fs.readdirSync(TMP).join(','),
  )

  let threw = ''
  try {
    writeFilters(bad, FILTERS)
  } catch (err: any) {
    threw = String(err?.message ?? err)
  }
  check('an invalid config is refused', threw.includes('includePatterns'), threw.slice(0, 50))
  check(
    '...and the previous file survives untouched',
    JSON.parse(fs.readFileSync(FILTERS, 'utf8')).feeds.abc.displayName === 'Renamed',
  )
  check(
    'a refused write leaves no temporary file either',
    fs.readdirSync(TMP).filter((f) => f.includes('.tmp-')).length === 0,
  )

  // What the atomic rename buys: whatever a concurrent reader opens, it parses.
  check('the persisted file is always valid JSON for a reader', (() => {
    try {
      validateFilters(JSON.parse(fs.readFileSync(FILTERS, 'utf8')))
      return true
    } catch {
      return false
    }
  })())

  fs.rmSync(TMP, { recursive: true, force: true })
  console.log(`\n${pass === total ? 'All' : `${pass} of`} ${total} checks passed`)
  process.exit(pass === total ? 0 : 1)
}

run().catch((err) => {
  console.error(err)
  process.exit(1)
})
