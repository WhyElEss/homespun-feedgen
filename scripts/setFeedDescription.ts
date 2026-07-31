import dotenv from 'dotenv'
import fs from 'node:fs'
import readline from 'node:readline/promises'
import { stdin, stdout } from 'node:process'
import { AtpAgent } from '@atproto/api'

// Replaces a feed record's description in place. Everything else — did,
// displayName, avatar, createdAt — is carried over untouched, and the AT-URI
// never changes, so likes and subscribers are unaffected.
//
// Safety: backs the record up before writing, uses swapRecord so a concurrent
// edit fails the write instead of being clobbered, retries 5xx (the PDS does
// return the occasional bare 500 on a payload it has no reason to reject), and
// checks the text against the lexicon's grapheme and byte limits before asking
// for a password.
//
// NOTE: this changes the description and nothing else. It is NOT a way to move
// a feed up in feed search. A putRecord update does make the AppView reingest
// the record — the new description is served within minutes — but search
// ranking is a separate structure that does not move. Tested; don't reach for
// this expecting that.
//
// Usage: ts-node scripts/setFeedDescription.ts <rkey>
//   reads the new text from /data/feed-description-<rkey>.txt

const LIMIT_GRAPHEMES = 300
const LIMIT_BYTES = 3000

const graphemes = (s: string): number =>
  [...new Intl.Segmenter('en', { granularity: 'grapheme' }).segment(s)].length

const run = async () => {
  dotenv.config()
  const rkey = process.argv[2]
  if (!rkey) {
    console.error('usage: setFeedDescription.ts <rkey>')
    process.exit(2)
  }

  const publisherDid = process.env.FEEDGEN_PUBLISHER_DID
  if (!publisherDid) throw new Error('FEEDGEN_PUBLISHER_DID missing in .env')

  const path = `/data/feed-description-${rkey}.txt`
  if (!fs.existsSync(path)) throw new Error(`${path} not found`)
  // A trailing newline from an editor is not part of the description.
  const next = fs.readFileSync(path, 'utf8').replace(/\n+$/, '')

  const g = graphemes(next)
  const b = Buffer.byteLength(next, 'utf8')
  console.log(`New description: ${g}/${LIMIT_GRAPHEMES} graphemes, ${b}/${LIMIT_BYTES} bytes`)
  if (g > LIMIT_GRAPHEMES || b > LIMIT_BYTES) {
    throw new Error('description exceeds the lexicon limits — refusing to write')
  }

  const rl = readline.createInterface({ input: stdin, output: stdout })
  const handle = await rl.question('Bluesky handle: ')
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

  const existing = await agent.com.atproto.repo.getRecord({
    repo: publisherDid,
    collection: 'app.bsky.feed.generator',
    rkey,
  })
  const record = existing.data.value as Record<string, any>

  const backupPath = `/data/feed-record-backup-${rkey}.json`
  fs.writeFileSync(backupPath, JSON.stringify(existing.data, null, 2))
  console.log(`\nBacked up to ${backupPath}`)
  console.log(`Feed: ${record.displayName} (${rkey})`)

  if (record.description === next) {
    console.log('\nThe description is already exactly this — nothing to write.')
    rl.close()
    return
  }

  console.log('\n--- current ---')
  console.log(record.description)
  console.log('\n+++ new +++')
  console.log(next)

  const confirmed = await rl.question(`\nType the rkey (${rkey}) to write: `)
  rl.close()
  if (confirmed.trim() !== rkey) {
    console.log('Aborted, nothing written.')
    return
  }

  record.description = next

  for (let attempt = 1; ; attempt++) {
    try {
      await agent.com.atproto.repo.putRecord({
        repo: publisherDid,
        collection: 'app.bsky.feed.generator',
        rkey,
        record,
        swapRecord: existing.data.cid, // fail rather than clobber a concurrent edit
      })
      break
    } catch (err: any) {
      const status = err?.status ?? 0
      if (status < 500 || attempt >= 4) throw err
      const wait = attempt * 2000
      console.log(`putRecord failed with HTTP ${status} (attempt ${attempt}/4) — retrying in ${wait / 1000}s`)
      await new Promise((r) => setTimeout(r, wait))
    }
  }

  console.log('\nWritten. The AppView serves the new description within a few minutes.')
  console.log(
    `Check: curl -s "https://public.api.bsky.app/xrpc/app.bsky.feed.getFeedGenerator?feed=at://${publisherDid}/app.bsky.feed.generator/${rkey}"`,
  )
}

run().catch((err) => {
  console.error(err)
  process.exit(1)
})
