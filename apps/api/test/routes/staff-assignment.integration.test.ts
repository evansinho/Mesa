import Fastify, { type FastifyInstance } from 'fastify'
import { eq } from 'drizzle-orm'
import { prospects, staff, staffNotifications } from '@mesa/db'
import { registerAuthContext } from '../../src/auth-context'
import { registerStaffRoutes } from '../../src/staff'
import { getTestDb } from '@test-helpers/db'
import { setupIntegration } from '@test-helpers/integration-setup'
import { createStaff, createStaffSession, createProspect } from '@test-helpers/factories'

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

describe('Assigning a prospect to someone', () => {
  it('lets a manager hand a prospect to a member', async () => {
    const app = await buildApp()
    const db = getTestDb()
    const manager = await actor('manager')
    const rep = await actor('member')
    const p = await createProspect(db, { ownerId: null })

    const res = await app.inject({
      method: 'PATCH', url: `/staff/prospects/${p.id}/owner`,
      headers: manager.headers, payload: { ownerId: rep.member.id },
    })

    expect(res.statusCode).toBe(200)
    expect(res.json().data.ownerId).toBe(rep.member.id)
  })

  it('lets an admin reassign from one rep to another', async () => {
    const app = await buildApp()
    const db = getTestDb()
    const admin = await actor('admin')
    const from = await actor('member')
    const to = await actor('member')
    const p = await createProspect(db, { ownerId: from.member.id })

    const res = await app.inject({
      method: 'PATCH', url: `/staff/prospects/${p.id}/owner`,
      headers: admin.headers, payload: { ownerId: to.member.id },
    })

    expect(res.statusCode).toBe(200)
    const row = await db.query.prospects.findFirst({ where: eq(prospects.id, p.id) })
    expect(row?.ownerId).toBe(to.member.id)
  })

  it('unassigns on an explicit null, returning it to the claimable pool', async () => {
    const app = await buildApp()
    const db = getTestDb()
    const manager = await actor('manager')
    const rep = await actor('member')
    const p = await createProspect(db, { ownerId: rep.member.id })

    const res = await app.inject({
      method: 'PATCH', url: `/staff/prospects/${p.id}/owner`,
      headers: manager.headers, payload: { ownerId: null },
    })

    expect(res.statusCode).toBe(200)
    expect(res.json().data.ownerId).toBeNull()
  })

  it('refuses a member trying to assign work to anyone', async () => {
    const app = await buildApp()
    const db = getTestDb()
    const rep = await actor('member')
    const other = await actor('member')
    const p = await createProspect(db, { ownerId: rep.member.id })

    const res = await app.inject({
      method: 'PATCH', url: `/staff/prospects/${p.id}/owner`,
      headers: rep.headers, payload: { ownerId: other.member.id },
    })

    // Deciding who works an account is a manager's call, even on your own.
    expect(res.statusCode).toBe(403)
    expect(res.json().required).toBe('prospect:assign')
  })

  it('refuses assignment to a deactivated staff member', async () => {
    const app = await buildApp()
    const db = getTestDb()
    const manager = await actor('manager')
    const gone = await actor('member')
    await db.update(staff).set({ active: false }).where(eq(staff.id, gone.member.id))
    const p = await createProspect(db, { ownerId: null })

    const res = await app.inject({
      method: 'PATCH', url: `/staff/prospects/${p.id}/owner`,
      headers: manager.headers, payload: { ownerId: gone.member.id },
    })

    // Otherwise the work is stranded: it looks owned so nobody claims it, and
    // the owner can never see the queue item.
    expect(res.statusCode).toBe(400)
  })

  it('refuses an unknown staff id', async () => {
    const app = await buildApp()
    const db = getTestDb()
    const manager = await actor('manager')
    const p = await createProspect(db, { ownerId: null })

    const res = await app.inject({
      method: 'PATCH', url: `/staff/prospects/${p.id}/owner`,
      headers: manager.headers,
      payload: { ownerId: '00000000-0000-0000-0000-000000000000' },
    })
    expect(res.statusCode).toBe(400)
  })

  it('distinguishes an omitted ownerId from an explicit null', async () => {
    const app = await buildApp()
    const db = getTestDb()
    const manager = await actor('manager')
    const rep = await actor('member')
    const p = await createProspect(db, { ownerId: rep.member.id })

    const res = await app.inject({
      method: 'PATCH', url: `/staff/prospects/${p.id}/owner`,
      headers: manager.headers, payload: {},
    })

    // Omitting the field is a malformed request, not "unassign".
    expect(res.statusCode).toBe(400)
    const row = await db.query.prospects.findFirst({ where: eq(prospects.id, p.id) })
    expect(row?.ownerId).toBe(rep.member.id)
  })

  it('records the handover in the audit log', async () => {
    const app = await buildApp()
    const db = getTestDb()
    const manager = await actor('manager')
    const rep = await actor('member')
    const p = await createProspect(db, { ownerId: null })

    await app.inject({
      method: 'PATCH', url: `/staff/prospects/${p.id}/owner`,
      headers: manager.headers, payload: { ownerId: rep.member.id },
    })

    const { staffAuditLog } = await import('@mesa/db')
    const rows = await db.select().from(staffAuditLog).where(eq(staffAuditLog.action, 'prospect:assign'))
    expect(rows).toHaveLength(1)
    expect(rows[0].staffId).toBe(manager.member.id)
    expect(rows[0].metadata).toMatchObject({ to: rep.member.id })
  })
})

describe('The work queue follows the new owner', () => {
  it('moves a stale-prospect item to the new owner and closes the old one', async () => {
    const { reconcileNotifications } = await import(
      '../../../worker/src/commercial/notifications'
    )
    const app = await buildApp()
    const db = getTestDb()
    const manager = await actor('manager')
    const from = await actor('member')
    const to = await actor('member')

    const p = await createProspect(db, {
      ownerId: from.member.id,
      stage: 'CONTACTED',
      createdAt: new Date(Date.now() - 10 * 86_400_000),
    })

    await reconcileNotifications(db)
    let open = await db
      .select()
      .from(staffNotifications)
      .where(eq(staffNotifications.kind, 'PROSPECT_STALE'))
    expect(open.filter((n) => n.resolvedAt === null).map((n) => n.staffId)).toEqual([from.member.id])

    await app.inject({
      method: 'PATCH', url: `/staff/prospects/${p.id}/owner`,
      headers: manager.headers, payload: { ownerId: to.member.id },
    })

    // Nothing moves the queue by hand. The reconciler recomputes each trigger's
    // desired set from prospects.owner_id, so the handover propagates on the
    // next sweep and the old owner's copy resolves itself.
    await reconcileNotifications(db)

    open = await db
      .select()
      .from(staffNotifications)
      .where(eq(staffNotifications.kind, 'PROSPECT_STALE'))
    expect(open.filter((n) => n.resolvedAt === null).map((n) => n.staffId)).toEqual([to.member.id])
    expect(open.find((n) => n.staffId === from.member.id)?.resolvedAt).not.toBeNull()
  })
})
