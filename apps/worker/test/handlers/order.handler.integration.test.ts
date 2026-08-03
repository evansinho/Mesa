import { eq } from 'drizzle-orm'
import { orders, orderItems, products as productsTable, conversations, agentTasks } from '@mesa/db'
import { OrderHandler } from '../../src/handlers/order.handler'
import { PendingDecisions } from '../../src/handlers/pending-decisions'
import { getTestDb } from '@test-helpers/db'
import { getTestRedis } from '@test-helpers/redis'
import { setupIntegration } from '@test-helpers/integration-setup'
import { createMerchant, createConversation, createProduct, createMerchantChannel } from '@test-helpers/factories'

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

  it('snapshots the conversation source/sourceConfidence onto the order at confirmation time', async () => {
    const { handler, db } = buildHandler()
    const merchant = await createMerchant(db)
    const conv = await createConversation(db, merchant.id, {
      source: 'tiktok',
      sourceConfidence: 'confirmed',
      context: {
        currentItems: [{ productName: 'rice', quantity: 1, unitPrice: 5000 }],
        negotiationHistory: [],
        lastMessageAt: new Date().toISOString(),
      },
    })

    await handler.handleConfirmed(merchant.id, conv.id, 5000)

    const [order] = await db.query.orders.findMany({ where: eq(orders.merchantId, merchant.id) })
    expect(order.source).toBe('tiktok')
    expect(order.sourceConfidence).toBe('confirmed')
  })

  it('leaves order source null when the conversation never got an attribution signal', async () => {
    const { handler, db } = buildHandler()
    const merchant = await createMerchant(db)
    const conv = await createConversation(db, merchant.id, {
      context: {
        currentItems: [{ productName: 'rice', quantity: 1, unitPrice: 5000 }],
        negotiationHistory: [],
        lastMessageAt: new Date().toISOString(),
      },
    })

    await handler.handleConfirmed(merchant.id, conv.id, 5000)

    const [order] = await db.query.orders.findMany({ where: eq(orders.merchantId, merchant.id) })
    expect(order.source).toBeNull()
    expect(order.sourceConfidence).toBeNull()
  })

  it('ignores a duplicate confirmation for a conversation that already has an order — Sino caps regression', async () => {
    // A vendor's "Accept" tap (or its redelivery) can invoke this handler
    // twice for the same conversation; NATS is at-least-once and the
    // conversation lock only prevents concurrent, not sequential, calls.
    const { handler, db } = buildHandler()
    const merchant = await createMerchant(db)
    const conv = await createConversation(db, merchant.id, {
      context: {
        currentItems: [{ productName: 'cap', quantity: 1, unitPrice: 15000 }],
        negotiationHistory: [],
        lastMessageAt: new Date().toISOString(),
      },
    })

    await handler.handleConfirmed(merchant.id, conv.id, 20000)
    await handler.handleConfirmed(merchant.id, conv.id, 20000)

    const allOrders = await db.query.orders.findMany({
      where: eq(orders.merchantId, merchant.id),
    })
    expect(allOrders).toHaveLength(1)
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

  it('skips duplicate order detection notifications for the same open pending order', async () => {
    const { handler, natsPublish, db } = buildHandler()
    const merchant = await createMerchant(db, { phone: '+2348012345678' })
    const conv = await createConversation(db, merchant.id, { customerPhone: '+2348099998888' })
    const event = {
      subject: 'mesa.order.detected' as const,
      conversationId: conv.id,
      merchantId: merchant.id,
      customerPhone: conv.customerPhone,
      items: [{ productName: 'rice', quantity: 3, unitPrice: 5000 }],
      agreedTotal: 15000,
    }

    await handler.handleDetected(event)
    await handler.handleDetected(event)

    const merchantMessages = natsPublish.mock.calls
      .map(c => c[0] as { to?: string; message?: string })
      .filter(m => m.to === '+2348012345678')

    expect(merchantMessages).toHaveLength(1)
    const tasks = await db.query.agentTasks.findMany({
      where: eq(agentTasks.merchantId, merchant.id),
    })
    expect(tasks).toHaveLength(1)
  })

  it('multi-item taps use a single-line item summary (WhatsApp rejects newlines in params)', async () => {
    const { handler, natsPublish, db } = buildHandler()
    const merchant = await createMerchant(db, { phone: '+2348012345678' })
    const conv = await createConversation(db, merchant.id, { customerPhone: '+2348099998888' })

    await handler.handleDetected({
      subject: 'mesa.order.detected',
      conversationId: conv.id,
      merchantId: merchant.id,
      customerPhone: conv.customerPhone,
      items: [
        { productName: 'Versace slides', quantity: 1, unitPrice: 25000 },
        { productName: 'Linen Senator Shirt', quantity: 1, unitPrice: 48000 },
      ],
      agreedTotal: 73000,
    })

    const templateSend = natsPublish.mock.calls
      .map(c => c[0] as { to?: string; template?: { bodyParams: string[] } })
      .find(m => m.to === '+2348012345678' && m.template)
    expect(templateSend).toBeDefined()
    const itemSummary = templateSend!.template!.bodyParams[1]
    expect(itemSummary).not.toMatch(/[\n\t]/)
    expect(itemSummary).toContain('Versace slides')
    expect(itemSummary).toContain('Linen Senator Shirt')
  })

  it('notifies the merchant on Instagram when the order came from an Instagram conversation with a captured IGSID', async () => {
    const { handler, natsPublish, db } = buildHandler()
    const merchant = await createMerchant(db, { phone: '+2348012345678' })
    await createMerchantChannel(db, merchant.id, {
      channel: 'instagram',
      channelAccountId: 'ig_biz_1',
      merchantRecipientId: 'igsid_merchant_1',
    })
    const conv = await createConversation(db, merchant.id, {
      channel: 'instagram',
      customerPhone: 'igsid_customer_1',
    })

    await handler.handleDetected({
      subject: 'mesa.order.detected',
      conversationId: conv.id,
      merchantId: merchant.id,
      customerPhone: conv.customerPhone,
      items: [{ productName: 'rice', quantity: 3, unitPrice: 1500 }],
      agreedTotal: 4500,
    })

    const merchantNotify = natsPublish.mock.calls
      .map(c => c[0] as { to: string; channel: string; message: string; template?: unknown; quickReplies?: Array<{ title: string; payload: string }> })
      .find(n => n.to === 'igsid_merchant_1')
    expect(merchantNotify).toBeDefined()
    expect(merchantNotify?.channel).toBe('instagram')
    expect(merchantNotify?.template).toBeUndefined()
    expect(merchantNotify?.message).toContain('New order received')
    expect(merchantNotify?.message).toContain('👉 Or open:')
    expect(merchantNotify?.message).not.toContain('Reply or tap')
    // Real tappable buttons, matching the WhatsApp template's Accept/Reject set.
    expect(merchantNotify?.quickReplies).toEqual([
      { title: 'Accept', payload: 'accept' },
      { title: 'Reject', payload: 'reject' },
    ])
  })

  it('falls back to WhatsApp when the order came from Instagram but the merchant has not activated their Instagram inbox yet', async () => {
    const { handler, natsPublish, db } = buildHandler()
    const merchant = await createMerchant(db, { phone: '+2348012345678' })
    await createMerchantChannel(db, merchant.id, {
      channel: 'instagram',
      channelAccountId: 'ig_biz_1',
      merchantRecipientId: null,
    })
    const conv = await createConversation(db, merchant.id, {
      channel: 'instagram',
      customerPhone: 'igsid_customer_1',
    })

    await handler.handleDetected({
      subject: 'mesa.order.detected',
      conversationId: conv.id,
      merchantId: merchant.id,
      customerPhone: conv.customerPhone,
      items: [{ productName: 'rice', quantity: 3, unitPrice: 1500 }],
      agreedTotal: 4500,
    })

    const merchantNotify = natsPublish.mock.calls
      .map(c => c[0] as { to: string; channel: string; template?: { name: string } })
      .find(n => n.to === '+2348012345678')
    expect(merchantNotify).toBeDefined()
    expect(merchantNotify?.channel).toBe('whatsapp')
    expect(merchantNotify?.template?.name).toBe('mesa_new_order_v2')
  })

  it('skips a late duplicate delivery even after the merchant resolved the task', async () => {
    const { handler, natsPublish, db } = buildHandler()
    const merchant = await createMerchant(db, { phone: '+2348012345678' })
    const conv = await createConversation(db, merchant.id, { customerPhone: '+2348099998888' })
    const event = {
      subject: 'mesa.order.detected' as const,
      conversationId: conv.id,
      merchantId: merchant.id,
      customerPhone: conv.customerPhone,
      items: [{ productName: 'rice', quantity: 3, unitPrice: 5000 }],
      agreedTotal: 15000,
    }

    await handler.handleDetected(event)
    // Merchant accepts (task resolved) before the outbox/NATS copy arrives.
    await db.update(agentTasks).set({ status: 'DONE' }).where(eq(agentTasks.merchantId, merchant.id))
    await handler.handleDetected(event)

    const tasks = await db.query.agentTasks.findMany({
      where: eq(agentTasks.merchantId, merchant.id),
    })
    expect(tasks).toHaveLength(1)
    const merchantMessages = natsPublish.mock.calls
      .map(c => c[0] as { to?: string })
      .filter(m => m.to === '+2348012345678')
    expect(merchantMessages).toHaveLength(1)
  })

  it('uses the merchant confirmed total for the order item snapshot when catalog price differs', async () => {
    const { handler, db } = buildHandler()
    const merchant = await createMerchant(db, { phone: '+2348012345678' })
    await createProduct(db, merchant.id, { name: 'Plain Black Polo Shirt', price: '8500' })
    const conv = await createConversation(db, merchant.id, {
      customerPhone: '+2348099998888',
      context: {
        currentItems: [{ productName: 'Plain Black Polo Shirt', quantity: 1, unitPrice: 8500 }],
        negotiationHistory: [],
        lastMessageAt: new Date().toISOString(),
      },
    })

    await handler.handleConfirmed(merchant.id, conv.id, 20000)

    const [order] = await db.query.orders.findMany({
      where: eq(orders.conversationId, conv.id),
    })
    expect(order).toBeDefined()
    const items = await db.query.orderItems.findMany({
      where: eq(orderItems.orderId, order.id),
    })
    expect(items).toHaveLength(1)
    expect(parseFloat(items[0].agreedPrice)).toBe(20000)
  })
})
