import { eq } from 'drizzle-orm'
import { products, inventoryEvents, orderItems } from '@mesa/db'
import { InventoryHandler } from '../../src/handlers/inventory.handler'
import { getTestDb } from '@test-helpers/db'
import { setupIntegration } from '@test-helpers/integration-setup'
import { createMerchant, createOrder, createProduct } from '@test-helpers/factories'

setupIntegration()

function buildHandler() {
  const db = getTestDb()
  const natsPublish = jest.fn().mockResolvedValue(undefined)
  const nats = { publish: natsPublish } as never
  return { handler: new InventoryHandler(db, nats), natsPublish, db }
}

describe('InventoryHandler.handlePaymentConfirmed (integration)', () => {
  async function seedOrderWithItem(opts: {
    merchantId: string
    productId: string
    quantity: number
  }) {
    const db = getTestDb()
    const order = await createOrder(db, opts.merchantId)
    await db.insert(orderItems).values({
      orderId: order.id,
      productId: opts.productId,
      productName: 'rice',
      quantity: opts.quantity,
      unitPrice: '1000',
      agreedPrice: '1000',
    })
    return order
  }

  it('decrements product.stockQuantity by item quantity and writes an inventory_events row', async () => {
    const { handler, db } = buildHandler()
    const merchant = await createMerchant(db)
    const product = await createProduct(db, merchant.id, { stockQuantity: 50 })
    const order = await seedOrderWithItem({ merchantId: merchant.id, productId: product.id, quantity: 3 })

    await handler.handlePaymentConfirmed({
      subject: 'mesa.payment.confirmed',
      orderId: order.id,
      merchantId: merchant.id,
      amount: 3000,
    })

    const after = await db.query.products.findFirst({ where: eq(products.id, product.id) })
    expect(after?.stockQuantity).toBe(47)

    const events = await db.query.inventoryEvents.findMany({
      where: eq(inventoryEvents.productId, product.id),
    })
    expect(events).toHaveLength(1)
    expect(events[0].delta).toBe(-3)
    expect(events[0].reason).toBe('SALE')
  })

  it('publishes INVENTORY_LOW when stock drops to/below threshold', async () => {
    const { handler, natsPublish, db } = buildHandler()
    const merchant = await createMerchant(db)
    const product = await createProduct(db, merchant.id, { stockQuantity: 5, lowStockThreshold: 5 })
    const order = await seedOrderWithItem({ merchantId: merchant.id, productId: product.id, quantity: 1 })

    await handler.handlePaymentConfirmed({
      subject: 'mesa.payment.confirmed',
      orderId: order.id,
      merchantId: merchant.id,
      amount: 1000,
    })

    const subjects = natsPublish.mock.calls.map(c => (c[0] as { subject: string }).subject)
    expect(subjects).toContain('mesa.inventory.low')
  })

  it('does not publish INVENTORY_LOW when stock stays above threshold', async () => {
    const { handler, natsPublish, db } = buildHandler()
    const merchant = await createMerchant(db)
    const product = await createProduct(db, merchant.id, { stockQuantity: 50, lowStockThreshold: 5 })
    const order = await seedOrderWithItem({ merchantId: merchant.id, productId: product.id, quantity: 1 })

    await handler.handlePaymentConfirmed({
      subject: 'mesa.payment.confirmed',
      orderId: order.id,
      merchantId: merchant.id,
      amount: 1000,
    })

    const subjects = natsPublish.mock.calls.map(c => (c[0] as { subject: string }).subject)
    expect(subjects).not.toContain('mesa.inventory.low')
  })

  it('skips items with null productId without throwing', async () => {
    const { handler, db } = buildHandler()
    const merchant = await createMerchant(db)
    const order = await createOrder(db, merchant.id)
    await db.insert(orderItems).values({
      orderId: order.id,
      productId: null,
      productName: 'rice',
      quantity: 3,
      unitPrice: '1000',
      agreedPrice: '1000',
    })

    await expect(
      handler.handlePaymentConfirmed({
        subject: 'mesa.payment.confirmed',
        orderId: order.id,
        merchantId: merchant.id,
        amount: 3000,
      }),
    ).resolves.toBeUndefined()
  })

  it('serializes concurrent decrements via SELECT FOR UPDATE — no lost decrements', async () => {
    const { handler, db } = buildHandler()
    const merchant = await createMerchant(db)
    const product = await createProduct(db, merchant.id, { stockQuantity: 100 })

    // Three separate orders each decrementing by 5. With FOR UPDATE the final
    // stock must be exactly 100 - 15 = 85, with three inventory_events rows.
    const orders = await Promise.all(
      Array.from({ length: 3 }, () =>
        seedOrderWithItem({ merchantId: merchant.id, productId: product.id, quantity: 5 }),
      ),
    )

    await Promise.all(
      orders.map(o =>
        handler.handlePaymentConfirmed({
          subject: 'mesa.payment.confirmed',
          orderId: o.id,
          merchantId: merchant.id,
          amount: 5000,
        }),
      ),
    )

    const after = await db.query.products.findFirst({ where: eq(products.id, product.id) })
    expect(after?.stockQuantity).toBe(85)

    const events = await db.query.inventoryEvents.findMany({
      where: eq(inventoryEvents.productId, product.id),
    })
    expect(events).toHaveLength(3)
  })
})