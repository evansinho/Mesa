import Fastify from 'fastify'
import helmet from '@fastify/helmet'
import { config } from '@mesa/config'
import { MesaNatsClient } from '@mesa/nats'
import { webhookRoutes } from './routes/webhook'

const app = Fastify({ logger: true })
const nats = new MesaNatsClient()

async function start() {
  await nats.connect(config.NATS_URL)

  await app.register(helmet)

  // Inject NATS client into route context
  app.decorate('nats', nats)

  await app.register(webhookRoutes, { prefix: '/webhook' })

  app.get('/health', async () => ({ status: 'ok', service: 'gateway' }))

  await app.listen({ port: config.GATEWAY_PORT, host: '0.0.0.0' })
  console.log(`Gateway running on port ${config.GATEWAY_PORT}`)
}

async function shutdown() {
  await app.close()
  await nats.drain()
  process.exit(0)
}

process.on('SIGTERM', shutdown)
process.on('SIGINT', shutdown)

start().catch(err => {
  console.error('Gateway failed to start:', err)
  process.exit(1)
})