import { getDb, closeDb } from '@mesa/db'
import { domainEvents, orders, payments } from '@mesa/db'
import { config } from '@mesa/config'
import { eq } from 'drizzle-orm'

async function replay() {
  const db = getDb(config.DATABASE_URL)

  if (!process.env.REPLAY_TARGET) {
    console.error('REPLAY_TARGET is required: "orders" or "payments"')
    process.exit(1)
  }

  const events = await db.query.domainEvents.findMany({
    orderBy: (events, { asc }) => [asc(events.createdAt)],
  })

  for (const event of events) {
    const payload = (event.payload as { v?: number; data?: Record<string, unknown> })
    const data = payload?.data ?? event.payload

    switch (event.eventType) {
      case 'ORDER_CONFIRMED': {
        if (process.env.REPLAY_TARGET !== 'orders') break
        const typed = data as {
          merchantId: string
          total: number
        }
        await db.insert(orders).values({
          id: event.aggregateId,
          merchantId: typed.merchantId,
          customerPhone: 'replayed',
          status: 'CONFIRMED',
          subtotal: typed.total.toString(),
          total: typed.total.toString(),
        }).onConflictDoNothing()
        break
      }
      case 'PAYMENT_CONFIRMED': {
        if (process.env.REPLAY_TARGET !== 'payments') break
        const typed = data as {
          merchantId: string
          amount: number
        }
        await db.insert(payments).values({
          orderId: event.aggregateId,
          merchantId: typed.merchantId,
          amount: typed.amount.toString(),
          status: 'CONFIRMED',
        }).onConflictDoNothing()
        await db.update(orders).set({ status: 'PAID' }).where(eq(orders.id, event.aggregateId))
        break
      }
      default:
        break
    }
  }
}

replay()
  .catch(err => {
    console.error('Replay failed:', err)
    process.exit(1)
  })
  .finally(async () => {
    await closeDb()
  })
