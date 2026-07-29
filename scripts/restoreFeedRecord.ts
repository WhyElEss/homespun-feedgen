import dotenv from 'dotenv'
import fs from 'node:fs'
import readline from 'node:readline/promises'
import { stdin, stdout } from 'node:process'
import { AtpAgent } from '@atproto/api'

// Disaster recovery: recreates a deleted feed record from the backup made
// by migrateFeedRecord.ts (the classic accident: SkyFeed's "unpublish"
// button deletes the live record). Writing to the SAME rkey restores the
// original AT-URI, so subscribers' saved feeds and likes work again —
// both live in OTHER users' repos and reference the URI, they are not
// deleted with your record. Act quickly: users who manually remove the
// "broken" feed from their saved list during the outage are lost.
//
// Avatar: set FEEDGEN_AVATAR_PATH to re-upload (recommended — the old
// blob may have been garbage-collected after the record deletion);
// otherwise the blob reference from the backup is reused as-is.
//
// Usage: docker compose run --rm feedgen yarn restoreFeed

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

  const backupPath = `/data/feed-record-backup-${rkey}.json`
  const backup = JSON.parse(fs.readFileSync(backupPath, 'utf8')) as {
    value: Record<string, unknown>
  }
  const record = { ...backup.value }

  const rl = readline.createInterface({ input: stdin, output: stdout })
  const handle = await rl.question('Bluesky handle: ')
  const password = await rl.question('App password: ')

  const agent = new AtpAgent({ service: 'https://bsky.social' })
  await agent.login({ identifier: handle.trim(), password })

  // Refuse to overwrite if the record exists — this script is for recovery
  let exists = false
  try {
    await agent.com.atproto.repo.getRecord({
      repo: publisherDid,
      collection: 'app.bsky.feed.generator',
      rkey,
    })
    exists = true
  } catch {
    // not found — good, proceed
  }
  if (exists) {
    rl.close()
    throw new Error(`Record ${rkey} already exists — nothing to restore.`)
  }

  console.log(`Restoring at://${publisherDid}/app.bsky.feed.generator/${rkey}`)
  console.log(`Feed:        ${record.displayName}`)
  console.log(`Service did: ${serviceDid}`)
  const confirmed = await rl.question('Restore the feed record? (yes/no): ')
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
  })

  console.log('Restored. Verify:')
  console.log(
    `  https://public.api.bsky.app/xrpc/app.bsky.feed.getFeedGenerator?feed=at://${publisherDid}/app.bsky.feed.generator/${rkey}`,
  )
}

run().catch((err) => {
  console.error(err)
  process.exit(1)
})
