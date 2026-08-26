import Fastify, { type FastifyInstance } from 'fastify'
import { eq } from 'drizzle-orm'
import { config } from '@mesa/config'
import { staff, staffSessions } from '@mesa/db'
import { registerAuthContext } from '../../src/auth-context'
import { registerStaffRoutes } from '../../src/staff'
import { hashPassword } from '../../src/staff/password'
import { getTestDb } from '@test-helpers/db'
import { setupIntegration } from '@test-helpers/integration-setup'
import {
  createStaff,
  createStaffSession,
  createMerchant,
} from '@test-helpers/factories'
import { createHash, randomBytes } from 'crypto'
import { authSessions } from '@mesa/db'

setupIntegration()

// Mirrors production wiring: the global auth hook plus the staff plugin. Both
// have to be present, because the tenancy control lives in the hook and the
// deny-by-default guard lives in the plugin.
async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify({ logger: false })
  const db = getTestDb()
  app.decorate('db', db)
  registerAuthContext(app, db)
  await registerStaffRoutes(app, db)
  return app
}

const PASSWORD = 'correct-horse-battery-staple'

async function staffWithPassword(role: 'admin' | 'manager' | 'member' = 'member') {
  return createStaff(getTestDb(), {
    role,
    passwordHash: await hashPassword(PASSWORD),
  })
}

describe('Staff auth — tenancy boundary', () => {
  it('rejects a merchant session token on /staff/* (cross-tenant breach)', async () => {
    const app = await buildApp()
    const db = getTestDb()

    // A perfectly valid merchant session.
    const merchant = await createMerchant(db)
    const merchantToken = randomBytes(32).toString('hex')
    await db.insert(authSessions).values({
      merchantId: merchant.id,
      sessionHash: createHash('sha256').update(merchantToken).digest('hex'),
      expiresAt: new Date(Date.now() + 60 * 60 * 1000),
    })

    const res = await app.inject({
      method: 'GET',
      url: '/staff/prospects',
      headers: { authorization: `Bearer ${merchantToken}` },
    })

    // Must be 401, not 200 and not 403 — the merchant is not a staff member
    // and the commercial layer reads across every merchant.
    expect(res.statusCode).toBe(401)
  })

  it('rejects the internal service API key on /staff/*', async () => {
    const app = await buildApp()

    const res = await app.inject({
      method: 'GET',
      url: '/staff/prospects',
      headers: { 'x-mesa-api-key': config.INTERNAL_API_KEY },
    })

    // The shared service key carries no staff identity, so nothing could be
    // attributed in the audit log even if it were allowed through.
    expect(res.statusCode).toBe(401)
  })

  it('rejects an unauthenticated request on /staff/*', async () => {
    const app = await buildApp()
    const res = await app.inject({ method: 'GET', url: '/staff/prospects' })
    expect(res.statusCode).toBe(401)
  })

  it('accepts a valid staff session', async () => {
    const app = await buildApp()
    const member = await staffWithPassword()
    const token = await createStaffSession(getTestDb(), member.id)

    const res = await app.inject({
      method: 'GET',
      url: '/staff/prospects',
      headers: { authorization: `Bearer ${token}` },
    })

    expect(res.statusCode).toBe(200)
  })
})

describe('Staff login', () => {
  it('issues a session for correct credentials', async () => {
    const app = await buildApp()
    const member = await staffWithPassword('manager')

    const res = await app.inject({
      method: 'POST',
      url: '/staff/auth/login',
      payload: { email: member.email, password: PASSWORD },
    })

    expect(res.statusCode).toBe(200)
    const { data } = res.json()
    expect(data.token).toEqual(expect.any(String))
    expect(data.user.role).toBe('manager')

    // The token is stored hashed, never in plaintext.
    const stored = await getTestDb().query.staffSessions.findFirst({
      where: eq(staffSessions.sessionHash, createHash('sha256').update(data.token).digest('hex')),
    })
    expect(stored).toBeTruthy()
  })

  it('rejects a wrong password', async () => {
    const app = await buildApp()
    const member = await staffWithPassword()

    const res = await app.inject({
      method: 'POST',
      url: '/staff/auth/login',
      payload: { email: member.email, password: 'wrong-password-entirely' },
    })

    expect(res.statusCode).toBe(401)
  })

  it('gives the same response for an unknown email as for a wrong password', async () => {
    const app = await buildApp()

    const unknown = await app.inject({
      method: 'POST',
      url: '/staff/auth/login',
      payload: { email: 'nobody@example.com', password: PASSWORD },
    })

    expect(unknown.statusCode).toBe(401)
    expect(unknown.json()).toEqual({ error: 'Invalid credentials' })
  })

  it('refuses a deactivated staff member even with the right password', async () => {
    const app = await buildApp()
    const member = await staffWithPassword()
    await getTestDb().update(staff).set({ active: false }).where(eq(staff.id, member.id))

    const res = await app.inject({
      method: 'POST',
      url: '/staff/auth/login',
      payload: { email: member.email, password: PASSWORD },
    })

    expect(res.statusCode).toBe(401)
  })

  it('invalidates an existing session as soon as the member is deactivated', async () => {
    const app = await buildApp()
    const member = await staffWithPassword()
    const token = await createStaffSession(getTestDb(), member.id)

    // Session works...
    const before = await app.inject({
      method: 'GET',
      url: '/staff/auth/me',
      headers: { authorization: `Bearer ${token}` },
    })
    expect(before.statusCode).toBe(200)

    // ...and stops the moment the row is deactivated, without waiting for the
    // token to expire. Role and active are read per-request for this reason.
    await getTestDb().update(staff).set({ active: false }).where(eq(staff.id, member.id))

    const after = await app.inject({
      method: 'GET',
      url: '/staff/auth/me',
      headers: { authorization: `Bearer ${token}` },
    })
    expect(after.statusCode).toBe(401)
  })

  it('reflects a role change on the very next request', async () => {
    const app = await buildApp()
    const member = await staffWithPassword('member')
    const token = await createStaffSession(getTestDb(), member.id)

    await getTestDb().update(staff).set({ role: 'manager' }).where(eq(staff.id, member.id))

    const res = await app.inject({
      method: 'GET',
      url: '/staff/auth/me',
      headers: { authorization: `Bearer ${token}` },
    })
    expect(res.json().data.role).toBe('manager')
  })
})
