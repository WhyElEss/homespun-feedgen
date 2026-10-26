import express from 'express'

// The site's icons: a tab favicon, the .ico browsers fetch from the root on
// their own, and the apple-touch-icon Safari's Favorites and the iOS home
// screen look for at the root.
//
// Inlined for the same reason as the admin page: the service runs under
// ts-node straight from the image, with no build step to copy assets and no
// path relative to __dirname to get wrong. The PNGs are renders of ICON_SVG at
// 32 and 180 px; the .ico is the 32 px PNG in an ICO wrapper. Change the SVG,
// re-render all three.

export const ICON_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#3b82f6"/>
      <stop offset="1" stop-color="#1d4ed8"/>
    </linearGradient>
  </defs>
  <rect width="512" height="512" fill="url(#bg)"/>
  <!-- a feed: three posts, each an avatar and a line of text -->
  <circle cx="148" cy="148" r="44" fill="#fff"/>
  <rect x="220" y="120" width="196" height="56" rx="28" fill="#fff"/>
  <circle cx="148" cy="256" r="44" fill="#fff"/>
  <rect x="220" y="228" width="196" height="56" rx="28" fill="#fff"/>
  <circle cx="148" cy="364" r="44" fill="#fff"/>
  <rect x="220" y="336" width="196" height="56" rx="28" fill="#fff"/>
</svg>
`

const png = (b64: string) => Buffer.from(b64, 'base64')

const FAVICON_32 = png(
  'iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAYAAABzenr0AAAAAXNSR0IArs4c6QAAADhlWElmTU0A' +
  'KgAAAAgAAYdpAAQAAAABAAAAGgAAAAAAAqACAAQAAAABAAAAIKADAAQAAAABAAAAIAAAAACPTkDJ' +
  'AAAE30lEQVRYCbVWb2gcVRCf3dtLL7lLmnqpYvSDtviPIE2tClax1SKhlRMErQr2g3+oWEFEWkQU' +
  'hBYRv/WLUIug2H4QpEWUoFJaSakoQgtqEZGqSFstjcaa3OVicrfr/GbfvLzb270rBR93O7Pvzcxv' +
  'Zt7M2+fduXM2IjOiKCLP8wgUQ3lQGZgGqxrKm+VYqMMzRT8Im2GLRmSt8zQbFmdcAAXn5Sg0DjO9' +
  '1BFI1BJWu4kwCnnFI9C0oWuglzIQbIAosoZmQymAwCtgSMZBpmkjKZ+2xQEyrhG27TlbVXAASEa4' +
  'Hlx5nUtzQHWVAkt4EzN4yYAWWdueIrMQNhmWiFCoZqKbvNU1gBKgqRs4DH2pAbsNDCS8Acyx0Nho' +
  'nsolj4792KBfz8epthHBiKDAXPeR3DIE0loDxlPYzPlEe7aWaNU1gVh+diyil/bX6OgPDXm/9nKf' +
  '1o30UJ69tF3KeuBNF4tcdS6i8ePzNF2PjbsO2y1I831sdY8Fx3qQ8+jFSi9NnJympX0evftcPxUL' +
  'JlVpBpy5DTfn6am3ZqSltc6wDD7OgNqBk+CZIu3JUe73ZYuWD/gXDQ4bK65gPaRFfjHFPDLgY8/T' +
  '/hMn52mhycLOOPLtvBj66UyDPvp6jhYareuOqGWrcyHt/niWIrYFJyw1vLf6hT95Pjak6QHFWDeS' +
  'p+0PFgmRH/nuX3rjQI2q2EtNDtRMxkShyyNpH7je6POT8CVVNXmQWLAsB9SZjHXgqE0FlG+BRpwU' +
  'GL7Mp60bizTEGTjM6T/4Vb3VQDIDSQcUxaFusHEbInqTANkKNgI6WPRo3/Zlkn7o3zWyhIYGPHr7' +
  's5o4Ubm9QJtuW0I9gYbroDgstuydz2v0/W9x+zpLfICHcRe4NRCGfL5zDWy8tWDBVenxe/poz3iV' +
  'rl6eo11b+kVO1zrR668KaOzVyTYR4HB/LM4DHAPUno6Ly5brtGaFHMamXbFA+Y/AM+8D49/U6ZlN' +
  'JSoP4ECOx/uHa+LY6ckGvfLeP3Q/b0NPHnumEu10hrdg76czlLx3qKR309NnIhRD2riy7NO2ygDv' +
  'vU+HTtTpwLHZFjGt6Cz9FuGUFyn6G588nelAsiuSgMn1JEabPPqe992tuY73gXtHC/TyY4M0tDRH' +
  'h47Xaee+KarOtd4f/rf7wMrhgHZvK1PetFnljj4JcMfev6QNdz2xjB5Y23cRbRjSmx9coA8nuH0R' +
  'feI+4CMdKBD8lQddv6pgwTW1960pyFl+3XCOHrq72BUceqVen3ZsHhTgZrNpqfLxx4gBASofJUMn' +
  'LzQV11LMQe7cVIO/Cen3QCvsMKfOxh8xbT3pGm3DrJ7+5MsqPbK+RGtuKIgpfPle3z8lTv493aSH' +
  'X/uDNtzSy23INxfbh+gm9ORiV8HRg0erNrhkEXorH/0FX4h4qK7p64CPgMraEg0N5uiLE7N06veF' +
  'Fvvdqlzsqk0gKG/sY91bsfnnTAe6GjB+W5JMQAqgdcI4JBc+3Ya0KtU5AQEAtj4jY3YnNEIDIrqi' +
  'Fp8BenChnuRKhgNFZHnCpRCUPreIvJpmXOe6ZEBtgeroeB8QZxzEtpMPwAoKYeU1Q5hLDA0W0wgw' +
  'kAkTAVICI0JZIPL4HT9Qo6B3e5nAI16KX5VXaoXSmY73AajoqaU1Yp0zEcJRt63SYbJnofsf09oQ' +
  'jiYQnu8AAAAASUVORK5CYII=',
)

const APPLE_TOUCH_ICON = png(
  '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' +
  'AABJRU5ErkJggg==',
)

const FAVICON_ICO = png(
  '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',
)

// Served whether or not the admin UI is mounted: they say nothing about the box.
const ICONS: Record<string, { type: string; body: Buffer | string }> = {
  '/favicon.svg': { type: 'image/svg+xml', body: ICON_SVG },
  '/favicon-32.png': { type: 'image/png', body: FAVICON_32 },
  '/favicon.ico': { type: 'image/x-icon', body: FAVICON_ICO },
  '/apple-touch-icon.png': { type: 'image/png', body: APPLE_TOUCH_ICON },
}

export const iconRoutes = (): express.Router => {
  const router = express.Router()
  for (const [path, icon] of Object.entries(ICONS)) {
    router.get(path, (_req, res) => {
      res.setHeader('Cache-Control', 'public, max-age=86400')
      res.type(icon.type).send(icon.body)
    })
  }
  return router
}
