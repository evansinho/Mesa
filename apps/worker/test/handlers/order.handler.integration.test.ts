import { eq } from 'drizzle-orm'
import { orders, orderItems, products as productsTable, conversations } from '@mesa/db'
import { OrderHandler } from '../../src/handlers/order.handler'
import { PendingDecisions } from '../../src/handlers/pending-decisions'
import { getTestDb } from '@test-helpers/db'
import { getTestRedis } from '@test-helpers/redis'
import { setupIntegration } from '@test-helpers/integration-setup'
import { createMerchant, createConversation, createProduct } from '@test-helpers/factories'

setupIntegration()

function buildHandler() {
  const db = getTestDb()
  const redis = getTestRedis()
  const natsPublish = jest.fn().mockResolvedValue(undefined)
  const nats = { publish: natsPublish } as never
  const pending = new PendingDecisions(db, redis)
  const handler = new OrderHandler(db, nats, console, redis, undefined, pending)
  return { handler, natsPublish, db }
}

describe('OrderHandler.handleConfirmed (F-2 integration)', () => {
  it('creates order + order_items with status=CONFIRMED when total > 0', async () => {
    const { handler, db } = buildHandler()
    const merchant = await createMerchant(db)
    const conv = await createConversation(db, merchant.id, {
      context: {
        currentItems: [
          { productName: 'rice', quantity: 3, unitPrice: 1500 },
          { productName: 'oil', quantity: 2, unitPrice: 750 },
        ],
        negotiationHistory: [],
        lastMessageAt: new Date().toISOString(),
      },
    })

    await handler.handleConfirmed(merchant.id, conv.id, 6000)

    const allOrders = await db.query.orders.findMany({
      where: eq(orders.merchantId, merchant.id),
    })
    expect(allOrders).toHaveLength(1)
    expect(allOrders[0].status).toBe('CONFIRMED')
    expect(parseFloat(allOrders[0].total)).toBe(6000)

    const items = await db.query.orderItems.findMany({
      where: eq(orderItems.orderId, allOrders[0].id),
    })
    expect(items).toHaveLength(2)
  })

  it('rejects with merchant notification when total is 0 — F-2 regression', async () => {
    const { handler, natsPublish, db } = buildHandler()
    const merchant = await createMerchant(db)
    const conv = await createConversation(db, merchant.id, {
      context: {
        currentItems: [{ productName: 'rice', quantity: 3 }],
        negotiationHistory: [],
        lastMessageAt: new Date().toISOString(),
      },
    })

    await handler.handleConfirmed(merchant.id, conv.id, 0)

    const allOrders = await db.query.orders.findMany({
      where: eq(orders.merchantId, merchant.id),
    })
    expect(allOrders).toHaveLength(0)

    // Merchant gets a corrective WhatsApp prompt.
    const messages = natsPublish.mock.calls.map(c => c[0] as { message?: string })
    expect(messages.some(m => /no price/i.test(m.message ?? ''))).toBe(true)
  })

  it('rejects a negative total — F-2 regression', async () => {
    const { handler, db } = buildHandler()
    const merchant = await createMerchant(db)
    const conv = await createConversation(db, merchant.id)

    await handler.handleConfirmed(merchant.id, conv.id, -100)

    const allOrders = await db.query.orders.findMany({
      where: eq(orders.merchantId, merchant.id),
    })
    expect(allOrders).toHaveLength(0)
  })

  it('DB CHECK constraint blocks a direct zero-total INSERT — F-2 DB regression', async () => {
    const db = getTestDb()
    const merchant = await createMerchant(db)

    await expect(
      db.insert(orders).values({
        merchantId: merchant.id,
        customerPhone: '+2348012345678',
        status: 'CONFIRMED',
        subtotal: '0',
        total: '0',
      }),
    ).rejects.toThrow()
  })

  it('learns a new alias when the customer uses a case variant of a canonical product name', async () => {
    const { handler, db } = buildHandler()
    const merchant = await createMerchant(db)
    const product = await createProduct(db, merchant.id, { name: 'Rice', price: '1500' })
    const conv = await createConversation(db, merchant.id, {
      context: {
        currentItems: [{ productName: 'rice', quantity: 2 }],
        negotiationHistory: [],
        lastMessageAt: new Date().toISOString(),
      },
    })

    await handler.handleConfirmed(merchant.id, conv.id, 3000)

    const refreshed = await db.query.products.findFirst({
      where: eq(productsTable.id, product.id),
    })
    expect(refreshed?.aliases).toContain('rice')
  })

  it('publishes ORDER_CONFIRMED on successful order creation', async () => {
    const { handler, natsPublish, db } = buildHandler()
    const merchant = await createMerchant(db)
    const conv = await createConversation(db, merchant.id)

    await handler.handleConfirmed(merchant.id, conv.id, 5000)

    const subjects = natsPublish.mock.calls.map(c => (c[0] as { subject: string }).subject)
    expect(subjects).toContain('mesa.order.confirmed')
  })

  it('returns silently when conversationId does not exist', async () => {
    const { handler, db } = buildHandler()
    const merchant = await createMerchant(db)

    await handler.handleConfirmed(merchant.id, '00000000-0000-0000-0000-000000000000', 5000)

    const allOrders = await db.query.orders.findMany({
      where: eq(orders.merchantId, merchant.id),
    })
    expect(allOrders).toHaveLength(0)
  })
})

describe('OrderHandler.handleDetected (F-4 integration)', () => {
  it('upserts a PENDING_ORDER_CONFIRMATION task and notifies the merchant', async () => {
    const { handler, natsPublish, db } = buildHandler()
    const merchant = await createMerchant(db, { phone: '+2348012345678' })
    const conv = await createConversation(db, merchant.id, { customerPhone: '+2348099998888' })

    await handler.handleDetected({
      subject: 'mesa.order.detected',
      conversationId: conv.id,
      merchantId: merchant.id,
      customerPhone: conv.customerPhone,
      items: [{ productName: 'rice', quantity: 3 }],
      agreedTotal: 4500,
    })

    // A notification went to the merchant.
    const notify = natsPublish.mock.calls.map(c => c[0] as { to: string; subject: string })
    const merchantNotify = notify.find(n => n.to === '+2348012345678')
    expect(merchantNotify).toBeDefined()
    expect(merchantNotify?.subject).toBe('mesa.notification.send')
  })
})