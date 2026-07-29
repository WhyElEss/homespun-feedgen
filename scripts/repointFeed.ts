import dotenv from 'dotenv'
import fs from 'node:fs'
import readline from 'node:readline/promises'
import { stdin, stdout } from 'node:process'
import { AtpAgent } from '@atproto/api'

// Repoints an existing SkyFeed-published feed record at our own feed
// generator, preserving the AT-URI — and with it every subscriber and like.
//
// Deliberately minimal compared to migrateFeedRecord.ts: displayName,
// description, avatar and createdAt are left exactly as published. Only two
// things change:
//   did              -> our service DID
//   skyfeedBuilder   -> removed
//
// Dropping skyfeedBuilder also takes the feed's regexes out of public view,
// and stops SkyFeed from being able to edit the feed. The original record is
// backed up to /data before anything is written.
//
// Usage: ts-node scripts/repointFeed.ts <rkey>

const run = async () => {
  dotenv.config()
  const rkey = process.argv[2]
  if (!rkey) {
    console.error('usage: repointFeed.ts <rkey>')
    process.exit(2)
  }

  const serviceDid = process.env.FEEDGEN_SERVICE_DID
  const publisherDid = process.env.FEEDGEN_PUBLISHER_DID
  if (!serviceDid || !publisherDid) {
    throw new Error('FEEDGEN_SERVICE_DID / FEEDGEN_PUBLISHER_DID missing in .env')
  }

  const rl = readline.createInterface({ input: stdin, output: stdout })
  const handle = await rl.question('Bluesky handle: ')
  const password = await rl.question('App password: ')

  const agent = new AtpAgent({ service: 'https://bsky.social' })
  try {
    await agent.login({ identifier: handle.trim(), password })
  } catch (err: any) {
    // The account has email 2FA, so the first login attempt is expected to
    // come back asking for the code.
    if (err?.error !== 'AuthFactorTokenRequired') throw err
    const token = await rl.question('Email 2FA code: ')
    await agent.login({
      identifier: handle.trim(),
      password,
      authFactorToken: token.trim(),
    })
  }

  const existing = await agent.com.atproto.repo.getRecord({
    repo: publisherDid,
    collection: 'app.bsky.feed.generator',
    rkey,
  })
  const record = existing.data.value as Record<string, any>

  const backupPath = `/data/feed-record-backup-${rkey}.json`
  fs.writeFileSync(backupPath, JSON.stringify(existing.data, null, 2))

  console.log(`\nBackup written to ${backupPath} (host: ./data)`)
  console.log(`Feed:            ${record.displayName}`)
  console.log(`rkey:            ${rkey}`)
  console.log(`Current service: ${record.did}`)
  console.log(`New service:     ${serviceDid}`)
  console.log(`Avatar:          ${record.avatar ? 'kept as published' : 'none'}`)
  console.log(
    `skyfeedBuilder:  ${record.skyfeedBuilder ? 'present — will be removed' : 'absent'}`,
  )

  if (record.did === serviceDid) {
    console.log('\nThis feed already points at our service. Nothing to do.')
    rl.close()
    return
  }
  if (!record.skyfeedBuilder) {
    console.log(
      '\nWARNING: no skyfeedBuilder block — this record may not be a SkyFeed feed.',
    )
  }

  console.log(
    '\nDo NOT touch this feed in SkyFeed — not before, not after. Both its ' +
      '"unpublish" button AND removing the feed from its builder list DELETE ' +
      'the live record (and the PDS then garbage-collects the avatar blob). ' +
      'Repoint first, then leave the orphaned entry in SkyFeed alone.\n' +
      'If the record does get deleted: scripts/restoreFeed.ts recreates it ' +
      'at the same rkey from the backup, and likes survive.',
  )
  const confirmed = await rl.question(`Type the rkey (${rkey}) to repoint: `)
  rl.close()
  if (confirmed.trim() !== rkey) {
    console.log('Aborted, nothing written.')
    return
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

  console.log('\nDone. The feed now points at this feed generator.')
  console.log(
    `Check: https://public.api.bsky.app/xrpc/app.bsky.feed.getFeedGenerator?feed=at://${publisherDid}/app.bsky.feed.generator/${rkey}`,
  )
}

run().catch((err) => {
  console.error(err)
  process.exit(1)
})
