import { FastifyInstance } from 'fastify'
import type { Db } from '@mesa/db'
import { orders, agentTasks, notificationFailures } from '@mesa/db'
import { eq, desc, and, inArray, isNull } from 'drizzle-orm'
import { authorizeMerchant } from '../auth-context'

type OrderStatus = typeof orders.$inferSelect.status

export async function orderRoutes(app: FastifyInstance) {
  const db = (app as FastifyInstance & { db: Db }).db

  // List orders for a merchant
  app.get<{ Querystring: { merchantId: string; status?: string } }>(
    '/',
    {
      config: { rateLimit: { max: 60, timeWindow: '1 minute' } },
    },
    async (req, reply) => {
      const { merchantId, status } = req.query
      const auth = authorizeMerchant(req, reply, merchantId)
      if (!auth.ok) return
      const authorizedMerchantId = auth.merchantId!
      const where = status
        ? and(eq(orders.merchantId, authorizedMerchantId), eq(orders.status, status as OrderStatus))
        : eq(orders.merchantId, authorizedMerchantId)

      const result = await db.query.orders.findMany({
        where,
        orderBy: [desc(orders.createdAt)],
        limit: 50,
        with: {
          items: true,
          payments: true,
          conversation: { columns: { channel: true } },
        },
      })

      return { orders: result }
    }
  )

  // Pending merchant decisions (order confirmations + payment reviews).
  // The dashboard banner reads this to nudge the merchant to respond.
  app.get<{ Querystring: { merchantId: string } }>('/pending', {
    config: { rateLimit: { max: 60, timeWindow: '1 minute' } },
  }, async (req, reply) => {
    const { merchantId } = req.query
    if (!merchantId) return reply.status(400).send({ error: 'merchantId required' })
    const auth = authorizeMerchant(req, reply, merchantId)
    if (!auth.ok) return
    const authorizedMerchantId = auth.merchantId!

    const tasks = await db.query.agentTasks.findMany({
      where: and(
        eq(agentTasks.merchantId, authorizedMerchantId),
        eq(agentTasks.status, 'OPEN'),
        inArray(agentTasks.type, ['PENDING_ORDER_CONFIRMATION', 'PENDING_PAYMENT_REVIEW']),
      ),
      orderBy: [desc(agentTasks.createdAt)],
    })

    return { pending: tasks }
  })

  // Unresolved notification delivery failures for a merchant. The dashboard
  // surfaces these so the operator/merchant knows when a customer or vendor
  // notification never landed.
  app.get<{ Querystring: { merchantId: string } }>('/notifications/failures', {
    config: { rateLimit: { max: 60, timeWindow: '1 minute' } },
  }, async (req, reply) => {
    const { merchantId } = req.query
    if (!merchantId) return reply.status(400).send({ error: 'merchantId required' })
    const auth = authorizeMerchant(req, reply, merchantId)
    if (!auth.ok) return
    const authorizedMerchantId = auth.merchantId!

    const rows = await db.query.notificationFailures.findMany({
      where: and(
        eq(notificationFailures.merchantId, authorizedMerchantId),
        isNull(notificationFailures.resolvedAt),
      ),
      orderBy: [desc(notificationFailures.createdAt)],
      limit: 100,
    })
    return { failures: rows }
  })

  // Get single order
  app.get<{ Params: { id: string } }>('/:id', {
    config: { rateLimit: { max: 60, timeWindow: '1 minute' } },
  }, async (req, reply) => {
    const auth = authorizeMerchant(req, reply, undefined, { allowInternalWithoutMerchant: true })
    if (!auth.ok) return
    const where = auth.merchantId
      ? and(eq(orders.id, req.params.id), eq(orders.merchantId, auth.merchantId))
      : eq(orders.id, req.params.id)

    const order = await db.query.orders.findFirst({
      where,
      with: { items: true, payments: true, conversation: { columns: { channel: true } }, fulfilments: true },
    })

    if (!order) return reply.status(404).send({ error: 'Order not found' })
    return { order }
  })
}
