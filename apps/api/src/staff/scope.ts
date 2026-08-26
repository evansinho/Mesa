import { eq, or, isNull, type SQL } from 'drizzle-orm'
import { prospects } from '@mesa/db'
import type { ApiAuth } from '../auth-context'
import { can } from './permissions'

type StaffAuth = Extract<ApiAuth, { kind: 'staff' }>

/**
 * Row-level scope for prospect queries.
 *
 * Scope is a WHERE clause, not a middleware — no preHandler can express "only
 * rows you own", which is exactly why it is the part that leaks. Handlers must
 * never build a prospect query without this; the recurring bug in tools like
 * this is a detail endpoint that checks the permission and forgets the
 * ownership.
 *
 * Returns `undefined` for roles that legitimately see everything, which callers
 * pass straight to drizzle's `and(...)` — it ignores undefined.
 */
export function prospectScope(auth: StaffAuth): SQL | undefined {
  if (can(auth.role, 'prospect:read:all')) return undefined

  // A member sees their own prospects plus the unowned pool — unowned signups
  // are claimable by anyone, so hiding them would make the Claim notification
  // lead to a 404.
  return or(eq(prospects.ownerId, auth.staffId), isNull(prospects.ownerId))
}

/** Whether this staff member may mutate a specific prospect. */
export function canMutateProspect(auth: StaffAuth, ownerId: string | null): boolean {
  if (can(auth.role, 'prospect:read:all')) return true
  return ownerId === null || ownerId === auth.staffId
}
