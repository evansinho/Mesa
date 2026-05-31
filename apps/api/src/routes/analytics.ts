import { FastifyInstance } from 'fastify'
import type { Db } from '@mesa/db'
import { orders, payments, orderItems, products } from '@mesa/db'
import { eq, and, gte, desc, sql } from 'drizzle-orm'

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

  // Revenue summary buckets (today / 7d / 30d)
  app.get<{ Querystring: { merchantId: string } }>(
    '/summary',
    {
      config: { rateLimit: { max: 30, timeWindow: '1 minute' } },
    },
    async (req) => {
      const { merchantId } = req.query
      const now = new Date()
      const startToday = new Date(now)
      startToday.setHours(0, 0, 0, 0)

      const start7d = new Date(now)
      start7d.setDate(start7d.getDate() - 7)

      const start30d = new Date(now)
      start30d.setDate(start30d.getDate() - 30)

      const baseWhere = (since: Date) => and(
        eq(orders.merchantId, merchantId),
        gte(orders.createdAt, since)
      )

      const query = (since: Date) => db
        .select({
          totalRevenue: sql<number>`COALESCE(SUM(${payments.amount}::numeric), 0)`,
          totalOrders: sql<number>`COUNT(DISTINCT ${orders.id})`,
        })
        .from(orders)
        .leftJoin(payments, and(eq(payments.orderId, orders.id), eq(payments.status, 'CONFIRMED')))
        .where(baseWhere(since))

      const [today, sevenDays, thirtyDays] = await Promise.all([
        query(startToday),
        query(start7d),
        query(start30d),
      ])

      return {
        revenue: {
          today: today[0],
          sevenDays: sevenDays[0],
          thirtyDays: thirtyDays[0],
        },
      }
    }
  )

  // Top products by revenue
  app.get<{ Querystring: { merchantId: string } }>(
    '/top-products',
    {
      config: { rateLimit: { max: 30, timeWindow: '1 minute' } },
    },
    async (req) => {
      const { merchantId } = req.query

      const rows = await db
        .select({
          productId: products.id,
          productName: products.name,
          revenue: sql<number>`SUM(${orderItems.agreedPrice}::numeric * ${orderItems.quantity})`,
        })
        .from(orderItems)
        .innerJoin(orders, eq(orderItems.orderId, orders.id))
        .innerJoin(products, eq(orderItems.productId, products.id))
        .where(and(eq(orders.merchantId, merchantId), eq(orders.status, 'PAID')))
        .groupBy(products.id, products.name)
        .orderBy(desc(sql`SUM(${orderItems.agreedPrice}::numeric * ${orderItems.quantity})`))
        .limit(5)

      return { products: rows }
    }
  )
}
