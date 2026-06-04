jest.mock('@mesa/whatsapp', () => ({
  sendText: jest.fn().mockResolvedValue({ messages: [{ id: 'wamid.test' }] }),
}))

import Fastify, { type FastifyInstance } from 'fastify'
import { analyticsRoutes } from '../../src/routes/analytics'
import { instagramRoutes } from '../../src/routes/instagram'
import { whatsappRoutes } from '../../src/routes/whatsapp'
import { registerAuthContext } from '../../src/auth-context'
import { getTestDb } from '@test-helpers/db'
import { setupIntegration } from '@test-helpers/integration-setup'
import { createMerchant } from '@test-helpers/factories'
import { createSessionHeaders } from '@test-helpers/auth'

setupIntegration()

async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify({ logger: false })
  const db = getTestDb()
  app.decorate('db', db)
  registerAuthContext(app, db)
  await app.register(analyticsRoutes, { prefix: '/analytics' })
  await app.register(whatsappRoutes, { prefix: '/whatsapp' })
  await app.register(instagramRoutes, { prefix: '/instagram' })
  return app
}

describe('tenant scoping across non-CRUD routes', () => {
  it('rejects analytics requests for another merchant', async () => {
    const app = await buildApp()
    const db = getTestDb()
    const merchantA = await createMerchant(db)
    const merchantB = await createMerchant(db)

    const res = await app.inject({
      method: 'GET',
      url: `/analytics/summary?merchantId=${merchantB.id}`,
      headers: await createSessionHeaders(db, merchantA.id),
    })

    expect(res.statusCode).toBe(403)
  })

  it('rejects WhatsApp linking for another merchant before external calls', async () => {
    const app = await buildApp()
    const db = getTestDb()
    const merchantA = await createMerchant(db)
    const merchantB = await createMerchant(db)

    const res = await app.inject({
      method: 'POST',
      url: '/whatsapp/embedded-signup',
      headers: await createSessionHeaders(db, merchantA.id),
      payload: {
        merchantId: merchantB.id,
        phoneNumberId: 'phone_b',
        wabaId: 'waba_b',
      },
    })

    expect(res.statusCode).toBe(403)
  })

  it('rejects Instagram linking for another merchant before external calls', async () => {
    const app = await buildApp()
    const db = getTestDb()
    const merchantA = await createMerchant(db)
    const merchantB = await createMerchant(db)

    const res = await app.inject({
      method: 'POST',
      url: '/instagram/embedded-signup',
      headers: await createSessionHeaders(db, merchantA.id),
      payload: {
        merchantId: merchantB.id,
        instagramAccountId: 'ig_b',
      },
    })

    expect(res.statusCode).toBe(403)
  })
})
