import Fastify, { type FastifyInstance } from 'fastify'
import { config } from '@mesa/config'
import { registerAuthContext } from '../../src/auth-context'
import { webhookRoutes } from '../../src/routes/webhooks'
import { getTestDb } from '@test-helpers/db'
import { setupIntegration } from '@test-helpers/integration-setup'

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

describe('Mono webhook route', () => {
  it('rejects requests with a missing or wrong mono-webhook-secret header', async () => {
    const app = await buildApp()

    const missing = await app.inject({
      method: 'POST',
      url: '/webhooks/mono',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify({ event: 'mono.events.account_connected', event_id: '1', timestamp: '2026-01-01T00:00:00.000Z', data: {} }),
    })
    expect(missing.statusCode).toBe(401)

    const wrong = await app.inject({
      method: 'POST',
      url: '/webhooks/mono',
      headers: { 'content-type': 'application/json', 'mono-webhook-secret': 'not-it' },
      payload: JSON.stringify({ event: 'mono.events.account_connected', event_id: '1', timestamp: '2026-01-01T00:00:00.000Z', data: {} }),
    })
    expect(wrong.statusCode).toBe(401)
  })

  it('accepts a request with the correct secret and does not require session/internal auth', async () => {
    const app = await buildApp()

    const res = await app.inject({
      method: 'POST',
      url: '/webhooks/mono',
      headers: { 'content-type': 'application/json', 'mono-webhook-secret': config.MONO_WEBHOOK_SECRET! },
      payload: JSON.stringify({
        event: 'mono.events.account_connected',
        event_id: 'evt_1',
        timestamp: '2026-01-01T00:00:00.000Z',
        data: { id: 'mono_account_1' },
      }),
    })

    expect(res.statusCode).toBe(200)
  })
})
