import dotenv from 'dotenv'
import fs from 'node:fs'
import readline from 'node:readline/promises'
import { stdin, stdout } from 'node:process'
import { AtpAgent } from '@atproto/api'

// Repoints an EXISTING feed record (e.g. published via SkyFeed) to this
// feed generator, preserving the AT-URI — and with it every subscriber
// and like. Only the `did` field changes; displayName, description,
// avatar and createdAt are kept as-is (set FEEDGEN_AVATAR_PATH to also
// replace the avatar). The skyfeedBuilder block, if present, is dropped
// so the feed is no longer editable from SkyFeed — a stray "publish"
// there would silently repoint the feed back.
//
// IMPORTANT if you migrate from SkyFeed: remove the feed from SkyFeed's
// builder BEFORE running this. SkyFeed's "unpublish" button DELETES the
// live record. (If that happens anyway: scripts/restoreFeedRecord.ts.)
//
// The original record is backed up to /data (mounted to ./data on the
// host) before anything is written.
//
// Usage: docker compose run --rm feedgen yarn migrateFeed

const run = async () => {
  dotenv.config()
  const serviceDid = process.env.FEEDGEN_SERVICE_DID
  const publisherDid = process.env.FEEDGEN_PUBLISHER_DID
  const rkey = process.env.FEEDGEN_SHORTNAME
  const avatarPath = process.env.FEEDGEN_AVATAR_PATH // optional
  if (!serviceDid || !publisherDid || !rkey) {
    throw new Error(
      'FEEDGEN_SERVICE_DID / FEEDGEN_PUBLISHER_DID / FEEDGEN_SHORTNAME missing in .env',
    )
  }

  const rl = readline.createInterface({ input: stdin, output: stdout })
  const handle = await rl.question('Bluesky handle: ')
  const password = await rl.question('App password: ')

  const agent = new AtpAgent({ service: 'https://bsky.social' })
  await agent.login({ identifier: handle.trim(), password })

  const existing = await agent.com.atproto.repo.getRecord({
    repo: publisherDid,
    collection: 'app.bsky.feed.generator',
    rkey,
  })
  const record = existing.data.value as Record<string, unknown>

  const backupPath = `/data/feed-record-backup-${rkey}.json`
  fs.writeFileSync(backupPath, JSON.stringify(existing.data, null, 2))
  console.log(`Backup written to ${backupPath} (host: ./data)`)
  console.log(`Feed:            ${record.displayName}`)
  console.log(`Current service: ${record.did}`)
  console.log(`New service:     ${serviceDid}`)
  if (avatarPath) console.log(`New avatar:      ${avatarPath}`)

  const confirmed = await rl.question('Repoint the feed? (yes/no): ')
  rl.close()
  if (confirmed.trim().toLowerCase() !== 'yes') {
    console.log('Aborted, nothing written.')
    return
  }

  if (avatarPath) {
    const bytes = fs.readFileSync(avatarPath)
    const encoding = avatarPath.endsWith('.png') ? 'image/png' : 'image/jpeg'
    const uploaded = await agent.com.atproto.repo.uploadBlob(bytes, { encoding })
    record.avatar = uploaded.data.blob
  }

  record.did = serviceDid
  delete record.skyfeedBuilder

  await agent.com.atproto.repo.putRecord({
    repo: publisherDid,
    collection: 'app.bsky.feed.generator',
    rkey,
    record,
    swapRecord: existing.data.cid, // fail instead of clobbering a concurrent edit
  })

  console.log('Done. The feed now points at this feed generator.')
  console.log(
    `Check: https://public.api.bsky.app/xrpc/app.bsky.feed.getFeedGenerator?feed=at://${publisherDid}/app.bsky.feed.generator/${rkey}`,
  )
}

run().catch((err) => {
  console.error(err)
  process.exit(1)
})
