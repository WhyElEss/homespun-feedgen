// The drawing step, which is the part of the QR that is ours.
// Usage: yarn testAdminQr
//
// The encoder is a library's job. What can go wrong here is a transposed or
// offset matrix — still a plausible-looking QR, scanning to nonsense — so every
// cell of the path is compared against the library's own matrix.
import { qrMatrix, qrSvg, qrDataUri } from '../src/adminQr'

let pass = 0
let total = 0
const check = (name: string, cond: boolean, detail = '') => {
  total++
  if (cond) pass++
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? `  [${detail}]` : ''}`)
}

const URI =
  'otpauth://totp/feed.example.com:admin?secret=JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP' +
  '&issuer=feed.example.com&algorithm=SHA1&digits=6&period=30'

const run = () => {
  const svg = qrSvg(URI)
  const m = qrMatrix(URI)

  console.log('\n── the drawing matches the matrix, cell for cell')
  const drawn = new Set<string>()
  for (const hit of svg.matchAll(/M(\d+) (\d+)h1v1h-1z/g)) {
    drawn.add(`${hit[2]},${hit[1]}`) // row,col — the path takes x=col, y=row
  }
  let dark = 0
  let wrong = 0
  for (let r = 0; r < m.size; r++) {
    for (let c = 0; c < m.size; c++) {
      if (m.isDark(r, c)) {
        dark++
        if (!drawn.has(`${r},${c}`)) wrong++
      } else if (drawn.has(`${r},${c}`)) {
        wrong++
      }
    }
  }
  check('every dark module is drawn and no light one is', wrong === 0, `${wrong} wrong of ${dark}`)
  check('...and nothing extra was drawn', drawn.size === dark, `${drawn.size} vs ${dark}`)
  // A transposition is invisible to the count, so check an asymmetric cell.
  const asym = (() => {
    for (let r = 0; r < m.size; r++)
      for (let c = 0; c < m.size; c++) if (m.isDark(r, c) !== m.isDark(c, r)) return [r, c]
    return null
  })()
  check('the matrix is asymmetric, so transposition IS detectable', !!asym)
  check(
    '...and the drawing is not transposed',
    !!asym && drawn.has(`${asym[0]},${asym[1]}`) === m.isDark(asym[0], asym[1]),
  )

  console.log('\n── the markup')
  check('is an svg', svg.indexOf('<svg') === 0 && svg.trim().endsWith('</svg>'))
  check('carries a quiet zone', svg.includes('viewBox="-4 -4'))
  check('paints a white plate under it', svg.includes('fill="#fff"'))
  check('draws in black regardless of theme', svg.includes('fill="#000"'))
  check('is one path, not a rect per module', (svg.match(/<path/g) || []).length === 1)
  check('stays small enough to inline', svg.length < 25_000, `${svg.length} bytes`)

  console.log('\n── the data URI')
  const uri = qrDataUri(URI)
  check('is a base64 svg', uri.indexOf('data:image/svg+xml;base64,') === 0)
  check('decodes back to the same markup',
    Buffer.from(uri.split(',')[1], 'base64').toString('utf8') === svg)

  console.log('\n── refusals')
  let threw = false
  try { qrSvg('') } catch { threw = true }
  check('empty input is refused', threw)
  check('a long URI still encodes', qrSvg('x'.repeat(500)).length > 0)

  console.log(`\n${pass === total ? 'All' : `${pass} of`} ${total} checks passed`)
  process.exit(pass === total ? 0 : 1)
}

run()
