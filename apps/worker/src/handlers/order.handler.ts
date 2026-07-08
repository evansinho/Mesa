import { randomBytes, createHash } from 'crypto'
import type { Db } from '@mesa/db'
import { orders, orderItems, products, conversations, merchants, agentTasks } from '@mesa/db'
import type { MesaNatsClient } from '@mesa/nats'
import { OrderDetectedEvent, OrderConfirmedEvent, SUBJECTS, NotificationSendEvent, type ConversationContext } from '@mesa/types'
import { eq, and, sql } from 'drizzle-orm'
import type { Redis } from 'ioredis'
import type { PendingDecisions, PendingOrderPayload } from './pending-decisions'
import { config } from '@mesa/config'
import { ordersConfirmed } from '../metrics'
import { contextWithLedger, normalizeLedger } from '../conversation/commerce-ledger'

function orderFingerprint(input: {
  conversationId: string
  customerPhone: string
  agreedTotal: number
  items: Array<{ productName: string; quantity: number; unitPrice?: number }>
}): string {
  const normalizedItems = input.items.map(item => ({
    productName: item.productName.trim().toLowerCase(),
    quantity: item.quantity,
    unitPrice: item.unitPrice ?? null,
  }))
  return createHash('sha256').update(JSON.stringify({
    conversationId: input.conversationId,
    customerPhone: input.customerPhone.trim(),
    agreedTotal: input.agreedTotal,
    items: normalizedItems,
  })).digest('hex')
}

export class OrderHandler {
  constructor(
    private db: Db,
    private nats: MesaNatsClient,
    private log: Pick<Console, 'info' | 'warn' | 'error'> = console,
    private redis?: Redis,
    private eventStore?: {
      append: (aggregateId: string, aggregateType: string, eventType: string, payload: Record<string, unknown>) => Promise<void>
      appendOnce: (aggregateId: string, aggregateType: string, eventType: string, payload: Record<string, unknown>) => Promise<boolean>
      emit: <E extends { subject: string }>(event: E) => Promise<void>
    },
    private pending?: PendingDecisions
  ) {}

  // Called when NLP detects an order agreement
  // Sends vendor a confirmation tap before creating the order
  async handleDetected(event: OrderDetectedEvent): Promise<void> {
    const { conversationId, merchantId, customerPhone, items, agreedTotal } = event

    // Dedupe against the latest task in ANY status, not just OPEN. This event
    // arrives twice by design (direct call for an instant tap + outbox/NATS
    // delivery); if the merchant accepts before the second delivery, an
    // OPEN-only check would resurrect the task and swallow later replies.
    const eventFingerprint = orderFingerprint({ conversationId, customerPhone, agreedTotal: agreedTotal ?? 0, items })
    const latestTask = await this.db.query.agentTasks.findFirst({
      where: and(
        eq(agentTasks.merchantId, merchantId),
        eq(agentTasks.type, 'PENDING_ORDER_CONFIRMATION'),
      ),
      orderBy: (t, { desc }) => [desc(t.createdAt)],
    })
    const latestPayload = latestTask?.payload as unknown as PendingOrderPayload | undefined
    const isRecent = latestTask?.createdAt
      ? Date.now() - new Date(latestTask.createdAt).getTime() < 60 * 60 * 1000
      : false
    if (
      latestPayload?.conversationId === conversationId &&
      latestPayload.customerPhone === customerPhone &&
      (latestTask?.status === 'OPEN' || isRecent) &&
      eventFingerprint === orderFingerprint({
        conversationId: latestPayload.conversationId,
        customerPhone: latestPayload.customerPhone,
        agreedTotal: latestPayload.agreedTotal,
        items: latestPayload.items,
      })
    ) {
      this.log.info(JSON.stringify({
        level: 'info',
        msg: 'Duplicate order detection skipped',
        merchantId,
        customerPhone,
        conversationId,
        agreedTotal,
        priorTaskStatus: latestTask?.status,
      }))
      return
    }

    // Generate a signed action token for the dashboard action page
    const token = randomBytes(32).toString('hex')
    const tokenHash = createHash('sha256').update(token).digest('hex')
    const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000) // 24h

