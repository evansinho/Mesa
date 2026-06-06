import { createHmac } from 'crypto'
import Fastify, { type FastifyInstance } from 'fastify'
import { eq } from 'drizzle-orm'
import { billingEvents, merchants, subscriptions } from '@mesa/db'
import { registerAuthContext } from '../../src/auth-context'
import { webhookRoutes } from '../../src/routes/webhooks'
import { getTestDb } from '@test-helpers/db'
import { setupIntegration } from '@test-helpers/integration-setup'
import { createMerchant } from '@test-helpers/factories'

jest.mock('@mesa/whatsapp', () => ({
  sendText: jest.fn(),
}))

setupIntegration()

const apps: FastifyInstance[] = []

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()))
})

async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify({ logger: false })
  const db = getTestDb()
  app.decorate('db', db)
  registerAuthContext(app, db)
  await app.register(webhookRoutes, { prefix: '/webhooks' })
  apps.push(app)
  return app
}

function sign(rawBody: string): string {
  return createHmac('sha512', 'test-paystack').update(rawBody).digest('hex')
}

describe('Paystack webhook route', () => {
  it('rejects requests with invalid signatures', async () => {
    const app = await buildApp()

    const res = await app.inject({
      method: 'POST',
      url: '/webhooks/paystack',
      headers: {
        'content-type': 'application/json',
        'x-paystack-signature': 'bad-signature',
      },
      payload: JSON.stringify({ event: 'charge.success', data: {} }),
    })

    expect(res.statusCode).toBe(400)
  })

  it('activates a merchant subscription on charge success and ignores duplicate delivery', async () => {
    const app = await buildApp()
    const db = getTestDb()
    const merchant = await createMerchant(db, {
      email: 'owner@example.com',
      subscriptionStatus: 'trialing',
      subscriptionTier: 'starter',
    })
    const rawBody = JSON.stringify({
      event: 'charge.success',
      data: {
        id: 12345,
        reference: 'mesa_ref_12345',
        amount: 1200000,
        paid_at: '2026-06-05T08:00:00.000Z',
        customer: { customer_code: 'CUS_123', email: 'owner@example.com' },
        metadata: { merchantId: merchant.id, plan: 'starter' },
        plan: { plan_code: 'PLN_starter' },
        subscription_code: 'SUB_123',
        email_token: 'token_123',
      },
    })

    for (let attempt = 0; attempt < 2; attempt += 1) {
      const res = await app.inject({
        method: 'POST',
        url: '/webhooks/paystack',
        headers: {
          'content-type': 'application/json',
          'x-paystack-signature': sign(rawBody),
        },
        payload: rawBody,
      })
      expect(res.statusCode).toBe(200)
    }

    const refreshed = await db.query.merchants.findFirst({
      where: eq(merchants.id, merchant.id),
    })
    expect(refreshed?.subscriptionStatus).toBe('active')

    const subscription = await db.query.subscriptions.findFirst({
      where: eq(subscriptions.merchantId, merchant.id),
    })
    expect(subscription?.paystackSubscriptionCode).toBe('SUB_123')
    expect(subscription?.paystackEmailToken).toBe('token_123')

    const events = await db.query.billingEvents.findMany({
      where: eq(billingEvents.merchantId, merchant.id),
    })
    expect(events.filter((event) => event.type === 'charge_success')).toHaveLength(1)
  })
})
