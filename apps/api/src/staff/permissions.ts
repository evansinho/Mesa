import type { FastifyReply, FastifyRequest } from 'fastify'
import type { ApiAuth, StaffRole } from '../auth-context'

// Static role → permission map. Deliberately not a policy engine: with three
// roles, a lookup table is auditable at a glance and a policy engine is a
// second system to get wrong.
//
// Permissions are `resource:action` verbs so authorization decisions are
// greppable. Scattered `if (role === 'admin')` checks are not.
export const PERMISSIONS = {
  admin: ['*'],
  manager: [
    'prospect:read:all',
    'prospect:write',
    'prospect:disqualify',
    'prospect:assign',
    'prospect:link',
    'activity:write',
    'merchant:read:all',
    'queue:claim',
    'experiment:write',
    'report:team',
    // A manager can bring on reps. The route caps WHICH roles they may create
    // — members only — because letting a manager mint an admin turns "runs the
    // sales team" into "can do anything" with nobody more privileged involved.
    'staff:invite',
  ],
  member: [
    'prospect:write',
    'activity:write',
  ],
} as const satisfies Record<StaffRole, readonly string[]>

/**
 * Permissions only an admin holds.
 *
 * Admin carries '*', so these appear in no role's list and would otherwise be
 * missing from the Permission union — which meant `can(role, 'staff:manage')`
 * failed to typecheck even though it is a real, checked permission. Naming
 * them here keeps the union honest and doubles as the list of what admin has
 * that nobody else does.
 */
export const ADMIN_ONLY = [
  'staff:manage',
  'rules:write',
  'spend:write',
  // Flips merchants.is_test_account, which excludes an account from the
  // company milestone and MRR — a metrics-integrity lever, not something a
  // rep or manager should be able to toggle on their own accounts.
  'merchant:mark-test',
] as const

export type Permission =
  | (typeof PERMISSIONS)['manager'][number]
  | (typeof PERMISSIONS)['member'][number]
  | (typeof ADMIN_ONLY)[number]

export function can(role: StaffRole, permission: Permission): boolean {
  const granted: readonly string[] = PERMISSIONS[role]
  return granted.includes('*') || granted.includes(permission)
}

export function isStaff(auth: ApiAuth | undefined): auth is Extract<ApiAuth, { kind: 'staff' }> {
  return auth?.kind === 'staff'
}

/**
 * preHandler enforcing a single permission.
 *
 * Assumes the staff guard has already run — it re-checks `kind === 'staff'`
 * anyway rather than trusting registration order, because the cost of being
 * wrong here is cross-tenant data exposure.
 */
export function requirePermission(permission: Permission) {
  return async (req: FastifyRequest, reply: FastifyReply) => {
    if (!isStaff(req.auth)) {
      return reply.status(401).send({ error: 'Unauthorized' })
    }
    if (!can(req.auth.role, permission)) {
      return reply.status(403).send({ error: 'Forbidden', required: permission })
    }
  }
}
