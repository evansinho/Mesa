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
import { notifyMerchantOnSourceChannel } from './notify-merchant'

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

    // ORDER_DETECTED is at-least-once and can be redelivered out of order — a
    // stale snapshot from earlier in the negotiation (fewer items, an old
    // price) can arrive after the conversation has already been confirmed
    // into a real order. The fingerprint check below only catches an exact
    // repeat of the LATEST snapshot, not an older one, so guard separately:
    // once this conversation has an order, no detection event for it — stale
    // or fresh — should resurrect a merchant confirmation card.
    const existingConv = await this.db.query.conversations.findFirst({
      where: eq(conversations.id, conversationId),
      columns: { context: true },
    })
    if ((existingConv?.context as Record<string, unknown> | undefined)?.orderId) {
      this.log.info(JSON.stringify({
        level: 'info',
        msg: 'Stale order detection skipped — conversation already has an order',
        merchantId,
        conversationId,
      }))
      return
    }

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

    // Single line — WhatsApp template params reject newlines (error 132018),
    // which used to kill the tap for every multi-item order.
    let itemSummary = items
      .map(i => `${i.quantity}x ${i.productName}${i.unitPrice ? ` — ₦${i.unitPrice.toLocaleString()}` : ''}`)
      .join(', ') || '(items pending — see dashboard)'
    // The upsert below replaces a still-open confirmation for this merchant —
    // mark the card so the merchant knows it supersedes the previous one.
    if (latestTask?.status === 'OPEN') itemSummary = `UPDATED ORDER — ${itemSummary}`
    if (itemSummary.length > 280) itemSummary = itemSummary.slice(0, 277) + '...'

    const merchant = await this.db.query.merchants.findFirst({
      where: eq(merchants.id, merchantId),
      columns: { phone: true },
    })
    if (!merchant) return

    const conv = await this.db.query.conversations.findFirst({
      where: eq(conversations.id, conversationId),
      columns: { channel: true },
    })

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

    await notifyMerchantOnSourceChannel(this.db, this.nats, {
      merchantId,
      sourceChannel: conv?.channel ?? 'whatsapp',
      actionUrl,
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
    }, this.log)
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

    // A vendor confirmation (WhatsApp quick-reply tap or a redelivered
    // "Accept"/corrected-total message) can reach this handler more than
    // once for the same conversation — NATS is at-least-once, and the
    // conversation lock only prevents concurrent execution, not sequential
    // duplicate deliveries. context.orderId is set the moment an order is
    // created below, so a second call for the same still-open order is a
    // duplicate, not a new purchase — skip it rather than double-billing.
    // forceResetToIdle clears orderId on a genuine fresh transaction, so a
    // real second order from a returning customer is unaffected.
    if (context.orderId) {
      this.log.warn(JSON.stringify({
        level: 'warn',
        msg: 'Duplicate order confirmation ignored — conversation already has an order',
        merchantId,
        conversationId,
        existingOrderId: context.orderId,
      }))
      return
    }
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
    const anyPriced = itemBases.some(value => value > 0)
    const confirmedItems = currentItems.map((item, index) => {
      if (currentItems.length === 1) return { ...item, agreedPrice: vendorConfirmedTotal }
      if (anyPriced) {
        // Snapshot the prices that were actually discussed — never prorate the
        // vendor's corrected total into invented per-item figures (a customer
        // reading "Jogger Pants — ₦28,202" will dispute a number nobody said).
        // The order total stands on its own.
        return { ...item, agreedPrice: itemBases[index] }
      }
      // No prices known at all — even split as a last resort.
      return { ...item, agreedPrice: Math.round(vendorConfirmedTotal / currentItems.length) }
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
