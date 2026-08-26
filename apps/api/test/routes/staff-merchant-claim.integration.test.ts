import Fastify, { type FastifyInstance } from 'fastify'
import { eq } from 'drizzle-orm'
import { prospects, staff, staffNotifications } from '@mesa/db'
import { registerAuthContext } from '../../src/auth-context'
import { registerStaffRoutes } from '../../src/staff'
import { getTestDb } from '@test-helpers/db'
import { setupIntegration } from '@test-helpers/integration-setup'
import { createStaff, createStaffSession, createMerchant, createProspect } from '@test-helpers/factories'

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

/**
 * Every merchant that signed up self-serve has no prospect row, because a
 * prospect is what a rep creates when they SOURCE someone. In production that
 * was all 12 of them, against 14 open SIGNUP_UNOWNED items telling people to
 * "Claim" — with nothing to claim.
 */
describe('Claiming a merchant that arrived without a prospect', () => {
  it('creates the missing attribution record and assigns it', async () => {
    const app = await buildApp()
    const db = getTestDb()
    const rep = await actor('member')
    const m = await createMerchant(db, { name: 'Jasho Homes' })

    const res = await app.inject({
      method: 'POST', url: `/staff/merchants/${m.id}/claim`, headers: rep.headers,
    })

    expect(res.statusCode).toBe(200)
    const p = await db.query.prospects.findFirst({ where: eq(prospects.merchantId, m.id) })
    expect(p).toBeTruthy()
    expect(p?.ownerId).toBe(rep.member.id)
    expect(p?.businessName).toBe('Jasho Homes')
  })

  it('records it as organic, not as the claimer’s outbound win', async () => {
    const app = await buildApp()
    const db = getTestDb()
    const rep = await actor('member')
    const m = await createMerchant(db)

    await app.inject({ method: 'POST', url: `/staff/merchants/${m.id}/claim`, headers: rep.headers })

    const p = await db.query.prospects.findFirst({ where: eq(prospects.merchantId, m.id) })
    // Claiming an account is not the same as having sourced it. Recording this
    // as outbound would quietly corrupt every channel report.
    expect(p?.source).toBe('organic')
    // And a human made the link, not the phone-matching sweep — the
    // distinction is what makes the auto-match rate meaningful.
    expect(p?.matchStatus).toBe('manual')
  })

  it('reuses an existing prospect instead of creating a second one', async () => {
    const app = await buildApp()
    const db = getTestDb()
    const manager = await actor('manager')
    const rep = await actor('member')
    const m = await createMerchant(db)
    await createProspect(db, { merchantId: m.id, ownerId: null, source: 'instagram' })

    await app.inject({
      method: 'PATCH', url: `/staff/merchants/${m.id}/owner`,
      headers: manager.headers, payload: { ownerId: rep.member.id },
    })

    const all = await db.select().from(prospects).where(eq(prospects.merchantId, m.id))
    expect(all).toHaveLength(1)
    expect(all[0].ownerId).toBe(rep.member.id)
    // The real attribution must survive being reassigned.
    expect(all[0].source).toBe('instagram')
  })

  it('lets a manager assign a merchant to someone else', async () => {
    const app = await buildApp()
    const db = getTestDb()
    const manager = await actor('manager')
    const rep = await actor('member')
    const m = await createMerchant(db)

    const res = await app.inject({
      method: 'PATCH', url: `/staff/merchants/${m.id}/owner`,
      headers: manager.headers, payload: { ownerId: rep.member.id },
    })

    expect(res.statusCode).toBe(200)
    const p = await db.query.prospects.findFirst({ where: eq(prospects.merchantId, m.id) })
    expect(p?.ownerId).toBe(rep.member.id)
  })

  it('refuses a member assigning to someone else', async () => {
    const app = await buildApp()
    const db = getTestDb()
    const rep = await actor('member')
    const other = await actor('member')
    const m = await createMerchant(db)

    const res = await app.inject({
      method: 'PATCH', url: `/staff/merchants/${m.id}/owner`,
      headers: rep.headers, payload: { ownerId: other.member.id },
    })
    expect(res.statusCode).toBe(403)
  })

  it('refuses assignment to a deactivated staff member', async () => {
    const app = await buildApp()
    const db = getTestDb()
    const manager = await actor('manager')
    const gone = await actor('member')
    await db.update(staff).set({ active: false }).where(eq(staff.id, gone.member.id))
    const m = await createMerchant(db)

    const res = await app.inject({
      method: 'PATCH', url: `/staff/merchants/${m.id}/owner`,
      headers: manager.headers, payload: { ownerId: gone.member.id },
    })
    expect(res.statusCode).toBe(400)
  })
})

describe('The unresolvable queue item becomes resolvable', () => {
  it('closes SIGNUP_UNOWNED once the merchant is claimed', async () => {
    const { reconcileNotifications } = await import(
      '../../../worker/src/commercial/notifications'
    )
    const app = await buildApp()
    const db = getTestDb()
    const admin = await actor('admin')
    const m = await createMerchant(db)

    await reconcileNotifications(db)
    let open = (await db.select().from(staffNotifications)
      .where(eq(staffNotifications.kind, 'SIGNUP_UNOWNED')))
      .filter((n) => n.resolvedAt === null)
    expect(open.length).toBeGreaterThan(0)

    await app.inject({ method: 'POST', url: `/staff/merchants/${m.id}/claim`, headers: admin.headers })

    // Before this endpoint existed the item could never resolve: it told you to
    // claim, and ownership lived on a prospect row that did not exist.
    await reconcileNotifications(db)
    open = (await db.select().from(staffNotifications)
      .where(eq(staffNotifications.kind, 'SIGNUP_UNOWNED')))
      .filter((n) => n.resolvedAt === null)
    expect(open).toHaveLength(0)
  })
})
