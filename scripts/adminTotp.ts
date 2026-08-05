// Makes the shared secret for the admin login's second factor.
// Usage: yarn adminTotp [account-name]
//
// Prints the secret and an otpauth:// URI. There is no QR code on purpose:
// drawing one needs either a dependency or three hundred lines of encoder, and
// every authenticator app accepts a secret typed by hand — which is the same
// fallback Homebridge offers under its QR.
import { generateSecret, otpauthUri, codeFor, verifyTotp } from '../src/adminTotp'

const run = async () => {
  const account = process.argv[2] || process.env.FEEDGEN_ADMIN_USER || 'admin'
  const issuer = process.env.FEEDGEN_HOSTNAME || 'feedgen'
  const secret = generateSecret()

  // Prove the secret works before handing it over: a secret that does not
  // round-trip would lock the operator out at the login screen, which is an
  // expensive place to find out.
  const now = codeFor(secret)
  if (!verifyTotp(secret, now).ok) {
    throw new Error('generated secret failed its own check — refusing to print it')
  }

  process.stdout.write('\n=== NOTHING HAS BEEN SAVED ===\n')
  process.stdout.write('This cannot write .env: it runs inside the container, and .env is\n')
  process.stdout.write('not mounted into it. Copy the line below into .env ON THE HOST,\n')
  process.stdout.write('then: docker compose up -d feedgen\n\n')

  process.stdout.write(`FEEDGEN_ADMIN_TOTP_SECRET="${secret}"\n\n`)

  process.stdout.write('Add it to your authenticator app, either by pasting this URI:\n\n')
  process.stdout.write(`  ${otpauthUri(secret, account, issuer)}\n\n`)
  process.stdout.write('or by entering the secret manually:\n\n')
  process.stdout.write(`  ${secret}\n\n`)
  process.stdout.write(`The app should be showing ${now} right now — if it shows something\n`)
  process.stdout.write('else, the clock on this machine and the one on your phone disagree,\n')
  process.stdout.write('and logins will fail. Fix that before restarting the service.\n\n')
  process.stdout.write('LOCKED OUT? Delete FEEDGEN_ADMIN_TOTP_SECRET from .env and restart.\n')
  process.stdout.write('The second factor disappears and the password alone works again.\n')
}

run().catch((err) => {
  console.error(String(err?.message ?? err))
  process.exit(1)
})
