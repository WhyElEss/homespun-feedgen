import dotenv from 'dotenv'
import readline from 'node:readline/promises'
import { stdin, stdout } from 'node:process'
import { AtpAgent } from '@atproto/api'

const run = async () => {
  dotenv.config()
  const hostname = process.env.FEEDGEN_HOSTNAME
  if (!hostname) throw new Error('FEEDGEN_HOSTNAME is missing in .env')

  const rl = readline.createInterface({ input: stdin, output: stdout })
  const handle = await rl.question('Bluesky handle: ')
  const password = await rl.question(
    'Account password (the MAIN password, NOT an app password): ',
  )

  const agent = new AtpAgent({ service: 'https://bsky.social' })
  try {
    await agent.login({ identifier: handle.trim(), password })
  } catch (err) {
    // Accounts with email 2FA reject the first attempt and email a
    // sign-in code; retry with authFactorToken
    if ((err as { error?: string })?.error !== 'AuthFactorTokenRequired') {
      throw err
    }
    const authFactorToken = await rl.question(
      'Email 2FA: sign-in code from email (NOT the PLC code yet): ',
    )
    await agent.login({
      identifier: handle.trim(),
      password,
      authFactorToken: authFactorToken.trim(),
    })
  }
  const did = agent.session?.did
  if (!did || !did.startsWith('did:plc:')) {
    throw new Error(`Expected a did:plc account, got: ${did}`)
  }
  console.log(`Logged in as ${did}`)

  const res = await fetch(`https://plc.directory/${did}/data`)
  if (!res.ok) throw new Error(`plc.directory error: HTTP ${res.status}`)
  const data = (await res.json()) as {
    services: Record<string, { type: string; endpoint: string }>
  }
  console.log('Current services:', Object.keys(data.services).join(', '))

  await agent.com.atproto.identity.requestPlcOperationSignature()
  const token = await rl.question('Confirmation code from email: ')
  rl.close()

  const services = {
    ...data.services,
    bsky_fg: {
      type: 'BskyFeedGenerator',
      endpoint: `https://${hostname}`,
    },
  }

  const signed = await agent.com.atproto.identity.signPlcOperation({
    token: token.trim(),
    services,
  })
  await agent.com.atproto.identity.submitPlcOperation({
    operation: signed.data.operation,
  })

  console.log('Done. Verify the DID document:')
  console.log(`  https://plc.directory/${did}`)
}

run().catch((err) => {
  console.error(err)
  process.exit(1)
})
