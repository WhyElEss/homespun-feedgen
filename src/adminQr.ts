import qrcode from 'qrcode-generator'

// A QR code for the enrolment URI, as an SVG small enough to inline.
//
// The library does the part worth trusting a library with — Reed-Solomon,
// masking, format bits — and this file does the part that is trivial and worth
// owning: turning its matrix into markup. That split matters for size. The
// ready-made renderers emit one <rect> per module and run 33–57 KB for a URI
// this long; one <path> over the same matrix is about 17 KB.
//
// On correctness: a wrong QR here cannot lock anyone out, because enrolment is
// only completed by a code that matches the secret the SERVER holds. If the
// image encoded something else, the authenticator's codes would not match and
// the setup would simply refuse. What IS worth testing is this file's drawing —
// a transposed or offset matrix still looks like a valid QR while scanning to
// nonsense — and testAdminQr compares every cell against the library's own.

// The quiet zone is part of the spec, not decoration: scanners need the margin
// to find the symbol at all.
const QUIET = 4

export type QrMatrix = { size: number; isDark: (row: number, col: number) => boolean }

export const qrMatrix = (text: string): QrMatrix => {
  if (!text) throw new Error('nothing to encode')
  // 0 = pick the smallest version that fits. 'M' recovers ~15%, the usual
  // choice for a screen where nothing is going to smudge it.
  const qr = qrcode(0, 'M')
  qr.addData(text)
  qr.make()
  return { size: qr.getModuleCount(), isDark: (r, c) => qr.isDark(r, c) }
}

export const qrSvg = (text: string): string => {
  const { size, isDark } = qrMatrix(text)
  let d = ''
  for (let r = 0; r < size; r++) {
    for (let c = 0; c < size; c++) {
      if (isDark(r, c)) d += `M${c} ${r}h1v1h-1z`
    }
  }
  const span = size + QUIET * 2
  // Black on white ALWAYS, whatever the page theme is doing. A QR inverted for
  // dark mode is a QR most scanners will not read.
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${-QUIET} ${-QUIET} ${span} ${span}" ` +
    `shape-rendering="crispEdges" role="img" aria-label="QR code">` +
    `<rect x="${-QUIET}" y="${-QUIET}" width="${span}" height="${span}" fill="#fff"/>` +
    `<path d="${d}" fill="#000"/></svg>`
  )
}

// Inlined into an <img> rather than injected as markup: the page never writes
// HTML it did not build node by node, and the Content-Security-Policy already
// allows data: images for exactly this.
export const qrDataUri = (text: string): string =>
  'data:image/svg+xml;base64,' + Buffer.from(qrSvg(text), 'utf8').toString('base64')
