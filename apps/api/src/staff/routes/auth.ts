import type { FastifyInstance } from 'fastify'
import { eq } from 'drizzle-orm'
import { staff, staffSessions, type Db } from '@mesa/db'
import { verifyPassword, hashPassword } from '../password'
import { createStaffSession, hashSessionToken, revokeAllStaffSessions } from '../sessions'
import { isStaff } from '../permissions'
import { audit } from '../audit'

interface LoginBody {
  email?: string
  password?: string
}

interface ChangePasswordBody {
  currentPassword?: string
  newPassword?: string
}

const MIN_PASSWORD_LENGTH = 12

// A real Argon2id hash of a discarded random value. Verifying against it costs
// the same as verifying a genuine one, so an unknown email takes as long as a
// wrong password and response time stops being an account-existence oracle.
// Must stay a valid PHC string — a malformed one fails fast and defeats the
// entire point.
const DUMMY_HASH =
  '$argon2id$v=19$m=19456,t=2,p=1$UXjZ30/1XiX5DhueZy2LZA$yNQjZqCZFSeOURuKoDVf2qU1Rev6it+aRziTrf7Z800'

export async function staffAuthRoutes(app: FastifyInstance, db: Db): Promise<void> {
  // POST /staff/auth/login — the only unauthenticated staff route.
  app.post<{ Body: LoginBody }>('/login', async (req, reply) => {
    const email = req.body?.email?.trim().toLowerCase()
    const password = req.body?.password

    if (!email || !password) {
      return reply.status(400).send({ error: 'email and password required' })
    }

    const member = await db.query.staff.findFirst({ where: eq(staff.email, email) })

    // Always run a verify, even when the account doesn't exist, so response
    // time doesn't distinguish "no such user" from "wrong password". Same
    // reason the error text below is identical for both.
    const stored = member?.passwordHash ?? DUMMY_HASH
    const ok = await verifyPassword(password, stored)

    if (!member || !ok || !member.active) {
      return reply.status(401).send({ error: 'Invalid credentials' })
    }

    const { token, expiresAt } = await createStaffSession(db, member.id)
    await db.update(staff).set({ lastLoginAt: new Date() }).where(eq(staff.id, member.id))

    return reply.send({
      data: {
        token,
        expiresAt: expiresAt.toISOString(),
        user: {
          id: member.id,
          name: member.name,
          email: member.email,
          role: member.role,
          mustResetPassword: member.mustResetPassword,
        },
      },
    })
  })
}

export async function staffAuthedAuthRoutes(app: FastifyInstance, db: Db): Promise<void> {
  // GET /staff/auth/me
  app.get('/me', async (req, reply) => {
    if (!isStaff(req.auth)) return reply.status(401).send({ error: 'Unauthorized' })

    const member = await db.query.staff.findFirst({ where: eq(staff.id, req.auth.staffId) })
    if (!member) return reply.status(401).send({ error: 'Unauthorized' })

    return reply.send({
      data: {
        id: member.id,
        name: member.name,
        email: member.email,
        role: member.role,
        refCode: member.refCode,
        mustResetPassword: member.mustResetPassword,
      },
    })
  })

  // POST /staff/auth/logout
  app.post('/logout', async (req, reply) => {
    if (!isStaff(req.auth)) return reply.status(401).send({ error: 'Unauthorized' })

    const header = req.headers.authorization
    if (header?.startsWith('Bearer ')) {
      await db
        .delete(staffSessions)
        .where(eq(staffSessions.sessionHash, hashSessionToken(header.slice(7))))
    }
    return reply.send({ data: { ok: true } })
  })

  // POST /staff/auth/change-password
  app.post<{ Body: ChangePasswordBody }>('/change-password', async (req, reply) => {
    if (!isStaff(req.auth)) return reply.status(401).send({ error: 'Unauthorized' })

    const { currentPassword, newPassword } = req.body ?? {}
    if (!currentPassword || !newPassword) {
      return reply.status(400).send({ error: 'currentPassword and newPassword required' })
    }
    if (newPassword.length < MIN_PASSWORD_LENGTH) {
      return reply
        .status(400)
        .send({ error: `newPassword must be at least ${MIN_PASSWORD_LENGTH} characters` })
    }

    const member = await db.query.staff.findFirst({ where: eq(staff.id, req.auth.staffId) })
    if (!member || !(await verifyPassword(currentPassword, member.passwordHash))) {
      return reply.status(401).send({ error: 'Invalid credentials' })
    }

    await db
      .update(staff)
      .set({
        passwordHash: await hashPassword(newPassword),
        mustResetPassword: false,
        updatedAt: new Date(),
      })
      .where(eq(staff.id, member.id))

    // Every other session dies with the old password. The one making this
    // request is recreated below so the user isn't bounced to the login screen
    // immediately after a successful change.
    await revokeAllStaffSessions(db, member.id)
    const { token, expiresAt } = await createStaffSession(db, member.id)

    await audit(db, req.auth, 'staff:change-password', { type: 'staff', id: member.id })

    return reply.send({ data: { token, expiresAt: expiresAt.toISOString() } })
  })
}
