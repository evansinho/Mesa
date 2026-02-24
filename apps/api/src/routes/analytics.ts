import { FastifyInstance } from 'fastify'
import type { Db } from '@mesa/db'
import { orders, payments } from '@mesa/db'
import { eq, and, gte, sql } from 'drizzle-orm'

export async function analyticsRoutes(app: FastifyInstance) {
  const db = (app as FastifyInstance & { db: Db }).db

  // Revenue summary for a merchant
  app.get<{ Querystring: { merchantId: string; days?: number } }>(
    '/revenue',
    {
      config: { rateLimit: { max: 30, timeWindow: '1 minute' } },
    },
    async (req) => {
      const { merchantId, days = 30 } = req.query
      const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000)

      const result = await db
        .select({
          totalRevenue: sql<number>`COALESCE(SUM(${payments.amount}::numeric), 0)`,
          totalOrders: sql<number>`COUNT(DISTINCT ${orders.id})`,
        })
        .from(orders)
        .leftJoin(payments, and(
          eq(payments.orderId, orders.id),
          eq(payments.status, 'CONFIRMED')
        ))
        .where(and(
          eq(orders.merchantId, merchantId),
          gte(orders.createdAt, since)
        ))

      return { summary: result[0], period: { days } }
    }
  )
}
