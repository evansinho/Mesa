import Fastify, { type FastifyInstance } from 'fastify'
import { eq } from 'drizzle-orm'
import { prospectActivities, prospects, staffAuditLog } from '@mesa/db'
import { registerAuthContext } from '../../src/auth-context'
import { registerStaffRoutes } from '../../src/staff'
import { getTestDb } from '@test-helpers/db'
import { setupIntegration } from '@test-helpers/integration-setup'
import { createStaff, createStaffSession, createProspect, createMerchant } from '@test-helpers/factories'

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

describe('Deleting a prospect', () => {
  it('lets a manager delete an unlinked prospect', async () => {
    const app = await buildApp()
    const db = getTestDb()
    const manager = await actor('manager')
    const p = await createProspect(db)

    const res = await app.inject({
      method: 'DELETE', url: `/staff/prospects/${p.id}`, headers: manager.headers,
    })

    expect(res.statusCode).toBe(204)
    expect(await db.query.prospects.findFirst({ where: eq(prospects.id, p.id) })).toBeUndefined()
  })

  it('takes its activities with it', async () => {
    const app = await buildApp()
    const db = getTestDb()
    const manager = await actor('manager')
    const p = await createProspect(db, { ownerId: manager.member.id })
    await db.insert(prospectActivities).values({
      prospectId: p.id, staffId: manager.member.id, type: 'call', body: 'Spoke to them',
    })

    await app.inject({ method: 'DELETE', url: `/staff/prospects/${p.id}`, headers: manager.headers })

    const left = await db.select().from(prospectActivities).where(eq(prospectActivities.prospectId, p.id))
    expect(left).toHaveLength(0)
  })

  it('refuses to delete a prospect linked to a merchant', async () => {
    const app = await buildApp()
    const db = getTestDb()
    const manager = await actor('manager')
    const m = await createMerchant(db)
    const p = await createProspect(db, { merchantId: m.id, matchStatus: 'auto' })

    const res = await app.inject({
      method: 'DELETE', url: `/staff/prospects/${p.id}`, headers: manager.headers,
    })

    // That row is a real merchant's attribution record. Deleting it destroys
    // where the customer came from and silently reopens their SIGNUP_UNOWNED
    // item, because the merchant becomes unowned again.
    expect(res.statusCode).toBe(409)
    expect(await db.query.prospects.findFirst({ where: eq(prospects.id, p.id) })).toBeTruthy()
  })

  it('refuses a member', async () => {
    const app = await buildApp()
    const db = getTestDb()
    const rep = await actor('member')
    const p = await createProspect(db, { ownerId: rep.member.id })

    const res = await app.inject({
      method: 'DELETE', url: `/staff/prospects/${p.id}`, headers: rep.headers,
    })

    // Deleting is destructive and unlogged from the rep's point of view;
    // disqualifying is the action available to them, and it keeps a reason.
    expect(res.statusCode).toBe(403)
  })

  it('leaves an audit entry naming what was removed', async () => {
    const app = await buildApp()
    const db = getTestDb()
    const admin = await actor('admin')
    const p = await createProspect(db, { businessName: 'Duplicate Ltd' })

    await app.inject({ method: 'DELETE', url: `/staff/prospects/${p.id}`, headers: admin.headers })

    const rows = await db.select().from(staffAuditLog).where(eq(staffAuditLog.action, 'prospect:delete'))
    expect(rows).toHaveLength(1)
    // The record goes; the fact that someone removed it does not.
    expect(rows[0].metadata).toMatchObject({ businessName: 'Duplicate Ltd' })
    expect(rows[0].staffId).toBe(admin.member.id)
  })

  it('404s for a prospect outside the caller’s scope', async () => {
    const app = await buildApp()
    const db = getTestDb()
    const manager = await actor('manager')
    const res = await app.inject({
      method: 'DELETE',
      url: '/staff/prospects/00000000-0000-0000-0000-000000000000',
      headers: manager.headers,
    })
    expect(res.statusCode).toBe(404)
  })
})
