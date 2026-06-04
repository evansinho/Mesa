import { FastifyInstance } from 'fastify'
import type { Db } from '@mesa/db'
import { orders, payments, orderItems, products, merchants } from '@mesa/db'
import { eq, and, gte, desc, sql } from 'drizzle-orm'
import { authorizeMerchant } from '../auth-context'

export async function analyticsRoutes(app: FastifyInstance) {
  const db = (app as FastifyInstance & { db: Db }).db

  // Revenue summary: today / 7d / 30d + customers today + unpaid
  app.get<{ Querystring: { merchantId: string } }>(
    '/summary',
    { config: { rateLimit: { max: 30, timeWindow: '1 minute' } } },
    async (req, reply) => {
      const { merchantId } = req.query
      const auth = authorizeMerchant(req, reply, merchantId)
      if (!auth.ok) return
      const authorizedMerchantId = auth.merchantId!
      const now = new Date()

      const startToday = new Date(now)
      startToday.setHours(0, 0, 0, 0)

      const start7d = new Date(now)
      start7d.setDate(start7d.getDate() - 7)

      const start30d = new Date(now)
      start30d.setDate(start30d.getDate() - 30)

      const revenueQuery = (since: Date) =>
        db.select({
          totalRevenue: sql<number>`COALESCE(SUM(${payments.amount}::numeric), 0)`,
          totalOrders: sql<number>`COUNT(DISTINCT ${orders.id})`,
        })
          .from(orders)
          .leftJoin(payments, and(eq(payments.orderId, orders.id), eq(payments.status, 'CONFIRMED')))
          .where(and(eq(orders.merchantId, authorizedMerchantId), gte(orders.createdAt, since)))

      const [today, sevenDays, thirtyDays, customersRes, unpaidRes] = await Promise.all([
        revenueQuery(startToday),
        revenueQuery(start7d),
        revenueQuery(start30d),
        db.select({ count: sql<number>`COUNT(DISTINCT ${orders.customerPhone})` })
          .from(orders)
          .where(and(eq(orders.merchantId, authorizedMerchantId), gte(orders.createdAt, startToday))),
        db.select({
          count: sql<number>`COUNT(*)`,
          amount: sql<number>`COALESCE(SUM(${orders.total}::numeric), 0)`,
        })
          .from(orders)
          .where(and(eq(orders.merchantId, authorizedMerchantId), eq(orders.status, 'AWAITING_PAYMENT'))),
      ])

      return {
        revenue: {
          today: { totalRevenue: Number(today[0]?.totalRevenue ?? 0), totalOrders: Number(today[0]?.totalOrders ?? 0) },
          sevenDays: { totalRevenue: Number(sevenDays[0]?.totalRevenue ?? 0), totalOrders: Number(sevenDays[0]?.totalOrders ?? 0) },
          thirtyDays: { totalRevenue: Number(thirtyDays[0]?.totalRevenue ?? 0), totalOrders: Number(thirtyDays[0]?.totalOrders ?? 0) },
        },
        customersToday: Number(customersRes[0]?.count ?? 0),
        unpaid: {
          count: Number(unpaidRes[0]?.count ?? 0),
          amount: Number(unpaidRes[0]?.amount ?? 0),
        },
      }
    }
  )

  // Daily revenue for the last N days — chart data
  app.get<{ Querystring: { merchantId: string; days?: number } }>(
    '/revenue-chart',
    { config: { rateLimit: { max: 30, timeWindow: '1 minute' } } },
    async (req, reply) => {
      const { merchantId, days = 30 } = req.query
      const auth = authorizeMerchant(req, reply, merchantId)
      if (!auth.ok) return
      const authorizedMerchantId = auth.merchantId!
      const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000)

      const rows = await db
        .select({
          date: sql<string>`DATE(${orders.createdAt} AT TIME ZONE 'Africa/Lagos')`,
          revenue: sql<number>`COALESCE(SUM(${orders.total}::numeric), 0)`,
          orderCount: sql<number>`COUNT(*)`,
        })
        .from(orders)
        .where(and(
          eq(orders.merchantId, authorizedMerchantId),
          gte(orders.createdAt, since),
          sql`${orders.status} != 'CANCELLED'`
        ))
        .groupBy(sql`DATE(${orders.createdAt} AT TIME ZONE 'Africa/Lagos')`)
        .orderBy(sql`DATE(${orders.createdAt} AT TIME ZONE 'Africa/Lagos') ASC`)

      const dataMap = new Map(rows.map(r => [r.date, r]))
      const result = []
      for (let i = days - 1; i >= 0; i--) {
        const d = new Date(Date.now() - i * 24 * 60 * 60 * 1000)
        const dateStr = d.toLocaleDateString('en-CA') // YYYY-MM-DD format
        const row = dataMap.get(dateStr)
        result.push({
          date: dateStr,
          revenue: row ? Number(row.revenue) : 0,
          orderCount: row ? Number(row.orderCount) : 0,
        })
      }

      return { days: result }
    }
  )

  // Customer intelligence: top customers + repeat rate + at-risk list
  app.get<{ Querystring: { merchantId: string } }>(
    '/customers',
    { config: { rateLimit: { max: 30, timeWindow: '1 minute' } } },
    async (req, reply) => {
      const { merchantId } = req.query
      const auth = authorizeMerchant(req, reply, merchantId)
      if (!auth.ok) return
      const authorizedMerchantId = auth.merchantId!

      const [topCustomers, atRisk] = await Promise.all([
        db.select({
          customerPhone: orders.customerPhone,
          customerName: sql<string | null>`MAX(${orders.customerName})`,
          orderCount: sql<number>`COUNT(*)`,
          totalSpend: sql<number>`COALESCE(SUM(${orders.total}::numeric), 0)`,
          lastOrderAt: sql<string>`MAX(${orders.createdAt})`,
        })
          .from(orders)
          .where(and(eq(orders.merchantId, authorizedMerchantId), sql`${orders.status} != 'CANCELLED'`))
          .groupBy(orders.customerPhone)
          .orderBy(desc(sql`COALESCE(SUM(${orders.total}::numeric), 0)`))
          .limit(20),

        db.select({
          customerPhone: orders.customerPhone,
          customerName: sql<string | null>`MAX(${orders.customerName})`,
          lastOrderAt: sql<string>`MAX(${orders.createdAt})`,
          totalSpend: sql<number>`COALESCE(SUM(${orders.total}::numeric), 0)`,
          orderCount: sql<number>`COUNT(*)`,
        })
          .from(orders)
          .where(and(eq(orders.merchantId, authorizedMerchantId), sql`${orders.status} != 'CANCELLED'`))
          .groupBy(orders.customerPhone)
          .having(sql`MAX(${orders.createdAt}) < NOW() - INTERVAL '14 days'`)
          .orderBy(desc(sql`COALESCE(SUM(${orders.total}::numeric), 0)`))
          .limit(10),
      ])

      const totalCustomers = topCustomers.length
      const repeatCustomers = topCustomers.filter(c => Number(c.orderCount) > 1).length
      const repeatRate = totalCustomers > 0 ? Math.round((repeatCustomers / totalCustomers) * 100) : 0

      return {
        topCustomers: topCustomers.map(c => ({
          customerPhone: c.customerPhone,
          customerName: c.customerName,
          orderCount: Number(c.orderCount),
          totalSpend: Number(c.totalSpend),
          lastOrderAt: c.lastOrderAt,
        })),
        atRisk: atRisk.map(c => ({
          customerPhone: c.customerPhone,
          customerName: c.customerName,
          orderCount: Number(c.orderCount),
          totalSpend: Number(c.totalSpend),
          lastOrderAt: c.lastOrderAt,
        })),
        stats: { totalCustomers, repeatCustomers, repeatRate, atRiskCount: atRisk.length },
      }
    }
  )

  // Subscription usage: orders this month vs plan limit
  app.get<{ Querystring: { merchantId: string } }>(
    '/subscription',
    { config: { rateLimit: { max: 30, timeWindow: '1 minute' } } },
    async (req, reply) => {
      const { merchantId } = req.query
      const auth = authorizeMerchant(req, reply, merchantId)
      if (!auth.ok) return
      const authorizedMerchantId = auth.merchantId!

      const merchantRow = await db.query.merchants.findFirst({
        where: eq(merchants.id, authorizedMerchantId),
        columns: { subscriptionTier: true },
      })
      const tier = (merchantRow?.subscriptionTier ?? 'starter') as string

      const ORDER_LIMITS: Record<string, number> = { starter: 100, growth: 400, business: 1200 }
      const limit = ORDER_LIMITS[tier] ?? 100

      // Start of current month in Lagos timezone (UTC+1)
      const now = new Date()
      const lagosOffset = 60 * 60 * 1000 // UTC+1
      const lagosNow = new Date(now.getTime() + lagosOffset)
      const startOfMonth = new Date(Date.UTC(lagosNow.getUTCFullYear(), lagosNow.getUTCMonth(), 1) - lagosOffset)

      const [countRes] = await db.select({
        count: sql<number>`COUNT(*)`,
      })
        .from(orders)
        .where(and(
          eq(orders.merchantId, authorizedMerchantId),
          gte(orders.createdAt, startOfMonth),
          sql`${orders.status} != 'CANCELLED'`
        ))

      return {
        tier,
        ordersThisMonth: Number(countRes?.count ?? 0),
        limit,
      }
    }
  )

  // Peak ordering hours — last 30 days, Lagos timezone
  app.get<{ Querystring: { merchantId: string } }>(
    '/peak-hours',
    { config: { rateLimit: { max: 30, timeWindow: '1 minute' } } },
    async (req, reply) => {
      const { merchantId } = req.query
      const auth = authorizeMerchant(req, reply, merchantId)
      if (!auth.ok) return
      const authorizedMerchantId = auth.merchantId!
      const since = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000)

      const rows = await db
        .select({
          hour: sql<number>`EXTRACT(HOUR FROM ${orders.createdAt} AT TIME ZONE 'Africa/Lagos')::int`,
          count: sql<number>`COUNT(*)`,
        })
        .from(orders)
        .where(and(
          eq(orders.merchantId, authorizedMerchantId),
          gte(orders.createdAt, since),
          sql`${orders.status} != 'CANCELLED'`
        ))
        .groupBy(sql`EXTRACT(HOUR FROM ${orders.createdAt} AT TIME ZONE 'Africa/Lagos')::int`)
        .orderBy(sql`EXTRACT(HOUR FROM ${orders.createdAt} AT TIME ZONE 'Africa/Lagos')::int`)

      const hourMap = new Map(rows.map(r => [Number(r.hour), Number(r.count)]))
      const hours = Array.from({ length: 24 }, (_, h) => ({
        hour: h,
        count: hourMap.get(h) ?? 0,
        label: h === 0 ? '12am' : h < 12 ? `${h}am` : h === 12 ? '12pm' : `${h - 12}pm`,
      }))

      return { hours }
    }
  )

  // Top products by revenue (last 30 days)
  app.get<{ Querystring: { merchantId: string } }>(
    '/top-products',
    { config: { rateLimit: { max: 30, timeWindow: '1 minute' } } },
    async (req, reply) => {
      const { merchantId } = req.query
      const auth = authorizeMerchant(req, reply, merchantId)
      if (!auth.ok) return
      const authorizedMerchantId = auth.merchantId!
      const since = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000)

      const rows = await db
        .select({
          productId: products.id,
          productName: products.name,
          revenue: sql<number>`SUM(${orderItems.agreedPrice}::numeric * ${orderItems.quantity})`,
          unitsSold: sql<number>`SUM(${orderItems.quantity})`,
        })
        .from(orderItems)
        .innerJoin(orders, eq(orderItems.orderId, orders.id))
        .innerJoin(products, eq(orderItems.productId, products.id))
        .where(and(
          eq(orders.merchantId, authorizedMerchantId),
          gte(orders.createdAt, since),
          sql`${orders.status} != 'CANCELLED'`
        ))
        .groupBy(products.id, products.name)
        .orderBy(desc(sql`SUM(${orderItems.agreedPrice}::numeric * ${orderItems.quantity})`))
        .limit(5)

      return {
        products: rows.map(r => ({
          productId: r.productId,
          productName: r.productName,
          revenue: Number(r.revenue ?? 0),
          unitsSold: Number(r.unitsSold ?? 0),
        })),
      }
    }
  )
}
