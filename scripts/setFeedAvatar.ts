import dotenv from 'dotenv'
import fs from 'node:fs'
import path from 'node:path'
import readline from 'node:readline/promises'
import { stdin, stdout } from 'node:process'
import { AtpAgent } from '@atproto/api'

// Replaces the avatar of one or more feed records in place. Everything else —
// did, displayName, description, createdAt — is carried over untouched, and
// the AT-URI never changes, so likes and subscribers are unaffected.
//
// Every feed is done in a single run behind ONE login: with email 2FA enabled,
// a per-feed login means fishing a fresh code out of your inbox each time.
//
// Usage: ts-node scripts/setFeedAvatar.ts [rkey ...]
//   reads /data/feed-logo-<rkey>.png (or .jpg/.jpeg)
//   with no arguments: every rkey that has such a file
//
// Before writing, the current record and the current avatar blob are copied to
// /data/avatar-backup-<stamp>/. After a successful write the canonical restore
// pair — /data/feed-record-backup-<rkey>.json and /data/feed-avatar-<rkey>.bin
// — is refreshed to the NEW state, so `restoreFeed <rkey>` keeps bringing the
// feed back exactly as it is live right now.

const MAX_BLOB_BYTES = 1_000_000 // app.bsky.feed.generator avatar maxSize

const sniffMime = (bytes: Buffer): string => {
  if (
    bytes.length > 8 &&
    bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
  ) {
    return 'image/png'
  }
  if (bytes.length > 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return 'image/jpeg'
  }
  throw new Error('not a PNG or JPEG — the lexicon accepts nothing else')
}

// The XRPC client does NOT hand a record's blob back in wire shape: it
// deserializes it into a BlobRef whose `ref` is a CID instance, so the obvious
// `avatar.ref.$link` is undefined and every `?.` chain hanging off it quietly
// evaluates to nothing instead of throwing. Going through toJSON gives back
// the shape the record actually has. (This one cost us an avatar: the backup
// step below reported nothing wrong while writing no file at all.)
const blobLink = (blob: any): string | undefined =>
  blob ? JSON.parse(JSON.stringify(blob))?.ref?.$link : undefined

const findLogo = (rkey: string): string | undefined =>
  ['png', 'jpg', 'jpeg']
    .map((ext) => `/data/feed-logo-${rkey}.${ext}`)
    .find((p) => fs.existsSync(p))

const discoverRkeys = (): string[] =>
  fs
    .readdirSync('/data')
    .map((f) => f.match(/^feed-logo-(.+)\.(png|jpe?g)$/)?.[1])
    .filter((k): k is string => !!k)
    .sort()

