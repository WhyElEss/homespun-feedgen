// Covers the static-preview generator. The preview itself is the thing that
// catches what a stub DOM cannot see; these checks cover the rig around it, so
// that when a visual defect IS reported the rig is not the suspect.
// Usage: yarn test:preview
import { buildPreview, defaultFixtures, routeFor, ROUTES, Fixtures } from './previewAdminPage'
import { ADMIN_PAGE } from '../src/adminPage'

let failed = 0
let total = 0
const check = (name: string, cond: boolean, detail = '') => {
  total++
  if (!cond) failed++
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${name}${detail && !cond ? `  [${detail}]` : ''}`)
}

console.log('\n── routing')
const fx = defaultFixtures(Date.parse('2026-08-18T12:00:00.000Z'))
check('api/status resolves to the status fixture', routeFor('/admin/api/status', fx) === fx.status)
// Order matters: both of these contain "status", and totp/status also contains
// it. Matched in the wrong order the Security tab would be served the box
// status and render nothing anyone could explain.
check('totp/status is not swallowed by the status route',
  routeFor('/admin/totp/status', fx) === fx.totp)
check('activity resolves', routeFor('/admin/activity', fx) === fx.activity)
check('filters resolves', routeFor('/admin/filters', fx) === fx.filters)
check('a feed record resolves', routeFor('/admin/feed/coffee/record', fx) === fx.record)
check('an unknown route is null, so the stub can 404 it',
  routeFor('/admin/nothing/here', fx) === null)
check('every route in the table has a fixture',
  ROUTES.every(([, key]) => fx[key] !== undefined),
  ROUTES.map(([n, k]) => `${n}->${k}`).join(' '))

console.log('\n── the fixtures render every branch the page has')
const act: any = (fx.activity as any).activity
check('24 hour buckets', act.hours.length === 24)
check('a feed with a retention floor and one without',
  act.feeds.some((f: any) => f.floor) && act.feeds.some((f: any) => !f.floor))
check('an applied sweep AND a refused one', act.events.length > 0 && act.withheld.length > 0)
// The card's whole subject: a sweep removes posts from earlier hours. A fixture
// where they coincide would draw a picture the real data never produces.
const sweepHour = String(act.events[0].at).slice(0, 13)
check('the sweep ran later than the posts it took',
  act.events[0].rows.every((r: any) => String(r.indexedAt).slice(0, 13) < sweepHour))
check('the withheld record names its feed', !!act.withheld[0].feed)
check('two-factor is enrolled, so the Security tab has its controls',
  (fx.totp as any).enabled === true && (fx.totp as any).managedHere === true)

console.log('\n── the built page')
const html = buildPreview(ADMIN_PAGE, fx)
check('the stub precedes the page script', html.indexOf('window.fetch=') < html.lastIndexOf('<script>'))
check('the page itself survives intact', html.includes('</html>') && html.length > ADMIN_PAGE.length)
check('exactly one stub is added',
  html.split('window.fetch=').length - 1 === 1)
// A string replacement would read $& and $' in the fixtures as backreferences.
// Nothing in the defaults contains one, which is exactly why this is checked
// against a fixture that does.
const dollar: Fixtures = { ...fx, status: { ok: true, note: "$& $' $` $1" } }
check('a fixture containing $& survives the splice',
  buildPreview(ADMIN_PAGE, dollar).includes("$& $' $` $1"))
check('the stub is parsable javascript', (() => {
  const m = html.match(/<script>\(function\(\)\{[\s\S]*?\}\)\(\);<\/script>/)
  if (!m) return false
  try { new Function(m[0].replace(/^<script>/, '').replace(/<\/script>$/, '')); return true }
  catch { return false }
})())
check('a page with no script is refused rather than written',
  (() => { try { buildPreview('<html></html>', fx); return false } catch { return true } })())

console.log(`\n${total - failed}/${total} checks passed`)
process.exit(failed ? 1 : 0)
