import { randomUUID, createHash } from 'crypto'
import type { Db } from '@mesa/db'
import { conversations, merchants, payments } from '@mesa/db'
import type { MesaNatsClient } from '@mesa/nats'
import {
  WhatsAppInboundEvent,
  OrderDetectedEvent,
  NotificationSendEvent,
  PaymentScreenshotReceivedEvent,
  SUBJECTS,
  ConversationState,
  ConversationContext,
} from '@mesa/types'
import { analyseMessage } from '@mesa/ai'
import { downloadMedia } from '@mesa/whatsapp'
import { uploadScreenshot } from '../storage/r2'
import { ConversationStateMachine } from '../conversation/state-machine'
import type { Redis } from 'ioredis'
import { eq, and } from 'drizzle-orm'
import type { OrderHandler } from './order.handler'

export class MessageHandler {
  private stateMachine: ConversationStateMachine

  constructor(
    private db: Db,
    private redis: Redis,
    private nats: MesaNatsClient,
    private eventStore?: {
      append: (aggregateId: string, aggregateType: string, eventType: string, payload: Record<string, unknown>) => Promise<void>
      appendOnce: (aggregateId: string, aggregateType: string, eventType: string, payload: Record<string, unknown>) => Promise<boolean>
    },
    private orderHandler?: OrderHandler
  ) {
    this.stateMachine = new ConversationStateMachine(redis, db)
  }

  async handle(event: WhatsAppInboundEvent): Promise<void> {
    const { merchantId, message } = event

    // Merchant confirmation replies (YES) — merchant phone ≠ customer phone
    if (message.type === 'text' && message.text) {
      const merchant = await this.db.query.merchants.findFirst({
        where: eq(merchants.id, merchantId),
        columns: { phone: true },
      })

      if (merchant && message.from === merchant.phone) {
        const paymentRaw = await this.redis.get(`pending_payment_by_merchant:${merchantId}`)
        if (paymentRaw) {
          const pending = JSON.parse(paymentRaw) as { orderId: string }
          const text = message.text.trim().toUpperCase()
          if (text === 'YES') {
            const payment = await this.db.query.payments.findFirst({
              where: eq(payments.orderId, pending.orderId),
              orderBy: (p, { desc }) => [desc(p.createdAt)],
            })
            if (payment) {
              await this.db.update(payments)
                .set({ status: 'CONFIRMED', confirmedAt: new Date() })
                .where(eq(payments.id, payment.id))
              await this.nats.publish({
                subject: SUBJECTS.PAYMENT_CONFIRMED,
                orderId: pending.orderId,
                merchantId,
                amount: payment.amount ? parseFloat(payment.amount) : 0,
              })
            }
          } else if (text === 'NO') {
            const payment = await this.db.query.payments.findFirst({
              where: eq(payments.orderId, pending.orderId),
              orderBy: (p, { desc }) => [desc(p.createdAt)],
            })
            if (payment) {
              await this.db.update(payments)
                .set({ status: 'DISPUTED' })
                .where(eq(payments.id, payment.id))
            }
          }
          await this.redis.del(`pending_payment_by_merchant:${merchantId}`)
          return
        }

        const pendingRaw = await this.redis.get(`pending_order_by_merchant:${merchantId}`)
        if (!pendingRaw) return

        const pending = JSON.parse(pendingRaw) as { conversationId: string; agreedTotal?: number }
        const text = message.text.trim().toUpperCase()
        if (text === 'YES' && this.orderHandler) {
          await this.orderHandler.handleConfirmed(
            merchantId,
            pending.conversationId,
            pending.agreedTotal ?? 0
          )
        }
        const numeric = Number(text.replace(/[^0-9.]/g, ''))
        if (!Number.isNaN(numeric) && numeric > 0 && this.orderHandler) {
          await this.orderHandler.handleConfirmed(
            merchantId,
            pending.conversationId,
            numeric
          )
        }
        return
      }
    }

    // Get or create conversation record
    const convId = await this.getOrCreateConversationId(merchantId, message.from)
    const conv = await this.stateMachine.getOrCreate(merchantId, message.from, convId)

    // Images in AWAITING_PAYMENT state → payment handler picks it up
    if (message.type === 'image' && conv.state === 'AWAITING_PAYMENT') {
      if (!message.mediaId) return

      const { buffer, mimeType } = await downloadMedia(message.mediaId)
      const screenshotUrl = await uploadScreenshot(buffer, mimeType)
      const screenshotHash = createHash('sha256').update(buffer).digest('hex')

      const orderId = (conv.context.orderId as string | undefined)
      if (!orderId) return

      const event: PaymentScreenshotReceivedEvent = {
        subject: SUBJECTS.PAYMENT_SCREENSHOT_RECEIVED,
        orderId,
        merchantId,
        screenshotUrl,
        screenshotHash,
      }
      await this.nats.publish(event)
      return
    }

    if (message.type !== 'text' || !message.text) return

    // Build conversation history for NLP context
    const history = conv.context.negotiationHistory.map(h => ({
      role: h.from as 'vendor' | 'customer',
      text: `price discussed: ₦${h.price}`,
    }))

    const nlp = await analyseMessage(message.text, history)

    if (nlp.intent === 'NONE') return

    switch (conv.state) {
      case 'IDLE':
      case 'BROWSING': {
        if ((nlp.intent === 'ORDER' || nlp.intent === 'AGREEMENT') && nlp.items.length > 0) {
          const updated = await this.stateMachine.transition(conv, 'NEGOTIATING', {
            currentItems: nlp.items,
            lastQuotedPrice: nlp.lastMentionedPrice,
          })

          if (nlp.agreementSignalDetected || nlp.intent === 'AGREEMENT') {
            // Direct order with no negotiation needed
            await this.handleAgreement(updated)
          }
        } else if (nlp.intent === 'INQUIRY') {
          await this.stateMachine.transition(conv, 'BROWSING')
          // Vendor handles the inquiry reply manually — Mesa doesn't auto-respond to inquiries
        }
        break
      }

      case 'NEGOTIATING': {
        if (nlp.agreementSignalDetected || nlp.intent === 'AGREEMENT') {
          await this.handleAgreement(conv)
        } else if (nlp.intent === 'COUNTER_OFFER' && nlp.counterOfferPrice) {
          // Update negotiation history
          await this.stateMachine.transition(conv, 'NEGOTIATING', {
            negotiationHistory: [
              ...conv.context.negotiationHistory,
              {
                price: nlp.counterOfferPrice,
                from: 'customer',
                timestamp: new Date().toISOString(),
              },
            ],
            lastQuotedPrice: nlp.counterOfferPrice,
          })
        }
        break
      }

      case 'AGREED': {
        // Customer might be re-opening negotiation after agreement
        if (nlp.intent === 'COUNTER_OFFER') {
          await this.stateMachine.transition(conv, 'NEGOTIATING', {
            negotiationHistory: [
              ...conv.context.negotiationHistory,
              {
                price: nlp.counterOfferPrice!,
                from: 'customer',
                timestamp: new Date().toISOString(),
              },
            ],
          })
        }
        break
      }

      case 'COMPLETE':
      case 'PAYMENT_RECEIVED': {
        // New message after completion → start fresh browsing
        await this.stateMachine.transition(conv, 'IDLE')
        await this.stateMachine.transition(
          { ...conv, state: 'IDLE' },
          'BROWSING'
        )
        break
      }

      default:
        break
    }
  }

