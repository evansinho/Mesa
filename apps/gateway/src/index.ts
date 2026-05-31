import './otel'
import Fastify from 'fastify'
import helmet from '@fastify/helmet'
import rateLimit from '@fastify/rate-limit'
import { config } from '@mesa/config'
import { MesaNatsClient } from '@mesa/nats'
import { webhookRoutes } from './routes/webhook'
import Redis from 'ioredis'
import * as Sentry from '@sentry/node'

const app = Fastify({
  logger: {
    redact: {
      paths: [
        'req.headers.authorization',
        'req.headers.cookie',
        'req.headers["x-mesa-api-key"]',
        'req.headers["x-hub-signature-256"]',
        'req.headers["x-mesa-nonce"]',
        'req.headers["x-mesa-timestamp"]',
        'req.headers["x-whatsapp-token"]',
      ],
      censor: '[REDACTED]',
    },
  },
})
const nats = new MesaNatsClient()
const redis = new Redis(config.REDIS_URL)

let _redisPingOk = true
let _redisPingAt = 0
async function cachedRedisPing() {
  if (Date.now() - _redisPingAt < 30_000) return _redisPingOk
  try { await redis.ping(); _redisPingOk = true }
  catch { _redisPingOk = false }
  _redisPingAt = Date.now()
  return _redisPingOk
}

if (config.SENTRY_DSN) {
  Sentry.init({
    dsn: config.SENTRY_DSN,
    environment: config.NODE_ENV,
    tracesSampleRate: 0.1,
  })
}

async function start() {
  await nats.connect(config.NATS_URL)

  await app.register(helmet)
  await app.register(rateLimit, {
    global: false,
  })

  // Inject NATS client into route context
  app.decorate('nats', nats)
  app.decorate('redis', redis)

  await app.register(webhookRoutes, { prefix: '/webhook' })
  await app.register(webhookRoutes, { prefix: '/webhooks' })

  app.get('/health', async (_req, reply) => {
    const redisOk = await cachedRedisPing()
    if (!redisOk) return reply.status(503).send({ status: 'degraded', service: 'gateway', error: 'redis_unavailable' })
    if (!nats.isConnected) return reply.status(503).send({ status: 'degraded', service: 'gateway', nats: 'disconnected' })
    return { status: 'ok', service: 'gateway' }
  })

  app.get('/ready', async (_req, reply) => {
    const redisOk = await cachedRedisPing()
    if (!redisOk) return reply.status(503).send({ status: 'not_ready', service: 'gateway', error: 'redis_unavailable' })
    if (!nats.isConnected) return reply.status(503).send({ status: 'not_ready', service: 'gateway', nats: 'disconnected' })
    return { status: 'ready', service: 'gateway' }
  })

  await app.listen({ port: config.GATEWAY_PORT, host: '0.0.0.0' })
  console.log(`Gateway running on port ${config.GATEWAY_PORT}`)
}

app.setErrorHandler((err, req, reply) => {
  if (config.SENTRY_DSN) {
    Sentry.captureException(err, {
      tags: { service: 'gateway' },
      extra: { method: req.method, url: req.url },
    })
  }
  reply.status(500).send({ error: 'Internal Server Error' })
})

async function shutdown() {
  await app.close()
  await nats.drain()
  await redis.quit()
  process.exit(0)
}

process.on('SIGTERM', shutdown)
process.on('SIGINT', shutdown)

start().catch(err => {
  console.error('Gateway failed to start:', err)
  process.exit(1)
})
