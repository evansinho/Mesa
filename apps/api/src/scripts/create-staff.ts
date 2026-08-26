/**
 * Bootstrap or add an internal staff account.
 *
 *   pnpm --filter @mesa/api staff:create -- --email you@mesa.co --name "Your Name" --role admin
 *
 * Prints a generated temporary password once. There is no other way to create
 * the first admin — staff accounts are deliberately not self-serve, and the
 * merchant signup path cannot produce one.
 */
import { randomBytes } from 'crypto'
import { eq } from 'drizzle-orm'
import { config } from '@mesa/config'
import { closeDb, getDb, staff } from '@mesa/db'
import { hashPassword } from '../staff/password'

type Role = 'admin' | 'manager' | 'member'
const ROLES: Role[] = ['admin', 'manager', 'member']

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`)
  return i === -1 ? undefined : process.argv[i + 1]
}

async function main() {
  const email = arg('email')?.trim().toLowerCase()
  const name = arg('name')?.trim()
  const role = (arg('role') ?? 'member') as Role
  const refCode = arg('ref-code')?.trim()

  if (!email || !name) {
    console.error('Usage: --email <email> --name <name> [--role admin|manager|member] [--ref-code <code>]')
    process.exit(1)
  }
  if (!ROLES.includes(role)) {
    console.error(`--role must be one of: ${ROLES.join(', ')}`)
    process.exit(1)
  }

  const db = getDb(config.DATABASE_URL)

  const existing = await db.query.staff.findFirst({ where: eq(staff.email, email) })
  if (existing) {
    console.error(`A staff member already exists with email ${email}`)
    process.exit(1)
  }

  // 18 random bytes → 24 base64url chars. Comfortably above the 12-character
  // minimum the change-password route enforces.
  const tempPassword = randomBytes(18).toString('base64url')

  const [created] = await db
    .insert(staff)
    .values({
      name,
      email,
      passwordHash: await hashPassword(tempPassword),
      role,
      // Forces a change on first login, so this printed value never becomes
      // the long-lived password.
      mustResetPassword: true,
      refCode: refCode || null,
    })
    .returning()

  console.log('\nStaff account created:')
  console.log(`  id:       ${created.id}`)
  console.log(`  name:     ${created.name}`)
  console.log(`  email:    ${created.email}`)
  console.log(`  role:     ${created.role}`)
  if (created.refCode) console.log(`  ref code: ${created.refCode}`)
  console.log(`\n  temporary password: ${tempPassword}`)
  console.log('  (shown once — must be changed on first login)\n')

  // Close the pool rather than process.exit(0): exiting abruptly kills tsx's
  // esbuild service mid-transform and turns a successful run into a stack trace.
  await closeDb()
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
