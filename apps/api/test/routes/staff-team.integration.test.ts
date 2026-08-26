import Fastify, { type FastifyInstance } from 'fastify'
import { eq } from 'drizzle-orm'
import { staff } from '@mesa/db'
import { registerAuthContext } from '../../src/auth-context'
import { registerStaffRoutes } from '../../src/staff'
import { getTestDb } from '@test-helpers/db'
import { setupIntegration } from '@test-helpers/integration-setup'
import { createStaff, createStaffSession } from '@test-helpers/factories'

setupIntegration()

async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify({ logger: false })
  const db = getTestDb()
  app.decorate('db', db)
  registerAuthContext(app, db)
  await registerStaffRoutes(app, db)
  return app
}

async function actor(role: 'admin' | 'manager' | 'member') {
  const db = getTestDb()
  const member = await createStaff(db, { role })
  const token = await createStaffSession(db, member.id)
  return { member, headers: { authorization: `Bearer ${token}` } }
}

const invite = (role: string, email = `x${Math.random()}@mesa.co`) => ({
  name: 'New Person', email, role,
})

describe('Inviting staff — who may create whom', () => {
  it('lets an admin invite any role', async () => {
    const app = await buildApp()
    const admin = await actor('admin')

    for (const role of ['admin', 'manager', 'member']) {
      const res = await app.inject({
        method: 'POST', url: '/staff/team', headers: admin.headers,
        payload: invite(role, `${role}@mesa.co`),
      })
      expect(res.statusCode).toBe(201)
      expect(res.json().data.role).toBe(role)
    }
  })

  it('lets a manager invite a member', async () => {
    const app = await buildApp()
    const manager = await actor('manager')

    const res = await app.inject({
      method: 'POST', url: '/staff/team', headers: manager.headers,
      payload: invite('member', 'rep@mesa.co'),
    })

    expect(res.statusCode).toBe(201)
    expect(res.json().data.tempPassword).toEqual(expect.any(String))
  })

  it.each(['admin', 'manager'])('refuses a manager inviting a %s', async (role) => {
    const app = await buildApp()
    const manager = await actor('manager')

    const res = await app.inject({
      method: 'POST', url: '/staff/team', headers: manager.headers,
      payload: invite(role, `${role}-escalation@mesa.co`),
    })

    // Lateral privilege escalation: a manager minting an admin turns "runs the
    // sales team" into "can do anything", with nobody more privileged involved.
    expect(res.statusCode).toBe(403)
  })

  it('refuses a member inviting anyone', async () => {
    const app = await buildApp()
    const rep = await actor('member')

    const res = await app.inject({
      method: 'POST', url: '/staff/team', headers: rep.headers,
      payload: invite('member'),
    })

    expect(res.statusCode).toBe(403)
    expect(res.json().required).toBe('staff:invite')
  })

  it('refuses a duplicate email rather than silently shadowing an account', async () => {
    const app = await buildApp()
    const admin = await actor('admin')
    await createStaff(getTestDb(), { email: 'taken@mesa.co' })

    const res = await app.inject({
      method: 'POST', url: '/staff/team', headers: admin.headers,
      payload: invite('member', 'taken@mesa.co'),
    })
    expect(res.statusCode).toBe(409)
  })
})

describe('The invited account works', () => {
  it('can sign in with the temporary password and is forced to change it', async () => {
    const app = await buildApp()
    const admin = await actor('admin')

    const created = await app.inject({
      method: 'POST', url: '/staff/team', headers: admin.headers,
      payload: invite('member', 'newrep@mesa.co'),
    })
    const { tempPassword } = created.json().data

    const login = await app.inject({
      method: 'POST', url: '/staff/auth/login',
      payload: { email: 'newrep@mesa.co', password: tempPassword },
    })

    expect(login.statusCode).toBe(200)
    // The printed password must never become the long-lived credential.
    expect(login.json().data.user.mustResetPassword).toBe(true)
  })
})

describe('Role and status changes', () => {
  it('revokes every session the moment an account is deactivated', async () => {
    const app = await buildApp()
    const db = getTestDb()
    const admin = await actor('admin')
    const rep = await actor('member')

    const before = await app.inject({ method: 'GET', url: '/staff/queue', headers: rep.headers })
    expect(before.statusCode).toBe(200)

    await app.inject({
      method: 'PATCH', url: `/staff/team/${rep.member.id}`, headers: admin.headers,
      payload: { active: false },
    })

    // Not at token expiry. A deactivated rep is carrying every merchant's
    // phone number until their session actually dies.
    const after = await app.inject({ method: 'GET', url: '/staff/queue', headers: rep.headers })
    expect(after.statusCode).toBe(401)

    const row = await db.query.staff.findFirst({ where: eq(staff.id, rep.member.id) })
    expect(row?.active).toBe(false)
  })

  it('refuses to let anyone deactivate themselves', async () => {
    const app = await buildApp()
    const admin = await actor('admin')

    const res = await app.inject({
      method: 'PATCH', url: `/staff/team/${admin.member.id}`, headers: admin.headers,
      payload: { active: false },
    })

    // Always a mistake, never an intention.
    expect(res.statusCode).toBe(400)
  })

  it('refuses to let a manager change roles', async () => {
    const app = await buildApp()
    const manager = await actor('manager')
    const rep = await actor('member')

    const res = await app.inject({
      method: 'PATCH', url: `/staff/team/${rep.member.id}`, headers: manager.headers,
      payload: { role: 'manager' },
    })
    expect(res.statusCode).toBe(403)
  })

  it('refuses to let a manager deactivate a peer', async () => {
    const app = await buildApp()
    const manager = await actor('manager')
    const other = await actor('manager')

    const res = await app.inject({
      method: 'PATCH', url: `/staff/team/${other.member.id}`, headers: manager.headers,
      payload: { active: false },
    })
    expect(res.statusCode).toBe(403)
  })

  it('revokes sessions on a role change so a demotion takes effect at once', async () => {
    const app = await buildApp()
    const admin = await actor('admin')
    const manager = await actor('manager')

    await app.inject({
      method: 'PATCH', url: `/staff/team/${manager.member.id}`, headers: admin.headers,
      payload: { role: 'member' },
    })

    const after = await app.inject({ method: 'GET', url: '/staff/queue', headers: manager.headers })
    expect(after.statusCode).toBe(401)
  })
})

describe('Password reset', () => {
  it('issues a new temporary password and kills the old sessions', async () => {
    const app = await buildApp()
    const admin = await actor('admin')
    const rep = await actor('member')

    const res = await app.inject({
      method: 'POST', url: `/staff/team/${rep.member.id}/reset-password`, headers: admin.headers,
    })

    expect(res.statusCode).toBe(200)
    expect(res.json().data.tempPassword).toEqual(expect.any(String))

    const after = await app.inject({ method: 'GET', url: '/staff/queue', headers: rep.headers })
    expect(after.statusCode).toBe(401)
  })
})

describe('Team listing', () => {
  it('tells the caller which roles they may create', async () => {
    const app = await buildApp()
    const manager = await actor('manager')

    const res = await app.inject({ method: 'GET', url: '/staff/team', headers: manager.headers })

    // The UI reads this so it never offers an action the server will refuse.
    expect(res.json().meta.canCreate).toEqual(['member'])
    expect(res.json().meta.canChangeRole).toBe(false)
  })

  it('is not visible to a member', async () => {
    const app = await buildApp()
    const rep = await actor('member')

    const res = await app.inject({ method: 'GET', url: '/staff/team', headers: rep.headers })
    expect(res.statusCode).toBe(403)
  })
})
