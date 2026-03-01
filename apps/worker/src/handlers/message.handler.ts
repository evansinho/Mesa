import { randomUUID, createHash } from 'crypto'
import type { Db } from '@mesa/db'
import { conversations, merchants, merchantChannels, payments, products, agentTasks, messageTemplates } from '@mesa/db'
import type { MesaNatsClient } from '@mesa/nats'
import {
  InboundMessageEvent,
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
import { config as appConfig } from '@mesa/config'

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

  async handle(event: InboundMessageEvent): Promise<void> {
    const { merchantId, message } = event

    // Merchant confirmation replies (YES) — merchant phone ≠ customer phone
    if (message.channel === 'whatsapp' && message.type === 'text' && message.text) {
      const merchant = await this.db.query.merchants.findFirst({
        where: eq(merchants.id, merchantId),
        columns: { phone: true },
      })

      const normalizePhone = (p: string) => p.replace(/\D/g, '').replace(/^0/, '234')
      if (merchant && normalizePhone(message.customerId) === normalizePhone(merchant.phone)) {
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
        if (pendingRaw) {
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

        const handledOnboarding = await this.handleMerchantOnboarding(merchantId, message.text)
        if (handledOnboarding) return
        return
      }
    }

    // Get or create conversation record
    const channel = message.channel
    const customerId = message.customerId
    const convId = await this.getOrCreateConversationId(merchantId, channel, customerId)
    const conv = await this.stateMachine.getOrCreate(merchantId, channel, customerId, convId)

    // Images in AWAITING_PAYMENT state → payment handler picks it up
    if (message.type === 'image' && conv.state === 'AWAITING_PAYMENT') {
      if (message.channel !== 'whatsapp') return
      if (!message.mediaId) return

      const waChannel = await this.db.query.merchantChannels.findFirst({
        where: and(
          eq(merchantChannels.merchantId, merchantId),
          eq(merchantChannels.channel, 'whatsapp')
        ),
        columns: { d360ApiKey: true },
      })
      const { buffer, mimeType } = await downloadMedia(message.mediaId, waChannel?.d360ApiKey ?? undefined)
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
      record.channel,
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
      record.channel,
      record.customerPhone,
      record.id
    )
    await this.stateMachine.transition(conv, 'AWAITING_PAYMENT', { orderId })
  }

  private async handleMerchantOnboarding(merchantId: string, text: string): Promise<boolean> {
    const merchant = await this.db.query.merchants.findFirst({
      where: eq(merchants.id, merchantId),
    })
    if (!merchant) return false

    const config = (merchant.config ?? {}) as Record<string, unknown>
    const onboarding = (config.onboarding ?? {}) as Record<string, unknown>
    const status = (onboarding.status as string | undefined) ?? 'incomplete'
    if (status === 'complete') return false

    const step = (onboarding.step as string | undefined) ?? 'BUSINESS_NAME'
    const normalized = text.trim()
    const upper = normalized.toUpperCase()

    const notify = async (message: string) => {
      const event: NotificationSendEvent = {
        subject: SUBJECTS.NOTIFICATION_SEND,
        merchantId,
        to: merchant.phone,
        channel: 'whatsapp',
        message,
      }
      await this.nats.publish(event)
    }

    if (step === 'BUSINESS_NAME') {
      if (normalized.length < 2) {
        await notify('Please send your business name.')
        return true
      }
      await this.db.update(merchants).set({
        name: normalized,
        config: {
          ...config,
          onboarding: {
            ...onboarding,
            step: 'PRODUCTS',
            status: 'incomplete',
          },
        },
        updatedAt: new Date(),
      }).where(eq(merchants.id, merchantId))
      await notify('Great. Now send your product list, one per line. Example: "Garri - ₦800".')
      return true
    }

    if (step === 'PRODUCTS') {
      const items = this.parseProductLines(normalized)
      if (items.length === 0) {
        await notify('Please send products like: "Garri - ₦800" (one per line).')
        return true
      }

      for (const item of items) {
        const existing = await this.db.query.products.findFirst({
          where: and(eq(products.merchantId, merchantId), eq(products.name, item.name)),
        })

        if (existing) {
          await this.db.update(products).set({
            price: item.price.toString(),
            unit: item.unit,
            updatedAt: new Date(),
          }).where(eq(products.id, existing.id))
        } else {
          await this.db.insert(products).values({
            merchantId,
            name: item.name,
            price: item.price.toString(),
            unit: item.unit,
            stockQuantity: 0,
          })
        }
      }

      await this.db.update(merchants).set({
        config: {
          ...config,
          onboarding: {
            ...onboarding,
            step: 'BANK',
            status: 'incomplete',
            productsCount: items.length,
          },
        },
        updatedAt: new Date(),
      }).where(eq(merchants.id, merchantId))
      await notify('Send bank details in this format: Bank Name | Account Number | Account Name')
      return true
    }

    if (step === 'BANK') {
      const parts = normalized.split('|').map(p => p.trim()).filter(Boolean)
      const accountNumberMatch = normalized.replace(/\s/g, '').match(/\d{10}/)
      if (!accountNumberMatch || parts.length < 2) {
        await notify('Please send bank details as: Bank Name | Account Number | Account Name')
        return true
      }
      const bankName = parts[0]
      const accountNumber = accountNumberMatch[0]

      try {
        const resolved = await this.resolvePaystackAccount(bankName, accountNumber)
        await this.db.update(merchants).set({
          config: {
            ...config,
            onboarding: {
              ...onboarding,
              step: 'BANK_CONFIRM',
              status: 'incomplete',
              bankPending: {
                bankName,
                accountNumber,
                accountName: resolved.accountName,
                bankCode: resolved.bankCode,
              },
            },
          },
          updatedAt: new Date(),
        }).where(eq(merchants.id, merchantId))

        await notify(`We found "${resolved.accountName}" at ${bankName}. Reply YES to confirm or NO to re-enter.`)
      } catch (err) {
        await notify('We could not verify that account. Please check the bank name and account number and try again.')
      }
      return true
    }

    if (step === 'BANK_CONFIRM') {
      const pending = (onboarding.bankPending ?? {}) as Record<string, string>
      if (upper === 'NO') {
        await this.db.update(merchants).set({
          config: {
            ...config,
            onboarding: {
              ...onboarding,
              step: 'BANK',
              status: 'incomplete',
              bankPending: undefined,
            },
          },
          updatedAt: new Date(),
        }).where(eq(merchants.id, merchantId))
        await notify('Okay. Send bank details again: Bank Name | Account Number | Account Name')
        return true
      }

      if (upper === 'YES' && pending.accountNumber && pending.accountName && pending.bankName) {
        await this.db.update(merchants).set({
          config: {
            ...config,
            bankAccount: {
              bankName: pending.bankName,
              accountNumber: pending.accountNumber,
              accountName: pending.accountName,
            },
            onboarding: {
              ...onboarding,
              step: 'MONO',
              status: 'incomplete',
              bankPending: undefined,
            },
          },
          updatedAt: new Date(),
        }).where(eq(merchants.id, merchantId))
        await notify('Connect your bank via Mono? Reply YES to continue or SKIP to finish without it.')
        return true
      }

      await notify('Reply YES to confirm the account name or NO to re-enter.')
      return true
    }

    if (step === 'MONO') {
      if (upper === 'SKIP') {
        await this.db.update(merchants).set({
          config: {
            ...config,
            onboarding: {
              ...onboarding,
              step: 'DONE',
              status: 'complete',
              mono: 'skipped',
            },
          },
          updatedAt: new Date(),
        }).where(eq(merchants.id, merchantId))
        await this.createOnboardingSuccessTask(merchantId, merchant.phone)
        await notify('Onboarding complete. You can now receive orders.')
        return true
      }

      if (upper === 'YES') {
        await this.db.update(merchants).set({
          config: {
            ...config,
            onboarding: {
              ...onboarding,
              step: 'DONE',
              status: 'complete',
              mono: 'pending',
            },
          },
          updatedAt: new Date(),
        }).where(eq(merchants.id, merchantId))
        await notify('Open this link to connect Mono: http://localhost:3000/onboarding/mono')
        await this.createOnboardingSuccessTask(merchantId, merchant.phone)
        await notify('Onboarding complete. You can now receive orders.')
        return true
      }

      await notify('Reply YES to connect Mono or SKIP to finish without it.')
      return true
    }

    return false
  }

  private async createOnboardingSuccessTask(merchantId: string, merchantPhone: string) {
    await this.db.insert(agentTasks).values({
      merchantId,
      type: 'ONBOARDING_FOLLOWUP',
      status: 'OPEN',
      payload: {
        merchantPhone,
        reason: 'onboarding_complete',
      },
    })

    const existing = await this.db.query.messageTemplates.findFirst({
      where: and(
        eq(messageTemplates.merchantId, merchantId),
        eq(messageTemplates.name, 'onboarding_success_followup')
      ),
    })
    if (!existing) {
      await this.db.insert(messageTemplates).values({
        merchantId,
        name: 'onboarding_success_followup',
        channel: 'whatsapp',
        body: 'Hi {{merchantName}}, welcome to Mesa! Reply if you need help setting up products or inventory.',
      })
    }
  }

  private parseProductLines(input: string): Array<{ name: string; price: number; unit: string }> {
    const lines = input.split('\n').map(l => l.trim()).filter(Boolean)
    const results: Array<{ name: string; price: number; unit: string }> = []

    for (const line of lines) {
      const parts = line.split(/[-–—:]/).map(p => p.trim()).filter(Boolean)
      if (parts.length < 2) continue
      const name = parts[0]
      const priceRaw = parts.slice(1).join(' ')
      const priceNum = Number(priceRaw.replace(/[^0-9.]/g, ''))
      if (!name || Number.isNaN(priceNum) || priceNum <= 0) continue
      results.push({ name, price: priceNum, unit: 'unit' })
    }

    return results
  }

  private async resolvePaystackAccount(bankName: string, accountNumber: string): Promise<{ accountName: string; bankCode: string }> {
    const banksRes = await fetch('https://api.paystack.co/bank?country=nigeria', {
      headers: {
        Authorization: `Bearer ${appConfig.PAYSTACK_SECRET_KEY}`,
      },
    })
    if (!banksRes.ok) {
      throw new Error('Paystack bank list failed')
    }
    const banksData = await banksRes.json() as { data?: Array<{ name: string; code: string }> }
    const bank = banksData.data?.find(b => b.name.toLowerCase() === bankName.toLowerCase())
      ?? banksData.data?.find(b => b.name.toLowerCase().includes(bankName.toLowerCase()))
    if (!bank) {
      throw new Error('Bank not found')
    }

    const resolveUrl = new URL('https://api.paystack.co/bank/resolve')
    resolveUrl.searchParams.set('account_number', accountNumber)
    resolveUrl.searchParams.set('bank_code', bank.code)

    const resolveRes = await fetch(resolveUrl.toString(), {
      headers: {
        Authorization: `Bearer ${appConfig.PAYSTACK_SECRET_KEY}`,
      },
    })
    const resolveText = await resolveRes.text()
    if (!resolveRes.ok) {
      throw new Error(`Resolve failed: ${resolveText}`)
    }
    const resolveData = JSON.parse(resolveText) as { data?: { account_name?: string } }
    const accountName = resolveData.data?.account_name
    if (!accountName) {
      throw new Error('No account name returned')
    }

    return { accountName, bankCode: bank.code }
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
    channel: string,
    customerPhone: string
  ): Promise<string> {
    const existing = await this.db.query.conversations.findFirst({
      where: and(
        eq(conversations.merchantId, merchantId),
        eq(conversations.channel, channel),
        eq(conversations.customerPhone, customerPhone)
      ),
    })

    if (existing) return existing.id

    const [created] = await this.db
      .insert(conversations)
      .values({ merchantId, channel, customerPhone, state: 'IDLE' })
      .returning({ id: conversations.id })

    return created.id
  }
}
