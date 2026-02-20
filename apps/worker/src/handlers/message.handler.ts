import { randomUUID } from 'crypto'
import type { Db } from '@mesa/db'
import { conversations } from '@mesa/db'
import type { MesaNatsClient } from '@mesa/nats'
import {
  WhatsAppInboundEvent,
  OrderDetectedEvent,
  NotificationSendEvent,
  SUBJECTS,
} from '@mesa/types'
import { analyseMessage } from '@mesa/ai'
import { ConversationStateMachine } from '../conversation/state-machine'
import type { Redis } from 'ioredis'
import { eq, and } from 'drizzle-orm'

export class MessageHandler {
  private stateMachine: ConversationStateMachine

  constructor(
    private db: Db,
    private redis: Redis,
    private nats: MesaNatsClient
  ) {
    this.stateMachine = new ConversationStateMachine(redis, db)
  }

  async handle(event: WhatsAppInboundEvent): Promise<void> {
    const { merchantId, message } = event

    // Get or create conversation record
    const convId = await this.getOrCreateConversationId(merchantId, message.from)
    const conv = await this.stateMachine.getOrCreate(merchantId, message.from, convId)

    // Images in AWAITING_PAYMENT state → payment handler picks it up
    if (message.type === 'image' && conv.state === 'AWAITING_PAYMENT') {
      // Publish to payment handler — don't process here
      return
    }

    if (message.type !== 'text' || !message.text) return

    // Build conversation history for NLP context
    const history = conv.context.negotiationHistory.map(h => ({
      role: h.from as 'vendor' | 'customer',
      text: `price discussed: ₦${h.price}`,
    }))

    const nlp = await analyseMessage(message.text, history)

    switch (conv.state) {
      case 'IDLE':
      case 'BROWSING': {
        if (nlp.intent === 'ORDER' && nlp.items.length > 0) {
          const updated = await this.stateMachine.transition(conv, 'NEGOTIATING', {
            currentItems: nlp.items,
            lastQuotedPrice: nlp.lastMentionedPrice,
          })

          if (nlp.agreementSignalDetected) {
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
        if (nlp.agreementSignalDetected) {
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
        if (nlp.intent !== 'NONE') {
          await this.stateMachine.transition(conv, 'IDLE')
          await this.stateMachine.transition(
            { ...conv, state: 'IDLE' },
            'BROWSING'
          )
        }
        break
      }

      default:
        break
    }
  }

  private async handleAgreement(conv: {
    id: string
    merchantId: string
    customerPhone: string
    state: typeof conv.state
    context: typeof conv.context
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