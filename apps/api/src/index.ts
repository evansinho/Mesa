import './load-env'
import './otel'
import Fastify from 'fastify'
import helmet from '@fastify/helmet'
import cors from '@fastify/cors'
import rateLimit from '@fastify/rate-limit'
import { config } from '@mesa/config'
import { getDb, closeDb } from '@mesa/db'
import { authSessions } from '@mesa/db'
import { merchantRoutes } from './routes/merchants'
import { orderRoutes } from './routes/orders'
import { analyticsRoutes } from './routes/analytics'
import { whatsappRoutes } from './routes/whatsapp'
import { instagramRoutes } from './routes/instagram'
import { authRoutes } from './routes/auth'
import * as Sentry from '@sentry/node'
import { sql, eq, and, gt } from 'drizzle-orm'
import { createHash } from 'crypto'

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

  app.addHook('onRequest', async (req, reply) => {
    const path = req.url.split('?')[0]
    if (path === '/health' || path === '/ready') return
    if (path === '/auth/request' || path === '/auth/verify') return
    if (path === '/merchants' && req.method === 'POST') return

    // Internal services use x-mesa-api-key
    const apiKey = req.headers['x-mesa-api-key']
    if (apiKey === config.INTERNAL_API_KEY) return

    // Browser SPA uses Authorization: Bearer <session_token>
    const authHeader = req.headers.authorization
    if (authHeader?.startsWith('Bearer ')) {
      const token = authHeader.slice(7)
      const tokenHash = createHash('sha256').update(token).digest('hex')
      const session = await db.query.authSessions.findFirst({
        where: and(
          eq(authSessions.sessionHash, tokenHash),
          gt(authSessions.expiresAt, new Date())
        ),
      })
      if (session) return
    }

    return reply.status(401).send({ error: 'Unauthorized' })
  })

  await app.register(merchantRoutes, { prefix: '/merchants' })
  await app.register(orderRoutes, { prefix: '/orders' })
  await app.register(analyticsRoutes, { prefix: '/analytics' })
  await app.register(whatsappRoutes, { prefix: '/whatsapp' })
  await app.register(instagramRoutes, { prefix: '/instagram' })
  await app.register(authRoutes, { prefix: '/auth' })

  app.get('/health', {
    config: {
      rateLimit: {
        max: 60,
        timeWindow: '1 minute',
      },
    },
  }, async (_req, reply) => {
    try {
      await db.execute(sql`select 1`)
      return { status: 'ok', service: 'api' }
    } catch (err) {
      return reply.status(503).send({ status: 'degraded', service: 'api', error: 'db_unavailable' })
    }
  })

  app.get('/ready', async (_req, reply) => {
    try {
      await db.execute(sql`select 1`)
      return { status: 'ready', service: 'api' }
    } catch (err) {
      return reply.status(503).send({ status: 'not_ready', service: 'api', error: 'db_unavailable' })
    }
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
