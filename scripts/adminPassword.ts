// Turn a password into the scrypt hash that FEEDGEN_ADMIN_PASSWORD_HASH wants.
// Usage: yarn adminPassword     (prompts twice, echo off)
//        echo 's3cret' | yarn adminPassword   (for scripted setup)
//
// The plaintext is never written anywhere: not to a file, not to the shell
// history, not to the terminal. What it prints is the line to paste into .env.
import readline from 'node:readline/promises'
import { stdin, stdout } from 'node:process'
import { hashPassword, verifyPassword, looksLikeHash } from '../src/adminAuth'

// The admin UI is the only thing between the internet and the config of live
// feeds, so this floor is deliberate rather than advisory.
const MIN_LENGTH = 12

const askHidden = async (prompt: string): Promise<string> => {
  const rl = readline.createInterface({ input: stdin, output: stdout, terminal: true })
  // readline echoes every keystroke by default. Suppressing the write hook is
  // the documented-enough way to get a silent prompt without a dependency.
  const anyRl = rl as any
  const original = anyRl._writeToOutput?.bind(rl)
  anyRl._writeToOutput = (chunk: string) => {
    if (original && chunk.includes(prompt)) original(chunk)
  }
  try {
    const answer = await rl.question(prompt)
    stdout.write('\n')
    return answer
  } finally {
    rl.close()
  }
}

const readPiped = async (): Promise<string> => {
  const chunks: Buffer[] = []
  for await (const chunk of stdin) chunks.push(Buffer.from(chunk))
  return Buffer.concat(chunks).toString('utf8').replace(/\r?\n$/, '')
}

const run = async () => {
  let password: string

  if (stdin.isTTY) {
    password = await askHidden('Admin password: ')
    const again = await askHidden('Repeat: ')
    if (password !== again) throw new Error('the two entries differ')
  } else {
    password = await readPiped()
  }

  if (password.length < MIN_LENGTH) {
    throw new Error(
      `password must be at least ${MIN_LENGTH} characters — this is the only ` +
        `barrier in front of the admin UI`,
    )
  }

  const hash = await hashPassword(password)

  // Verify what we are about to print actually matches what was typed. A hash
  // that does not round-trip would lock the operator out of their own box, and
  // finding that out at the login screen is the expensive way.
  if (!looksLikeHash(hash) || !(await verifyPassword(password, hash))) {
    throw new Error('generated hash failed its own verification — refusing to print it')
  }

  // Say this before printing the lines, and say it plainly: run inside the
  // container — which is how the yarn alias runs it — this process cannot write
  // .env even if it wanted to, because compose mounts only ./data. An operator
  // who assumes "it saved" ends up with a service that never got the password.
  stdout.write('\n=== NOTHING HAS BEEN SAVED ===\n')
  stdout.write('This cannot write .env: it runs inside the container, and .env is not\n')
  stdout.write('mounted into it. Copy the two lines below into .env ON THE HOST by hand,\n')
  stdout.write('using an editor rather than a shell redirect, so the hash stays out of\n')
  stdout.write('your shell history. Then: docker compose up -d feedgen\n\n')
  stdout.write(`FEEDGEN_ADMIN_UI="on"\n`)
  stdout.write(`FEEDGEN_ADMIN_PASSWORD_HASH="${hash}"\n\n`)
  stdout.write('Leave both UNSET on a standby box, or it publishes its own login page.\n')
  stdout.write('The login form asks for the password only — there is no username.\n')
}

run().catch((err) => {
  console.error(String(err?.message ?? err))
  process.exit(1)
})
