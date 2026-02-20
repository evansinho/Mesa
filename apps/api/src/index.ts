import Fastify from 'fastify'
import helmet from '@fastify/helmet'
import cors from '@fastify/cors'
import { config } from '@mesa/config'
import { getDb, closeDb } from '@mesa/db'
import { merchantRoutes } from './routes/merchants'
import { orderRoutes } from './routes/orders'
import { analyticsRoutes } from './routes/analytics'

const app = Fastify({ logger: true })

async function start() {
  const db = getDb(config.DATABASE_URL)

  await app.register(helmet)
  await app.register(cors, { origin: true })

  app.decorate('db', db)

  await app.register(merchantRoutes, { prefix: '/merchants' })
  await app.register(orderRoutes, { prefix: '/orders' })
  await app.register(analyticsRoutes, { prefix: '/analytics' })

  app.get('/health', async () => ({ status: 'ok', service: 'api' }))

  await app.listen({ port: config.API_PORT, host: '0.0.0.0' })
  console.log(`API running on port ${config.API_PORT}`)
}

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