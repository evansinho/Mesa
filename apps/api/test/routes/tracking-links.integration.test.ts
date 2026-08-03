import Fastify, { type FastifyInstance } from 'fastify'
import { eq } from 'drizzle-orm'
import { trackingLinks, trackingLinkClicks } from '@mesa/db'
import { merchantRoutes } from '../../src/routes/merchants'
import { trackingLinkRedirectRoutes } from '../../src/routes/tracking-links'
import { registerAuthContext } from '../../src/auth-context'
import { getTestDb } from '@test-helpers/db'
import { setupIntegration } from '@test-helpers/integration-setup'
import { createMerchant } from '@test-helpers/factories'
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
  await app.register(merchantRoutes, { prefix: '/merchants' })
  await app.register(trackingLinkRedirectRoutes, { prefix: '/l' })
  apps.push(app)
  return app
}

describe('Tracking link management (POST/GET /:id/tracking-links)', () => {
  it('creates a tracking link for a valid platform', async () => {
    const app = await buildApp()
    const db = getTestDb()
    const merchant = await createMerchant(db)

    const res = await app.inject({
      method: 'POST',
      url: `/merchants/${merchant.id}/tracking-links`,
      headers: await createSessionHeaders(db, merchant.id),
      payload: { platform: 'tiktok' },
    })

    expect(res.statusCode).toBe(201)
    const body = res.json() as { platform: string; slug: string; url: string }
    expect(body.platform).toBe('tiktok')
    expect(body.slug).toMatch(/^[a-z2-9]{8}$/)
    expect(body.url).toContain(body.slug)

    const row = await db.query.trackingLinks.findFirst({ where: eq(trackingLinks.slug, body.slug) })
    expect(row?.merchantId).toBe(merchant.id)
  })

  it('rejects an unknown platform', async () => {
    const app = await buildApp()
    const db = getTestDb()
    const merchant = await createMerchant(db)

    const res = await app.inject({
      method: 'POST',
      url: `/merchants/${merchant.id}/tracking-links`,
      headers: await createSessionHeaders(db, merchant.id),
      payload: { platform: 'snapchat' },
    })

    expect(res.statusCode).toBe(400)
  })

  it('rejects creating a link under another merchant id', async () => {
    const app = await buildApp()
    const db = getTestDb()
    const merchantA = await createMerchant(db)
    const merchantB = await createMerchant(db)

    const res = await app.inject({
      method: 'POST',
      url: `/merchants/${merchantB.id}/tracking-links`,
      headers: await createSessionHeaders(db, merchantA.id),
      payload: { platform: 'tiktok' },
    })

    expect(res.statusCode).toBe(403)
  })

  it('lists links with click counts', async () => {
    const app = await buildApp()
    const db = getTestDb()
    const merchant = await createMerchant(db)

    const createRes = await app.inject({
      method: 'POST',
      url: `/merchants/${merchant.id}/tracking-links`,
      headers: await createSessionHeaders(db, merchant.id),
      payload: { platform: 'instagram' },
    })
    const { id: linkId } = createRes.json() as { id: string }

    await db.insert(trackingLinkClicks).values([
      { trackingLinkId: linkId, merchantId: merchant.id, platform: 'instagram' },
      { trackingLinkId: linkId, merchantId: merchant.id, platform: 'instagram' },
    ])

    const res = await app.inject({
      method: 'GET',
      url: `/merchants/${merchant.id}/tracking-links`,
      headers: await createSessionHeaders(db, merchant.id),
    })

    expect(res.statusCode).toBe(200)
    const { links } = res.json() as { links: Array<{ id: string; clickCount: number }> }
    expect(links).toHaveLength(1)
    expect(links[0].clickCount).toBe(2)
  })
})

describe('Public tracking-link redirect (GET /l/:slug)', () => {
  it('404s on an unknown slug', async () => {
    const app = await buildApp()

    const res = await app.inject({ method: 'GET', url: '/l/doesnotexist' })

    expect(res.statusCode).toBe(404)
  })

  it('redirects to wa.me with the platform greeting and logs a click', async () => {
    const app = await buildApp()
    const db = getTestDb()
    const merchant = await createMerchant(db, { phone: '+2348012345678' })

    const createRes = await app.inject({
      method: 'POST',
      url: `/merchants/${merchant.id}/tracking-links`,
      headers: await createSessionHeaders(db, merchant.id),
      payload: { platform: 'tiktok' },
    })
    const { id: linkId, slug } = createRes.json() as { id: string; slug: string }

    const res = await app.inject({ method: 'GET', url: `/l/${slug}` })

    expect(res.statusCode).toBe(302)
    const location = res.headers.location as string
    expect(location).toContain('wa.me/2348012345678')
    expect(decodeURIComponent(location)).toContain('TikTok')

    const clicks = await db.query.trackingLinkClicks.findMany({
      where: eq(trackingLinkClicks.trackingLinkId, linkId),
    })
    expect(clicks).toHaveLength(1)
  })
})