  async markOrderCreated(conversationId: string, orderId: string): Promise<void> {
    const record = await this.db.query.conversations.findFirst({
      where: eq(conversations.id, conversationId),
    })
    if (!record) return

    const conv = await this.stateMachine.getOrCreate(
      record.merchantId,
      record.customerPhone,
      record.id
    )
    await this.stateMachine.transition(conv, 'ORDER_CREATED', { orderId })
  }

  async markAwaitingPayment(conversationId: string, orderId: string): Promise<void> {
    const record = await this.db.query.conversations.findFirst({
      where: eq(conversations.id, conversationId),
    })
    if (!record) return

    const conv = await this.stateMachine.getOrCreate(
      record.merchantId,
      record.customerPhone,
      record.id
    )
    await this.stateMachine.transition(conv, 'AWAITING_PAYMENT', { orderId })
  }

  private async handleAgreement(conv: {
    id: string
    merchantId: string
    customerPhone: string
    state: ConversationState
    context: ConversationContext
  }): Promise<void> {
    const agreed = await this.stateMachine.transition(conv as Parameters<ConversationStateMachine['transition']>[0], 'AGREED')

    const agreedTotal = agreed.context.agreedPrice ??
      agreed.context.lastQuotedPrice ??
      agreed.context.currentItems.reduce((sum, item) => sum + (item.unitPrice ?? 0) * item.quantity, 0)

    // Publish order detected — worker's order handler sends vendor confirmation
    const orderEvent: OrderDetectedEvent = {
      subject: SUBJECTS.ORDER_DETECTED,
      conversationId: agreed.id,
      merchantId: agreed.merchantId,
      customerPhone: agreed.customerPhone,
      items: agreed.context.currentItems,
      agreedTotal,
    }

    await this.nats.publish(orderEvent)
    if (this.eventStore) {
      await this.eventStore.appendOnce(agreed.id, 'conversation', 'ORDER_DETECTED', {
        merchantId: agreed.merchantId,
        customerPhone: agreed.customerPhone,
        items: agreed.context.currentItems,
        agreedTotal,
      })
    }
  }

  private async getOrCreateConversationId(
    merchantId: string,
    customerPhone: string
  ): Promise<string> {
    const existing = await this.db.query.conversations.findFirst({
      where: and(
        eq(conversations.merchantId, merchantId),
        eq(conversations.customerPhone, customerPhone)
      ),
    })

    if (existing) return existing.id

    const [created] = await this.db
      .insert(conversations)
      .values({ merchantId, customerPhone, state: 'IDLE' })
      .returning({ id: conversations.id })

    return created.id
  }
}
