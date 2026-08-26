import { createHash, randomBytes } from 'crypto'
import { eq, lt } from 'drizzle-orm'
import { staffSessions, type Db } from '@mesa/db'

// Shorter than a merchant session: staff tokens read across every merchant, so
// a stolen one is worth more.
export const STAFF_SESSION_TTL_MS = 12 * 60 * 60 * 1000

export function hashSessionToken(token: string): string {
  return createHash('sha256').update(token).digest('hex')
}

export async function createStaffSession(db: Db, staffId: string): Promise<{
  token: string
  expiresAt: Date
}> {
  const token = randomBytes(32).toString('hex')
  const expiresAt = new Date(Date.now() + STAFF_SESSION_TTL_MS)

  await db.insert(staffSessions).values({
    staffId,
    sessionHash: hashSessionToken(token),
    expiresAt,
  })

  // Opportunistic cleanup — there is no scheduled job for this yet and expired
  // rows are dead weight on the unique index.
  await db.delete(staffSessions).where(lt(staffSessions.expiresAt, new Date())).catch(() => {})

  return { token, expiresAt }
}

/**
 * Revoke every session for a staff member.
 *
 * Called on deactivation and on role change. Flipping `active = false` alone
 * would leave a departed staff member with working access until their token
 * expires — carrying every merchant's revenue and customer phone numbers.
 */
export async function revokeAllStaffSessions(db: Db, staffId: string): Promise<void> {
  await db.delete(staffSessions).where(eq(staffSessions.staffId, staffId))
}
