import express from 'express'
import { iconRoutes } from '../src/icons'
import { ADMIN_PAGE } from '../src/adminPage'

// The icons are served from the root, where browsers and Safari look for them,
// and the admin page points at the same paths.

let pass = 0
let total = 0
const check = (name: string, cond: boolean, detail = '') => {
  total++
  if (cond) pass++
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? `  [${detail}]` : ''}`)
}

// Width and height from a PNG's IHDR chunk.
const pngSize = (b: Buffer) => [b.readUInt32BE(16), b.readUInt32BE(20)]

const run = async () => {
  const app = express().use(iconRoutes())
  const server = app.listen(0, '127.0.0.1')
  await new Promise((r) => server.once('listening', r))
  const base = `http://127.0.0.1:${(server.address() as any).port}`

  console.log('\n── served from the root')
  const got: Record<string, Buffer> = {}
  for (const [path, type] of [
    ['/favicon.svg', 'image/svg+xml'],
    ['/favicon-32.png', 'image/png'],
    ['/favicon.ico', 'image/x-icon'],
    ['/apple-touch-icon.png', 'image/png'],
  ]) {
    const r = await fetch(base + path)
    got[path] = Buffer.from(await r.arrayBuffer())
    const ctype = r.headers.get('content-type') ?? ''
    check(path, r.status === 200 && ctype.startsWith(type), `${r.status} ${ctype}`)
  }
  server.close()

  console.log('\n── the bytes are what they claim to be')
  check('favicon-32 is 32x32', pngSize(got['/favicon-32.png']).join('x') === '32x32')
  check('apple-touch-icon is 180x180', pngSize(got['/apple-touch-icon.png']).join('x') === '180x180')
  check('the .ico has an ICO header', got['/favicon.ico'].readUInt32LE(0) === 0x00010000)
  check('...wrapping the 32 px PNG', got['/favicon.ico'].subarray(22).equals(got['/favicon-32.png']))
  check('the svg is an svg', got['/favicon.svg'].toString().startsWith('<svg'))

  console.log('\n── the admin page links them')
  for (const tag of [
    '<link rel="icon" href="/favicon.svg" type="image/svg+xml">',
    '<link rel="icon" type="image/png" sizes="32x32" href="/favicon-32.png">',
    '<link rel="apple-touch-icon" sizes="180x180" href="/apple-touch-icon.png">',
  ]) {
    check(tag.match(/href="([^"]+)"/)![1], ADMIN_PAGE.includes(tag))
  }

  console.log(`\n${pass}/${total} passed`)
  process.exit(pass === total ? 0 : 1)
}

run()