const run = async () => {
  dotenv.config()

  const publisherDid = process.env.FEEDGEN_PUBLISHER_DID
  if (!publisherDid) throw new Error('FEEDGEN_PUBLISHER_DID missing in .env')

  // Read after dotenv.config(), or a PDS_URL set in .env is invisible here.
  const service = process.env.PDS_URL || 'https://bsky.social'

  const rkeys = process.argv.slice(2).length ? process.argv.slice(2) : discoverRkeys()
  if (!rkeys.length) {
    throw new Error('no /data/feed-logo-<rkey>.png files found and no rkeys given')
  }

  // Read and validate every image up front — an abort here costs nothing, an
  // abort after two of four feeds are written leaves a half-changed set.
  const jobs = rkeys.map((rkey) => {
    const file = findLogo(rkey)
    if (!file) throw new Error(`no /data/feed-logo-${rkey}.{png,jpg,jpeg}`)
    const bytes = fs.readFileSync(file)
    const mimeType = sniffMime(bytes)
    if (bytes.length > MAX_BLOB_BYTES) {
      throw new Error(
        `${file} is ${bytes.length} bytes — over the ${MAX_BLOB_BYTES} byte avatar limit`,
      )
    }
    return { rkey, file, bytes, mimeType }
  })

  console.log(`Logos read and validated (${jobs.length}):`)
  for (const job of jobs) {
    console.log(
      `  ${job.rkey}  <- ${path.basename(job.file)} (${job.mimeType}, ${job.bytes.length} bytes)`,
    )
  }

  const rl = readline.createInterface({ input: stdin, output: stdout })
  const handle = await rl.question('\nBluesky handle: ')
  const password = await rl.question('App password: ')

  const agent = new AtpAgent({ service })
  try {
    await agent.login({ identifier: handle.trim(), password })
  } catch (err: any) {
    // With email 2FA on, the first login attempt is expected to come back
    // asking for the code.
    if (err?.error !== 'AuthFactorTokenRequired') throw err
    const token = await rl.question('Email 2FA code: ')
    await agent.login({
      identifier: handle.trim(),
      password,
      authFactorToken: token.trim(),
    })
  }

  // Fetch every record first, so the plan printed below is the whole plan.
  const plan = await Promise.all(
    jobs.map(async (job) => {
      const existing = await agent.com.atproto.repo.getRecord({
        repo: publisherDid,
        collection: 'app.bsky.feed.generator',
        rkey: job.rkey,
      })
      return { ...job, existing: existing.data }
    }),
  )

  console.log('\nAbout to replace these avatars:')
  for (const p of plan) {
    const record = p.existing.value as Record<string, any>
    const old = record.avatar
    console.log(
      `  ${p.rkey}  ${record.displayName}\n` +
        `    from ${old ? `${blobLink(old)} (${old.mimeType}, ${old.size} bytes)` : 'no avatar'}\n` +
        `    to   ${path.basename(p.file)} (${p.mimeType}, ${p.bytes.length} bytes)`,
    )
  }

  const confirmed = await rl.question(`\nType YES to write all ${plan.length}: `)
  rl.close()
  if (confirmed.trim() !== 'YES') {
    console.log('Aborted, nothing written.')
    return
  }

  const stamp = new Date().toISOString().replace(/[:.]/g, '').replace(/-/g, '').slice(0, 15)
  const backupDir = `/data/avatar-backup-${stamp}`
  fs.mkdirSync(backupDir, { recursive: true })
  console.log(`\nBacking up the current state to ${backupDir}`)

  for (const p of plan) {
    const record = { ...(p.existing.value as Record<string, any>) }

    fs.writeFileSync(
      `${backupDir}/feed-record-backup-${p.rkey}.json`,
      JSON.stringify(p.existing, null, 2),
    )

    // Grab the outgoing blob too. Once no record references it the PDS is free
    // to garbage-collect it, and then it is gone for good.
    const oldRef = blobLink(record.avatar)
    if (record.avatar && !oldRef) {
      throw new Error(
        `${p.rkey} has an avatar but its CID could not be read — refusing to write ` +
          `and lose the outgoing blob`,
      )
    }
    if (oldRef) {
      // NOT agent.com.atproto.sync.getBlob: the bsky.social entryway answers
      // that one with a 302 to the account's real PDS host, and the XRPC
      // client does not follow redirects. Plain fetch does.
      const url =
        `${service}/xrpc/com.atproto.sync.getBlob` +
        `?did=${encodeURIComponent(publisherDid)}&cid=${encodeURIComponent(oldRef)}`
      try {
        const res = await (globalThis as any).fetch(url, { redirect: 'follow' })
        if (!res.ok) throw new Error(`HTTP ${res.status} ${await res.text()}`)
        const bytes = Buffer.from(await res.arrayBuffer())
        fs.writeFileSync(`${backupDir}/feed-avatar-${p.rkey}.bin`, bytes)
        console.log(`  ${p.rkey}: old blob saved (${bytes.length} bytes)`)
      } catch (err: any) {
        // Loud, not a shrug: once the new record lands, the PDS is free to
        // garbage-collect this blob and it is unrecoverable.
        console.log(
          `  ! ${p.rkey}: could NOT download the outgoing blob ${oldRef} — ${err?.message ?? err}`,
        )
        console.log(`    the old avatar will be lost once the new record is written`)
      }
    }

    const uploaded = await agent.com.atproto.repo.uploadBlob(p.bytes, {
      encoding: p.mimeType,
    })
    record.avatar = uploaded.data.blob

    // A PDS has returned a bare 500 on this write before, with a payload it
    // had no reason to reject. Retry a few times on 5xx; anything else (a real
    // validation error, auth failure) is raised immediately.
    let written: { uri: string; cid: string }
    for (let attempt = 1; ; attempt++) {
      try {
        const res = await agent.com.atproto.repo.putRecord({
          repo: publisherDid,
          collection: 'app.bsky.feed.generator',
          rkey: p.rkey,
          record,
          swapRecord: p.existing.cid, // fail rather than clobber a concurrent edit
        })
        written = res.data
        break
      } catch (err: any) {
        const status = err?.status ?? 0
        if (status < 500 || attempt >= 4) throw err
        const wait = attempt * 2000
        console.log(
          `  putRecord failed with HTTP ${status} (attempt ${attempt}/4) — retrying in ${wait / 1000}s`,
        )
        await new Promise((r) => setTimeout(r, wait))
      }
    }

    // Keep the canonical restore pair pointing at what is actually live.
    fs.writeFileSync(
      `/data/feed-record-backup-${p.rkey}.json`,
      JSON.stringify({ uri: written.uri, cid: written.cid, value: record }, null, 2),
    )
    fs.writeFileSync(`/data/feed-avatar-${p.rkey}.bin`, p.bytes)

    console.log(`  ${p.rkey}: written (${blobLink(record.avatar)})`)
  }

  console.log('\nDone. Clients cache avatars hard — expect a delay before the new ones show up.')
  for (const p of plan) {
    console.log(
      `Check: https://public.api.bsky.app/xrpc/app.bsky.feed.getFeedGenerator?feed=at://${publisherDid}/app.bsky.feed.generator/${p.rkey}`,
    )
  }
}

run().catch((err) => {
  console.error(err)
  process.exit(1)
})
