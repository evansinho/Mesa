import type { FastifyInstance } from 'fastify'
import { randomBytes } from 'crypto'
import { eq, sql } from 'drizzle-orm'
import { staff, type Db } from '@mesa/db'
import { isStaff, can, requirePermission } from '../permissions'
import { hashPassword } from '../password'
import { revokeAllStaffSessions } from '../sessions'
import { audit } from '../audit'

type Role = 'admin' | 'manager' | 'member'
const ROLES: Role[] = ['admin', 'manager', 'member']

/**
 * Which roles each role may create.
 *
 * A manager can bring on reps — that is the point of the request — but not
 * another admin or another manager. Letting a manager mint an admin is lateral
 * privilege escalation: it converts "can run the sales team" into "can do
 * anything", and it does it without anyone with the higher privilege being
 * involved.
 */
const MAY_CREATE: Record<Role, Role[]> = {
  admin: ['admin', 'manager', 'member'],
  manager: ['member'],
  member: [],
}

const MIN_PASSWORD_LENGTH = 12

export async function teamRoutes(app: FastifyInstance, db: Db): Promise<void> {
  // GET /staff/team
  app.get('/', { preHandler: requirePermission('report:team') }, async (req, reply) => {
    if (!isStaff(req.auth)) return reply.status(401).send({ error: 'Unauthorized' })

    const rows = await db.execute<
      {
        id: string
        name: string
        email: string
        role: Role
        active: boolean
        must_reset_password: boolean
        ref_code: string | null
        last_login_at: Date | null
        on_mesa: number
        pipeline: number
      } & Record<string, unknown>
    >(sql`
      SELECT s.id, s.name, s.email, s.role::text AS role, s.active,
             s.must_reset_password, s.ref_code, s.last_login_at,
             count(p.merchant_id)::int AS on_mesa,
             count(*) FILTER (
               WHERE p.merchant_id IS NULL
                 AND p.stage IN ('SOURCED', 'CONTACTED', 'DEMOED')
             )::int AS pipeline
      FROM staff s
      LEFT JOIN prospects p ON p.owner_id = s.id
      GROUP BY s.id
      ORDER BY s.active DESC, s.created_at ASC
    `)

    return reply.send({
      data: (rows.rows ?? []).map((r) => ({
        id: r.id,
        name: r.name,
        email: r.email,
        role: r.role,
        active: r.active,
        mustResetPassword: r.must_reset_password,
        refCode: r.ref_code,
        lastLoginAt: r.last_login_at,
        onMesa: Number(r.on_mesa),
        pipeline: Number(r.pipeline),
      })),
      meta: {
        // What the caller is allowed to do, so the UI never offers an action
        // the server will refuse.
        canCreate: MAY_CREATE[req.auth.role],
        canChangeRole: can(req.auth.role, 'staff:manage'),
      },
    })
  })

  // POST /staff/team — invite a colleague.
  //
  // Creates the account and returns a temporary password ONCE. There is no
  // email delivery here yet, so whoever invites has to hand the password over
  // themselves; `mustResetPassword` makes sure it is replaced on first login
  // and never becomes the long-lived credential.
  app.post<{ Body: { name?: string; email?: string; role?: string; refCode?: string } }>(
    '/',
    { preHandler: requirePermission('staff:invite') },
    async (req, reply) => {
      if (!isStaff(req.auth)) return reply.status(401).send({ error: 'Unauthorized' })

      const name = req.body?.name?.trim()
      const email = req.body?.email?.trim().toLowerCase()
      const role = (req.body?.role ?? 'member') as Role

      if (!name) return reply.status(400).send({ error: 'name required' })
      if (!email || !email.includes('@')) return reply.status(400).send({ error: 'a valid email is required' })
      if (!ROLES.includes(role)) {
        return reply.status(400).send({ error: `role must be one of: ${ROLES.join(', ')}` })
      }

      const allowed = MAY_CREATE[req.auth.role]
      if (!allowed.includes(role)) {
        return reply.status(403).send({
          error: `A ${req.auth.role} can only invite: ${allowed.join(', ') || 'nobody'}`,
        })
      }

      const existing = await db.query.staff.findFirst({ where: eq(staff.email, email) })
      if (existing) return reply.status(409).send({ error: 'Someone already has that email' })

      const refCode = req.body?.refCode?.trim().toUpperCase() || null
      if (refCode) {
        const taken = await db.query.staff.findFirst({ where: eq(staff.refCode, refCode) })
        if (taken) return reply.status(409).send({ error: 'That ref code is taken' })
      }

      // 18 bytes → 24 base64url characters, comfortably past the 12-character
      // minimum the change-password route enforces.
      const tempPassword = randomBytes(18).toString('base64url')

      const [created] = await db
        .insert(staff)
        .values({
          name,
          email,
          passwordHash: await hashPassword(tempPassword),
          role,
          mustResetPassword: true,
          refCode,
        })
        .returning()

      await audit(db, req.auth, 'staff:invite', { type: 'staff', id: created.id }, { role })

      return reply.status(201).send({
        data: {
          id: created.id,
          name: created.name,
          email: created.email,
          role: created.role,
          refCode: created.refCode,
          // Shown once. Not stored anywhere in plaintext and not recoverable.
          tempPassword,
        },
      })
    },
  )

  // PATCH /staff/team/:id — change role, or activate/deactivate.
  app.patch<{ Params: { id: string }; Body: { role?: string; active?: boolean } }>(
    '/:id',
    { preHandler: requirePermission('staff:invite') },
    async (req, reply) => {
      if (!isStaff(req.auth)) return reply.status(401).send({ error: 'Unauthorized' })

      const target = await db.query.staff.findFirst({ where: eq(staff.id, req.params.id) })
      if (!target) return reply.status(404).send({ error: 'Not found' })

      // Locking yourself out is always a mistake, never an intention.
      if (target.id === req.auth.staffId && req.body?.active === false) {
        return reply.status(400).send({ error: 'You cannot deactivate your own account' })
      }

      const wantsRoleChange = req.body?.role !== undefined && req.body.role !== target.role
      if (wantsRoleChange) {
        if (!can(req.auth.role, 'staff:manage')) {
          return reply.status(403).send({ error: 'Only an admin can change roles' })
        }
        if (!ROLES.includes(req.body!.role as Role)) {
          return reply.status(400).send({ error: `role must be one of: ${ROLES.join(', ')}` })
        }
        if (target.id === req.auth.staffId) {
          return reply.status(400).send({ error: 'You cannot change your own role' })
        }
      }

      // A manager may deactivate reps, not peers or admins.
      if (req.body?.active !== undefined && !can(req.auth.role, 'staff:manage')) {
        if (target.role !== 'member') {
          return reply.status(403).send({ error: 'A manager can only deactivate members' })
        }
      }

      const [updated] = await db
        .update(staff)
        .set({
          ...(wantsRoleChange ? { role: req.body!.role as Role } : {}),
          ...(req.body?.active !== undefined ? { active: req.body.active } : {}),
          updatedAt: new Date(),
        })
        .where(eq(staff.id, target.id))
        .returning()

      // Both a demotion and a deactivation have to take effect NOW, not at
      // token expiry. Role is read per-request so a demotion is already live,
      // but dropping the sessions makes it unambiguous and is the only thing
      // that actually locks out a deactivated account.
      if (wantsRoleChange || req.body?.active === false) {
        await revokeAllStaffSessions(db, target.id)
      }

      await audit(db, req.auth, 'staff:update', { type: 'staff', id: target.id }, {
        role: req.body?.role,
        active: req.body?.active,
      })

      return reply.send({
        data: { id: updated.id, name: updated.name, role: updated.role, active: updated.active },
      })
    },
  )

  // POST /staff/team/:id/reset-password — issue a fresh temporary password.
  app.post<{ Params: { id: string } }>(
    '/:id/reset-password',
    { preHandler: requirePermission('staff:invite') },
    async (req, reply) => {
      if (!isStaff(req.auth)) return reply.status(401).send({ error: 'Unauthorized' })

      const target = await db.query.staff.findFirst({ where: eq(staff.id, req.params.id) })
      if (!target) return reply.status(404).send({ error: 'Not found' })

      if (!can(req.auth.role, 'staff:manage') && target.role !== 'member') {
        return reply.status(403).send({ error: 'A manager can only reset a member’s password' })
      }

      const tempPassword = randomBytes(18).toString('base64url')
      await db
        .update(staff)
        .set({
          passwordHash: await hashPassword(tempPassword),
          mustResetPassword: true,
          updatedAt: new Date(),
        })
        .where(eq(staff.id, target.id))

      // Every existing session dies with the old password.
      await revokeAllStaffSessions(db, target.id)

      await audit(db, req.auth, 'staff:reset-password', { type: 'staff', id: target.id })

      return reply.send({ data: { tempPassword } })
    },
  )
}

export { MIN_PASSWORD_LENGTH }
