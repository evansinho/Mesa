import { FastifyInstance } from 'fastify'
import type { Db } from '@mesa/db'
import { orders, orderItems, payments } from '@mesa/db'
import { eq, desc } from 'drizzle-orm'

export async function orderRoutes(app: FastifyInstance) {
  const db = (app as FastifyInstance & { db: Db }).db

  // List orders for a merchant
  app.get<{ Querystring: { merchantId: string; status?: string } }>(
    '/',
    {
      config: { rateLimit: { max: 60, timeWindow: '1 minute' } },
    },
    async (req) => {
      const { merchantId, status } = req.query

      const result = await db.query.orders.findMany({
        where: eq(orders.merchantId, merchantId),
        orderBy: [desc(orders.createdAt)],
        limit: 50,
        with: {
          items: true,
          payments: true,
        },
      })

      return { orders: result }
    }
  )

  // Get single order
  app.get<{ Params: { id: string } }>('/:id', {
    config: { rateLimit: { max: 60, timeWindow: '1 minute' } },
  }, async (req, reply) => {
    const order = await db.query.orders.findFirst({
      where: eq(orders.id, req.params.id),
      with: { items: true, payments: true },
    })

    if (!order) return reply.status(404).send({ error: 'Order not found' })
    return { order }
  })
}
