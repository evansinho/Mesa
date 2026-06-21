import { FastifyInstance } from 'fastify'
import type { Db } from '@mesa/db'
import { payments, orders } from '@mesa/db'
import { eq, desc, and } from 'drizzle-orm'
import { authorizeMerchant } from '../auth-context'

type PaymentStatus = typeof payments.$inferSelect.status

export async function paymentRoutes(app: FastifyInstance) {
  const db = (app as FastifyInstance & { db: Db }).db

  app.get<{ Querystring: { merchantId: string; status?: string; limit?: string } }>(
    '/',
    { config: { rateLimit: { max: 60, timeWindow: '1 minute' } } },
    async (req, reply) => {
      const { merchantId, status, limit } = req.query
      const auth = authorizeMerchant(req, reply, merchantId)
      if (!auth.ok) return
      const authorizedMerchantId = auth.merchantId!

      const where = status
        ? and(eq(payments.merchantId, authorizedMerchantId), eq(payments.status, status as PaymentStatus))
        : eq(payments.merchantId, authorizedMerchantId)

      const rows = await db
        .select({
          id: payments.id,
          orderId: payments.orderId,
          amount: payments.amount,
          status: payments.status,
          bankName: payments.bankName,
          createdAt: payments.createdAt,
          customerPhone: orders.customerPhone,
          customerName: orders.customerName,
        })
        .from(payments)
        .innerJoin(orders, eq(payments.orderId, orders.id))
        .where(where)
        .orderBy(desc(payments.createdAt))
        .limit(Math.min(Number(limit ?? 30), 100))

      return { payments: rows }
    }
  )
}
