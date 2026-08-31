import { FastifyInstance } from 'fastify'
import type { Db } from '@mesa/db'
import { orders, agentTasks, notificationFailures } from '@mesa/db'
import { eq, desc, and, inArray, isNull, sql } from 'drizzle-orm'
import { authorizeMerchant } from '../auth-context'

type OrderStatus = typeof orders.$inferSelect.status

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/

export async function orderRoutes(app: FastifyInstance) {
  const db = (app as FastifyInstance & { db: Db }).db

  // List orders for a merchant. Optional from/to (YYYY-MM-DD, inclusive,
  // Africa/Lagos calendar days — matching /analytics/revenue-range's
  // convention) scope this to a date range server-side, so a dashboard
  // date filter reflects everything in that range rather than silently
  // only searching whatever the row cap happened to already fetch.
  app.get<{ Querystring: { merchantId: string; status?: string; from?: string; to?: string; limit?: string } }>(
    '/',
    {
      config: { rateLimit: { max: 60, timeWindow: '1 minute' } },
    },
    async (req, reply) => {
      const { merchantId, status, from, to, limit } = req.query
      const auth = authorizeMerchant(req, reply, merchantId)
      if (!auth.ok) return
      const authorizedMerchantId = auth.merchantId!

      if ((from && !DATE_ONLY.test(from)) || (to && !DATE_ONLY.test(to))) {
        return reply.status(400).send({ error: 'from/to must be YYYY-MM-DD' })
      }
      if (from && to && from > to) {
        return reply.status(400).send({ error: 'from must not be after to' })
      }

      const conditions = [eq(orders.merchantId, authorizedMerchantId)]
      if (status) conditions.push(eq(orders.status, status as OrderStatus))
      // The ::timestamp cast is load-bearing — see /analytics/revenue-range
      // for why casting a bare `date` with AT TIME ZONE resolves to the
      // wrong overload and silently produces the wrong UTC instant.
      if (from) conditions.push(sql`${orders.createdAt} >= (${from}::date::timestamp AT TIME ZONE 'Africa/Lagos')`)
      if (to) conditions.push(sql`${orders.createdAt} < ((${to}::date::timestamp + interval '1 day') AT TIME ZONE 'Africa/Lagos')`)

      const parsedLimit = Math.min(Math.max(parseInt(limit ?? '', 10) || 50, 1), 500)

      const result = await db.query.orders.findMany({
        where: and(...conditions),
        orderBy: [desc(orders.createdAt)],
        limit: parsedLimit,
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
