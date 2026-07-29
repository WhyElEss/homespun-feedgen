import dotenv from 'dotenv'
import fs from 'node:fs'
import readline from 'node:readline/promises'
import { stdin, stdout } from 'node:process'
import { AtpAgent } from '@atproto/api'

// Recreates a feed record that was deleted — e.g. by SkyFeed, which deletes
// the live record both when you press "unpublish" AND when you remove the
// feed from its builder list.
//
// Writing to the SAME rkey restores the original AT-URI, so every saved-feed
// reference and every like reattaches (the AppView aggregates by URI).
//
// displayName, description and createdAt come from the backup. The record is
// recreated already pointing at OUR service, with no skyfeedBuilder, so there
// is no second write and SkyFeed cannot manage it again.
//
// Deleting a record also drops its avatar blob from the PDS, so the avatar is
// re-uploaded from a local copy.
//
// Usage: ts-node scripts/restoreFeed.ts <rkey>
//   expects /data/feed-record-backup-<rkey>.json
//   and    /data/feed-avatar-<rkey>.bin   (if the backup record had an avatar)

const run = async () => {
  dotenv.config()
  const rkey = process.argv[2]
  if (!rkey) {
    console.error('usage: restoreFeed.ts <rkey>')
    process.exit(2)
  }

  const serviceDid = process.env.FEEDGEN_SERVICE_DID
  const publisherDid = process.env.FEEDGEN_PUBLISHER_DID
  if (!serviceDid || !publisherDid) {
    throw new Error('FEEDGEN_SERVICE_DID / FEEDGEN_PUBLISHER_DID missing in .env')
  }

  const backupPath = `/data/feed-record-backup-${rkey}.json`
  const avatarPath = `/data/feed-avatar-${rkey}.bin`

  const backup = JSON.parse(fs.readFileSync(backupPath, 'utf8')) as {
    value: Record<string, any>
  }
  const v = backup.value
  const createdAt = v.createdAt
  if (typeof createdAt !== 'string') {
    throw new Error('backup has no createdAt — refusing to guess')
  }
  const wantsAvatar = !!v.avatar
  const avatarMime: string | undefined = v.avatar?.mimeType
  if (wantsAvatar && !fs.existsSync(avatarPath)) {
    throw new Error(
      `backup record has an avatar (${avatarMime}) but ${avatarPath} is missing — ` +
        `copy the blob there first, or the feed comes back without its picture`,
    )
  }

  console.log(`Restoring at://${publisherDid}/app.bsky.feed.generator/${rkey}`)
  console.log(`  displayName: ${v.displayName}`)
  console.log(`  createdAt:   ${createdAt} (from backup)`)
  console.log(`  service did: ${serviceDid} (ours — not SkyFeed)`)
  console.log(`  avatar:      ${wantsAvatar ? `${avatarPath} (${avatarMime})` : 'none'}`)

  const rl = readline.createInterface({ input: stdin, output: stdout })
  const handle = await rl.question('\nBluesky handle: ')
  const password = await rl.question('App password: ')

  const agent = new AtpAgent({ service: 'https://bsky.social' })
  try {
    await agent.login({ identifier: handle.trim(), password })
  } catch (err: any) {
    if (err?.error !== 'AuthFactorTokenRequired') throw err
    const token = await rl.question('Email 2FA code: ')
    await agent.login({
      identifier: handle.trim(),
      password,
      authFactorToken: token.trim(),
    })
  }

  // Refuse to clobber a record that came back on its own
  let exists = false
  try {
    await agent.com.atproto.repo.getRecord({
      repo: publisherDid,
      collection: 'app.bsky.feed.generator',
      rkey,
    })
    exists = true
  } catch {
    // RecordNotFound — good, that is what we are fixing
  }
  if (exists) {
    rl.close()
    throw new Error(`Record ${rkey} already exists — nothing to restore. Aborting.`)
  }

  const confirmed = await rl.question(`Type the rkey (${rkey}) to restore: `)
  rl.close()
  if (confirmed.trim() !== rkey) {
    console.log('Aborted, nothing written.')
    return
  }

  const record: Record<string, unknown> = {
    $type: 'app.bsky.feed.generator',
    did: serviceDid,
    displayName: v.displayName,
    description: v.description,
    createdAt,
  }

  if (wantsAvatar) {
    const bytes = fs.readFileSync(avatarPath)
    const uploaded = await agent.com.atproto.repo.uploadBlob(bytes, {
      encoding: avatarMime ?? 'image/png',
    })
    record.avatar = uploaded.data.blob
    console.log(`Avatar re-uploaded (${bytes.length} bytes)`)
  }

  // The PDS has returned a bare 500 on this write before, with a payload it
  // had no reason to reject. Retry a few times on 5xx; anything else (a real
  // validation error, auth failure) is raised immediately.
  const put = async () => {
    for (let attempt = 1; ; attempt++) {
      try {
        await agent.com.atproto.repo.putRecord({
          repo: publisherDid,
          collection: 'app.bsky.feed.generator',
          rkey,
          record,
        })
        return
      } catch (err: any) {
        const status = err?.status ?? 0
        if (status < 500 || attempt >= 4) throw err
        const wait = attempt * 2000
        console.log(
          `putRecord failed with HTTP ${status} (attempt ${attempt}/4) — retrying in ${wait / 1000}s`,
        )
        await new Promise((r) => setTimeout(r, wait))
      }
    }
  }
  await put()

  console.log('\nRestored, and already pointing at our feed generator.')
  console.log(
    `Check: https://public.api.bsky.app/xrpc/app.bsky.feed.getFeedGenerator?feed=at://${publisherDid}/app.bsky.feed.generator/${rkey}`,
  )
}

run().catch((err) => {
  console.error(err)
  process.exit(1)
})
