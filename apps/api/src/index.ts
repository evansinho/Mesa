import './load-env'
import './otel'
import Fastify from 'fastify'
import helmet from '@fastify/helmet'
import cors from '@fastify/cors'
import rateLimit from '@fastify/rate-limit'
import { config } from '@mesa/config'
import { getDb, closeDb } from '@mesa/db'
import { merchantRoutes } from './routes/merchants'
import { orderRoutes } from './routes/orders'
import { analyticsRoutes } from './routes/analytics'
import { whatsappRoutes } from './routes/whatsapp'
import { instagramRoutes } from './routes/instagram'
import { authRoutes } from './routes/auth'
import { webhookRoutes } from './routes/webhooks'
import { actionRoutes } from './routes/actions'
import { registerAuthContext } from './auth-context'
import * as Sentry from '@sentry/node'
import { sql } from 'drizzle-orm'

const app = Fastify({
  logger: {
    redact: {
      paths: [
        'req.headers.authorization',
        'req.headers.cookie',
        'req.headers["x-mesa-api-key"]',
      ],
      censor: '[REDACTED]',
    },
  },
})

if (config.SENTRY_DSN) {
  Sentry.init({
    dsn: config.SENTRY_DSN,
    environment: config.NODE_ENV,
    tracesSampleRate: 0.1,
  })
}

async function start() {
  const db = getDb(config.DATABASE_URL)

  await app.register(helmet)
  await app.register(cors, { origin: true })
  await app.register(rateLimit, {
    global: false,
  })

  app.decorate('db', db)
  registerAuthContext(app, db)

  await app.register(merchantRoutes, { prefix: '/merchants' })
  await app.register(orderRoutes, { prefix: '/orders' })
  await app.register(analyticsRoutes, { prefix: '/analytics' })
  await app.register(whatsappRoutes, { prefix: '/whatsapp' })
  await app.register(instagramRoutes, { prefix: '/instagram' })
  await app.register(authRoutes, { prefix: '/auth' })
  await app.register(webhookRoutes, { prefix: '/webhooks' })
  await app.register(actionRoutes, { prefix: '/actions' })

  // DB check cached for 60 s — health endpoints are polled every 10–30 s by the
  // platform and a live SELECT 1 on every call keeps Neon compute permanently awake.
  let dbOk = true
  let dbCheckedAt = 0
  async function cachedDbPing(): Promise<boolean> {
    if (Date.now() - dbCheckedAt < 60_000) return dbOk
    try {
      await db.execute(sql`select 1`)
      dbOk = true
    } catch {
      dbOk = false
    }
    dbCheckedAt = Date.now()
    return dbOk
  }

  app.get('/health', {
    config: { rateLimit: { max: 60, timeWindow: '1 minute' } },
  }, async (_req, reply) => {
    const ok = await cachedDbPing()
    if (!ok) return reply.status(503).send({ status: 'degraded', service: 'api', error: 'db_unavailable' })
    return { status: 'ok', service: 'api' }
  })

  app.get('/ready', async (_req, reply) => {
    const ok = await cachedDbPing()
    if (!ok) return reply.status(503).send({ status: 'not_ready', service: 'api', error: 'db_unavailable' })
    return { status: 'ready', service: 'api' }
  })

  await app.listen({ port: config.API_PORT, host: '0.0.0.0' })
  console.log(`API running on port ${config.API_PORT}`)
}

app.setErrorHandler((err, req, reply) => {
  if (config.SENTRY_DSN) {
    Sentry.captureException(err, {
      tags: { service: 'api' },
      extra: { method: req.method, url: req.url },
    })
  }
  reply.status(500).send({ error: 'Internal Server Error' })
})

async function shutdown() {
  await app.close()
  await closeDb()
  process.exit(0)
}

process.on('SIGTERM', shutdown)
process.on('SIGINT', shutdown)

start().catch(err => {
  console.error('API failed to start:', err)
  process.exit(1)
})