    const actionUrl = `${config.DASHBOARD_URL}/actions/order/${token}`

    let itemSummary = items
      .map(i => `${i.quantity}x ${i.productName}${i.unitPrice ? ` — ₦${i.unitPrice.toLocaleString()}` : ''}`)
      .join('\n')
    if (itemSummary.length > 280) itemSummary = itemSummary.slice(0, 277) + '...'

    const merchant = await this.db.query.merchants.findFirst({
      where: eq(merchants.id, merchantId),
      columns: { phone: true },
    })
    if (!merchant) return

    // Durably record the pending decision so it survives a Redis blip and the
    // merchant has 24h (not 10min) to reply.
    if (this.pending) {
      const taskId = await this.pending.upsert(merchantId, 'PENDING_ORDER_CONFIRMATION', {
        conversationId,
        customerPhone,
        items,
        agreedTotal: agreedTotal ?? 0,
        prompt: actionUrl,
        actionToken: token,
        actionUrl,
      })

      // Attach the token hash + expiry to the specific upserted task row
      await this.db.update(agentTasks)
        .set({ actionTokenHash: tokenHash, expiresAt })
        .where(eq(agentTasks.id, taskId))
    }

    const notify: NotificationSendEvent = {
      subject: SUBJECTS.NOTIFICATION_SEND,
      merchantId,
      to: merchant.phone,
      channel: 'whatsapp',
      message: '',
      template: {
        name: 'mesa_new_order_v2',
        languageCode: 'en',
        bodyParams: [
          event.customerName ?? customerPhone,
          itemSummary,
          agreedTotal ? `₦${agreedTotal.toLocaleString()}` : 'price TBD',
        ],
        buttons: [
          { type: 'quick_reply' as const, index: 0, payload: 'accept' },
          { type: 'quick_reply' as const, index: 1, payload: 'reject' },
        ],
      },
    }
    await this.nats.publish(notify)
    this.log.info(JSON.stringify({
      level: 'info',
      msg: 'Order detected — vendor confirmation tap',
      merchantId,
      customerPhone,
      conversationId,
      itemSummary,
      agreedTotal,
    }))
  }

  // Called when vendor replies YES (or corrects the price)
  async handleConfirmed(
    merchantId: string,
    conversationId: string,
    vendorConfirmedTotal: number
  ): Promise<void> {
    // Reject non-positive totals here rather than letting the DB CHECK fire.
    // A bad total reaching this handler typically means the NLP layer
    // couldn't extract a price and the merchant's reply didn't carry one.
    if (!Number.isFinite(vendorConfirmedTotal) || vendorConfirmedTotal <= 0) {
      const merchant = await this.db.query.merchants.findFirst({
        where: eq(merchants.id, merchantId),
        columns: { phone: true },
      })
      if (merchant) {
        const notify: NotificationSendEvent = {
          subject: SUBJECTS.NOTIFICATION_SEND,
          merchantId,
          to: merchant.phone,
          channel: 'whatsapp',
          message: `Cannot create order with no price. Reply with the agreed amount (e.g. "5000").`,
        }
        await this.nats.publish(notify)
      }
      this.log.warn(JSON.stringify({
        level: 'warn',
        msg: 'Order rejected — non-positive total',
        merchantId,
        conversationId,
        vendorConfirmedTotal,
      }))
      return
    }

    const conv = await this.db.query.conversations.findFirst({
      where: eq(conversations.id, conversationId),
    })
    if (!conv) return

    // Resolve products by name — in production, use fuzzy matching
    const context = conv.context as Record<string, unknown>
    const currentItems = (context.currentItems ?? []) as Array<{
      productId?: string
      productName: string
      quantity: number
      unitPrice?: number
      agreedPrice?: number
    }>
    const itemBases = currentItems.map(item => {
      const unitPrice = item.unitPrice ?? 0
      const agreedPrice = item.agreedPrice ?? 0
      return (agreedPrice > 0 ? agreedPrice : unitPrice) * item.quantity
    })
    const baseTotal = itemBases.reduce((sum, value) => sum + value, 0)
    let allocatedSoFar = 0
    const confirmedItems = currentItems.map((item, index) => {
      const allocated = currentItems.length === 1
        ? vendorConfirmedTotal
        : baseTotal > 0 && index < currentItems.length - 1
          ? Math.round((vendorConfirmedTotal * itemBases[index]) / baseTotal)
          : vendorConfirmedTotal - allocatedSoFar
      allocatedSoFar += allocated
      return { ...item, agreedPrice: allocated }
    })

    const merchantProducts = await this.db.query.products.findMany({
      where: eq(products.merchantId, merchantId),
    })
    const findProduct = (item: { productId?: string; productName: string }) => {
      if (item.productId) {
        const byId = merchantProducts.find(p => p.id === item.productId)
        if (byId) return byId
      }
      const target = item.productName.toLowerCase()
      return merchantProducts.find(p =>
        p.name.toLowerCase() === target ||
        ((p as unknown as { aliases: string[] }).aliases ?? []).some(alias => alias.toLowerCase() === target)
      )
    }

    // Upsert product aliases — if customer used a different name, learn it
    for (const item of currentItems) {
      const product = merchantProducts.find(p => p.name === item.productName)
      if (!product) {
        // Customer used an alias — find the closest product and add the alias
        const match = merchantProducts.find(p =>
          (p as unknown as { aliases: string[] }).aliases?.includes(item.productName) ||
          p.name.toLowerCase() === item.productName.toLowerCase()
        )
        if (!match) {
          // Unknown product — just skip alias learning for now
          continue
        }
        const existingAliases: string[] = (match as unknown as { aliases: string[] }).aliases ?? []
        if (!existingAliases.includes(item.productName)) {
          await this.db.update(products)
            .set({ aliases: sql`array_append(aliases, ${item.productName})`, updatedAt: new Date() })
            .where(eq(products.id, match.id))
        }
      }
    }

    // Create the order
    const [order] = await this.db
      .insert(orders)
      .values({
        merchantId,
        conversationId,
        customerPhone: conv.customerPhone,
        customerName: conv.customerName ?? undefined,
        status: 'CONFIRMED',
        subtotal: vendorConfirmedTotal.toString(),
        total: vendorConfirmedTotal.toString(),
      })
      .returning({ id: orders.id })

    ordersConfirmed.add(1)

    // Create order items
    for (const item of confirmedItems) {
      const product = findProduct(item)
      await this.db.insert(orderItems).values({
        orderId: order.id,
        productId: product?.id,
        productName: item.productName,
        quantity: item.quantity,
        unitPrice: (item.unitPrice ?? (product?.price ? parseFloat(product.price) : 0)).toString(),
        agreedPrice: (item.agreedPrice ?? item.unitPrice ?? (product?.price ? parseFloat(product.price) : 0)).toString(),
      })
    }

    const hydratedContext = {
      currentItems: confirmedItems,
      negotiationHistory: [],
      lastMessageAt: new Date().toISOString(),
      ...context,
    } as ConversationContext
    const ledger = normalizeLedger(hydratedContext, conv.customerPhone)
    const updatedContext = contextWithLedger({
      ...hydratedContext,
      agreedPrice: vendorConfirmedTotal,
      orderId: order.id,
      awaitingOrderConfirmation: false,
    }, {
      ...ledger,
      draftOrder: {
        ...ledger.draftOrder,
        status: 'merchant_confirmed',
        orderId: order.id,
        total: vendorConfirmedTotal,
      },
    })
    await this.db.update(conversations)
      .set({
        state: 'ORDER_CREATED',
        context: updatedContext as unknown as Record<string, unknown>,
        updatedAt: new Date(),
      })
      .where(eq(conversations.id, conversationId))

    const confirmedEvent: OrderConfirmedEvent = {
      subject: SUBJECTS.ORDER_CONFIRMED,
      orderId: order.id,
      merchantId,
      conversationId,
    }
    if (this.eventStore) {
      await this.eventStore.emit(confirmedEvent)
    } else {
      await this.nats.publish(confirmedEvent)
    }

    this.log.info(JSON.stringify({
      level: 'info',
      msg: 'Order created',
      orderId: order.id,
      merchantId,
      customerPhone: conv.customerPhone,
      conversationId,
    }))
  }
}
