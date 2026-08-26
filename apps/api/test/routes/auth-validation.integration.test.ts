import Fastify, { type FastifyInstance } from 'fastify'
import { registerAuthContext } from '../../src/auth-context'
import { authRoutes } from '../../src/routes/auth'
import { merchantRoutes } from '../../src/routes/merchants'
import { getTestDb } from '@test-helpers/db'
import { setupIntegration } from '@test-helpers/integration-setup'

setupIntegration()

async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify({ logger: false })
  const db = getTestDb()
  app.decorate('db', db)
  registerAuthContext(app, db)
  await app.register(authRoutes, { prefix: '/auth' })
  await app.register(merchantRoutes, { prefix: '/merchants' })
  return app
}

/**
 * Both of these routes are PUBLIC and take `phone` out of the body. Their
 * TypeScript Body types claim `phone: string`, but Fastify does not validate
 * without a schema, so the types are not enforced at runtime.
 *
 * A malformed body used to reach normalizePhone as undefined and 500. That
 * reached production as a Sentry TypeError, on endpoints anyone can call.
 */
describe('Public routes reject a malformed phone with 400, never 500', () => {
  it.each([
    ['POST /auth/request', '/auth/request'],
    ['POST /merchants', '/merchants'],
  ])('%s on an empty body', async (_label, url) => {
    const app = await buildApp()
    const res = await app.inject({ method: 'POST', url, payload: {} })
    expect(res.statusCode).toBe(400)
  })

  it.each([
    ['POST /auth/request', '/auth/request'],
    ['POST /merchants', '/merchants'],
  ])('%s on a blank phone', async (_label, url) => {
    const app = await buildApp()
    const res = await app.inject({ method: 'POST', url, payload: { phone: '   ' } })
    expect(res.statusCode).toBe(400)
  })

  it.each([
    ['POST /auth/request', '/auth/request'],
    ['POST /merchants', '/merchants'],
  ])('%s on a non-string phone', async (_label, url) => {
    const app = await buildApp()
    const res = await app.inject({ method: 'POST', url, payload: { phone: 12345 } })
    // Not a 500. Whether the framework rejects it or our guard does, the caller
    // gets a client error.
    expect(res.statusCode).toBeGreaterThanOrEqual(400)
    expect(res.statusCode).toBeLessThan(500)
  })

  it('POST /auth/request still answers 200 for a well-formed unknown phone', async () => {
    // The no-enumeration property has to survive the new guard: a valid request
    // must not reveal whether the number is registered.
    const app = await buildApp()
    const res = await app.inject({
      method: 'POST', url: '/auth/request', payload: { phone: '+2348031111111' },
    })
    expect(res.statusCode).toBe(200)
  })
})
