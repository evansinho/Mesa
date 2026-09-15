import Fastify, { type FastifyInstance } from 'fastify'
import { eq } from 'drizzle-orm'
import { merchants, subscriptions } from '@mesa/db'
import { registerAuthContext } from '../../src/auth-context'
import { registerStaffRoutes } from '../../src/staff'
import { getTestDb } from '@test-helpers/db'
import { setupIntegration } from '@test-helpers/integration-setup'
import { createStaff, createStaffSession, createMerchant } from '@test-helpers/factories'

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

async function attachRealSubscription(merchantId: string) {
  const db = getTestDb()
  await db.insert(subscriptions).values({
    merchantId,
    plan: 'starter',
    status: 'active',
    paystackCustomerCode: 'CUS_test123',
    paystackSubscriptionCode: 'SUB_test123',
    paystackPlanCode: 'PLN_test123',
    amountKobo: 1_200_000,
    currentPeriodStart: new Date(),
    currentPeriodEnd: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
  })
}

describe('Staff revenue metrics only count verified payers, not manually-flipped or test accounts', () => {
  it('a merchant with subscription_status=active but no real Paystack subscription contributes ₦0 MRR', async () => {
    const app = await buildApp()
    const db = getTestDb()
    const admin = await actor('admin')
    // Exactly the shape a manual support/testing DB edit produces — status
    // flipped directly, no subscriptions row behind it.
    await createMerchant(db, { subscriptionStatus: 'active', subscriptionTier: 'starter' })

    const res = await app.inject({ method: 'GET', url: '/staff/merchants', headers: admin.headers })
    expect(res.statusCode).toBe(200)
    const { data } = res.json() as { data: Array<{ mrr: number }> }
    expect(data).toHaveLength(1)
    expect(data[0].mrr).toBe(0)
  })

  it('a merchant with subscription_status=active AND a real Paystack subscription contributes its tier MRR', async () => {
    const app = await buildApp()
    const db = getTestDb()
    const admin = await actor('admin')
    const m = await createMerchant(db, { subscriptionStatus: 'active', subscriptionTier: 'starter' })
    await attachRealSubscription(m.id)

    const res = await app.inject({ method: 'GET', url: '/staff/merchants', headers: admin.headers })
    const { data } = res.json() as { data: Array<{ mrr: number }> }
    expect(data[0].mrr).toBe(12_000)
  })

  it('a real Paystack-backed subscription still contributes ₦0 MRR once flagged as a test account', async () => {
    const app = await buildApp()
    const db = getTestDb()
    const admin = await actor('admin')
    const m = await createMerchant(db, { subscriptionStatus: 'active', subscriptionTier: 'business', isTestAccount: true })
    await attachRealSubscription(m.id)

    const res = await app.inject({ method: 'GET', url: '/staff/merchants', headers: admin.headers })
    const { data } = res.json() as { data: Array<{ mrr: number }> }
    expect(data[0].mrr).toBe(0)
  })

  it('the "on Mesa" milestone excludes test accounts', async () => {
    const app = await buildApp()
    const db = getTestDb()
    const admin = await actor('admin')
    await createMerchant(db)
    await createMerchant(db)
    await createMerchant(db, { isTestAccount: true })

    const res = await app.inject({ method: 'GET', url: '/staff/dashboard', headers: admin.headers })
    expect(res.statusCode).toBe(200)
    const body = res.json() as { data: { milestone: { actual: number } } }
    expect(body.data.milestone.actual).toBe(2)
  })
})

describe('PATCH /staff/merchants/:id/test-account', () => {
  it('is admin-only — a manager is forbidden', async () => {
    const app = await buildApp()
    const db = getTestDb()
    const manager = await actor('manager')
    const m = await createMerchant(db)

    const res = await app.inject({
      method: 'PATCH',
      url: `/staff/merchants/${m.id}/test-account`,
      headers: manager.headers,
      payload: { isTestAccount: true },
    })
    expect(res.statusCode).toBe(403)
  })

  it('lets an admin flag and unflag a merchant, persisting the change', async () => {
    const app = await buildApp()
    const db = getTestDb()
    const admin = await actor('admin')
    const m = await createMerchant(db)

    const flagged = await app.inject({
      method: 'PATCH',
      url: `/staff/merchants/${m.id}/test-account`,
      headers: admin.headers,
      payload: { isTestAccount: true },
    })
    expect(flagged.statusCode).toBe(200)
    let refreshed = await db.query.merchants.findFirst({ where: eq(merchants.id, m.id) })
    expect(refreshed?.isTestAccount).toBe(true)

    const unflagged = await app.inject({
      method: 'PATCH',
      url: `/staff/merchants/${m.id}/test-account`,
      headers: admin.headers,
      payload: { isTestAccount: false },
    })
    expect(unflagged.statusCode).toBe(200)
    refreshed = await db.query.merchants.findFirst({ where: eq(merchants.id, m.id) })
    expect(refreshed?.isTestAccount).toBe(false)
  })

  it('rejects a missing or non-boolean isTestAccount', async () => {
    const app = await buildApp()
    const db = getTestDb()
    const admin = await actor('admin')
    const m = await createMerchant(db)

    const res = await app.inject({
      method: 'PATCH',
      url: `/staff/merchants/${m.id}/test-account`,
      headers: admin.headers,
      payload: {},
    })
    expect(res.statusCode).toBe(400)
  })
})
