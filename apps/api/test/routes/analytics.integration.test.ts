import Fastify, { type FastifyInstance } from 'fastify'
import { analyticsRoutes } from '../../src/routes/analytics'
import { registerAuthContext } from '../../src/auth-context'
import { getTestDb } from '@test-helpers/db'
import { setupIntegration } from '@test-helpers/integration-setup'
import { createMerchant, createConversation, createOrder } from '@test-helpers/factories'
import { createSessionHeaders } from '@test-helpers/auth'

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
  await app.register(analyticsRoutes, { prefix: '/analytics' })
  apps.push(app)
  return app
}

describe('GET /analytics/by-source', () => {
  it('buckets a null-source order by its conversation channel, distinct from a real tracked-instagram source', async () => {
    const app = await buildApp()
    const db = getTestDb()
    const merchant = await createMerchant(db)

    // No tracked click at all — an Instagram DM straight to the merchant.
    const igConv = await createConversation(db, merchant.id, { channel: 'instagram' })
    await createOrder(db, merchant.id, {
      conversationId: igConv.id,
      total: '5200000',
      subtotal: '5200000',
      source: null,
    })

    // A genuinely tracked Instagram bio-link click — must stay in its own
    // bucket, not get folded into the same label as the DM above.
    const waConv = await createConversation(db, merchant.id, { channel: 'whatsapp' })
    await createOrder(db, merchant.id, {
      conversationId: waConv.id,
      total: '10000',
      subtotal: '10000',
      source: 'instagram',
      sourceConfidence: 'confirmed',
    })

    const res = await app.inject({
      method: 'GET',
      url: `/analytics/by-source?merchantId=${merchant.id}`,
      headers: await createSessionHeaders(db, merchant.id),
    })

    expect(res.statusCode).toBe(200)
    const { sources } = res.json() as { sources: Array<{ source: string; confidence: string | null; revenue: number }> }
    const instagramDirect = sources.find(s => s.source === 'instagram_direct')
    const trackedInstagram = sources.find(s => s.source === 'instagram')
    expect(instagramDirect?.revenue).toBe(5200000)
    expect(instagramDirect?.confidence).toBeNull()
    expect(trackedInstagram?.revenue).toBe(10000)
    expect(trackedInstagram?.confidence).toBe('confirmed')
  })

  it('buckets a null-source, null-conversation order as plain "direct"', async () => {
    const app = await buildApp()
    const db = getTestDb()
    const merchant = await createMerchant(db)
    await createOrder(db, merchant.id, { total: '3000', subtotal: '3000', source: null, conversationId: null })

    const res = await app.inject({
      method: 'GET',
      url: `/analytics/by-source?merchantId=${merchant.id}`,
      headers: await createSessionHeaders(db, merchant.id),
    })

    expect(res.statusCode).toBe(200)
    const { sources } = res.json() as { sources: Array<{ source: string; revenue: number }> }
    expect(sources.find(s => s.source === 'direct')?.revenue).toBe(3000)
  })
})
