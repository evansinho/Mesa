import type { Db } from '@mesa/db'
import { inventoryEvents, products, orderItems } from '@mesa/db'
import { eq, sql } from 'drizzle-orm'
import { InventoryUpdatedEvent, PaymentConfirmedEvent, SUBJECTS, InventoryLowEvent } from '@mesa/types'
import type { MesaNatsClient } from '@mesa/nats'

export class InventoryHandler {
  constructor(
    private db: Db,
    private nats: MesaNatsClient
  ) {}

  async handlePaymentConfirmed(event: PaymentConfirmedEvent): Promise<void> {
    // Placeholder: resolve items later; for now, no-op if no items
    const items = await this.db.query.orderItems.findMany({
      where: eq(orderItems.orderId, event.orderId),
    })

    for (const item of items) {
      const productId = item.productId
      if (!productId) continue

      const result = await this.db.transaction(async (tx) => {
        // Lock row for update
        const [row] = await tx
          .select({ id: products.id, stockQuantity: products.stockQuantity })
          .from(products)
          .where(eq(products.id, productId))
          .for('update')

        if (!row) return null

        const newQuantity = row.stockQuantity - item.quantity

        const [updated] = await tx
          .update(products)
          .set({ stockQuantity: newQuantity })
          .where(eq(products.id, productId))
          .returning({
            id: products.id,
            stockQuantity: products.stockQuantity,
            lowStockThreshold: products.lowStockThreshold,
          })

        await tx.insert(inventoryEvents).values({
          productId: updated.id,
          merchantId: event.merchantId,
          delta: -item.quantity,
          reason: 'SALE',
          orderId: event.orderId,
        })

        return updated
      })

      if (!result) continue

      const updatedEvent: InventoryUpdatedEvent = {
        subject: SUBJECTS.INVENTORY_UPDATED,
        productId: result.id,
        merchantId: event.merchantId,
        delta: -item.quantity,
        newQuantity: result.stockQuantity,
        orderId: event.orderId,
      }
      await this.nats.publish(updatedEvent)

      if (result.stockQuantity <= result.lowStockThreshold) {
        const lowEvent: InventoryLowEvent = {
          subject: SUBJECTS.INVENTORY_LOW,
          productId: result.id,
          merchantId: event.merchantId,
          newQuantity: result.stockQuantity,
        }
        await this.nats.publish(lowEvent)
      }
    }
  }
}
