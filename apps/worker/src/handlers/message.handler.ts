import { randomUUID, createHash } from 'crypto'
import type { Db } from '@mesa/db'
import { conversations, merchants, payments, products, agentTasks, messageTemplates, merchantChannels } from '@mesa/db'
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
import { analyseMessage, type KnownProduct } from '@mesa/ai'
import { downloadMedia } from '@mesa/whatsapp'
import { uploadScreenshot } from '../storage/r2'
import { ConversationStateMachine } from '../conversation/state-machine'
import type { Redis } from 'ioredis'
import { eq, and } from 'drizzle-orm'
import type { OrderHandler } from './order.handler'
import { config as appConfig } from '@mesa/config'
import type { PendingDecisions, PendingOrderPayload, PendingPaymentPayload } from './pending-decisions'
import type { AiQuota, SubscriptionTier } from '../ai/quota'

const YES_WORDS = new Set(['yes', 'y', 'ok', 'okay', 'sure', 'confirm', 'confirmed'])
const NO_WORDS = new Set(['no', 'n', 'cancel', 'reject', 'dispute'])

export function normalizeReply(text: string): string {
  return text.trim().toLowerCase().replace(/[.!?]+$/, '')
}

export function isYes(text: string): boolean {
  return YES_WORDS.has(normalizeReply(text))
}

export function isNo(text: string): boolean {
  return NO_WORDS.has(normalizeReply(text))
}

// Parse a merchant price reply. Accepts only messages whose entire body is a
// number (optionally with a ₦/#/$ prefix, a "PRICE " prefix, or commas).
// "CONFIRM <number>" forces acceptance past the sanity check.
//
// Examples accepted: "5000", "5,000", "₦5000", "PRICE 5000", "CONFIRM ₦5,000"
// Examples rejected: "tomorrow at 3pm", "send 5000 later", "YES 5000"
export function parsePriceReply(text: string): { value: number; forced: boolean } | null {
  let body = text.trim()
  const forced = /^confirm\s+/i.test(body)
  body = body
    .replace(/^confirm\s+/i, '')
    .replace(/^price\s+/i, '')
    .replace(/^[₦#$]\s*/, '')
    .replace(/,/g, '')
  if (!/^\d+(\.\d+)?$/.test(body)) return null
  const n = parseFloat(body)
  if (!Number.isFinite(n) || n <= 0) return null
  return { value: n, forced }
}

// A merchant override is "reasonable" when it's within 10x of the detected
// total. Outside that window we ask the merchant to type CONFIRM <amount>.
export function priceWithinReasonableRange(override: number, detected: number): boolean {
  if (!detected || detected <= 0) return true
  const ratio = override / detected
  return ratio >= 0.1 && ratio <= 10
}

export class MessageHandler {
  private stateMachine: ConversationStateMachine

  constructor(
    private db: Db,
    redis: Redis,
    private nats: MesaNatsClient,
    private eventStore?: {
      append: (aggregateId: string, aggregateType: string, eventType: string, payload: Record<string, unknown>) => Promise<void>
      appendOnce: (aggregateId: string, aggregateType: string, eventType: string, payload: Record<string, unknown>) => Promise<boolean>
      emit: <E extends { subject: string }>(event: E) => Promise<void>
    },
    private orderHandler?: OrderHandler,
    private pending?: PendingDecisions,
    private aiQuota?: AiQuota
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

      const normalizePhone = (p: string) => { const d = p.replace(/\D/g, ''); const n = d.startsWith('234') ? d.slice(3) : d.replace(/^0/, ''); return `+234${n}` }
      if (merchant && normalizePhone(message.customerId) === normalizePhone(merchant.phone)) {
        const text = message.text

        const pendingPayment = this.pending
          ? await this.pending.get<PendingPaymentPayload>(merchantId, 'PENDING_PAYMENT_REVIEW')
          : null
        if (pendingPayment) {
          if (isYes(text)) {
            const payment = await this.db.query.payments.findFirst({
              where: eq(payments.orderId, pendingPayment.orderId),
              orderBy: (p, { desc }) => [desc(p.createdAt)],
            })
            if (payment) {
              await this.db.update(payments)
                .set({ status: 'CONFIRMED', confirmedAt: new Date() })
                .where(eq(payments.id, payment.id))
              const confirmedEvent = {
                subject: SUBJECTS.PAYMENT_CONFIRMED,
                orderId: pendingPayment.orderId,
                merchantId,
                amount: payment.amount ? parseFloat(payment.amount) : 0,
              }
              if (this.eventStore) {
                await this.eventStore.emit(confirmedEvent)
              } else {
                await this.nats.publish(confirmedEvent)
              }
            }
            if (this.pending) await this.pending.resolve(merchantId, 'PENDING_PAYMENT_REVIEW', 'DONE')
            return
          }

          if (isNo(text)) {
            const payment = await this.db.query.payments.findFirst({
              where: eq(payments.orderId, pendingPayment.orderId),
              orderBy: (p, { desc }) => [desc(p.createdAt)],
            })
            if (payment) {
              await this.db.update(payments)
                .set({ status: 'DISPUTED' })
                .where(eq(payments.id, payment.id))
            }
            if (this.pending) await this.pending.resolve(merchantId, 'PENDING_PAYMENT_REVIEW', 'CANCELLED')
            return
          }

          // Unrecognized reply during a pending payment review — leave the
          // pending state intact so the merchant can still YES/NO it later.
          return
        }

        const pendingOrder = this.pending
          ? await this.pending.get<PendingOrderPayload>(merchantId, 'PENDING_ORDER_CONFIRMATION')
          : null
        if (pendingOrder) {
          if (isYes(text) && this.orderHandler) {
            await this.orderHandler.handleConfirmed(
              merchantId,
              pendingOrder.conversationId,
              pendingOrder.agreedTotal ?? 0
            )
            if (this.pending) await this.pending.resolve(merchantId, 'PENDING_ORDER_CONFIRMATION', 'DONE')
            return
          }

          if (isNo(text)) {
            if (this.pending) await this.pending.resolve(merchantId, 'PENDING_ORDER_CONFIRMATION', 'CANCELLED')
            await this.nats.publish({
              subject: SUBJECTS.NOTIFICATION_SEND,
              merchantId,
              to: merchant.phone,
              channel: 'whatsapp' as const,
              message: 'Order cancelled.',
            } satisfies NotificationSendEvent)
            return
          }

          const priceReply = parsePriceReply(text)
          if (priceReply && this.orderHandler) {
            const detected = pendingOrder.agreedTotal ?? 0
            const reasonable = priceWithinReasonableRange(priceReply.value, detected)

            if (reasonable || priceReply.forced) {
              await this.orderHandler.handleConfirmed(
                merchantId,
                pendingOrder.conversationId,
                priceReply.value
              )
              if (this.pending) await this.pending.resolve(merchantId, 'PENDING_ORDER_CONFIRMATION', 'DONE')
              return
            }

            // Override is wildly out of range — require explicit CONFIRM.
            const direction = priceReply.value < detected ? 'low' : 'high'
            await this.nats.publish({
              subject: SUBJECTS.NOTIFICATION_SEND,
              merchantId,
              to: merchant.phone,
              channel: 'whatsapp' as const,
              message: `₦${priceReply.value.toLocaleString()} looks unusually ${direction} for this order (detected ₦${detected.toLocaleString()}). Reply CONFIRM ${priceReply.value} to use this price anyway, or send a different amount.`,
            } satisfies NotificationSendEvent)
            return
          }

          // Unrecognized merchant reply — leave pending state intact.
          return
        }

        const handledOnboarding = await this.handleMerchantOnboarding(merchantId, message.text)
        if (handledOnboarding) return
        await this.handleMerchantSelfService(merchantId, message.text, merchant.phone)
        return
      }
    }

    // Get or create conversation record
    const channel = message.channel
    const customerId = message.customerId
    const convId = await this.getOrCreateConversationId(merchantId, channel, customerId)
    let conv = await this.stateMachine.getOrCreate(merchantId, channel, customerId, convId)

    // Images in AWAITING_PAYMENT state → payment handler picks it up
    if (message.type === 'image' && conv.state === 'AWAITING_PAYMENT') {
      if (message.channel !== 'whatsapp') return
      if (!message.mediaId) return

      const merchantChannel = await this.db.query.merchantChannels.findFirst({
        where: and(eq(merchantChannels.merchantId, merchantId), eq(merchantChannels.channel, 'whatsapp')),
        columns: { accessToken: true },
      })
      const { buffer, mimeType } = await downloadMedia(message.mediaId, merchantChannel?.accessToken ?? undefined)
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
      if (this.eventStore) {
        await this.eventStore.emit(event)
      } else {
        await this.nats.publish(event)
      }
      return
    }

    if (message.type !== 'text' || !message.text) return

    // Build conversation history for NLP context. Use the rolling
    // recent-messages buffer (raw text) rather than the price-only
    // negotiationHistory — Pidgin / negotiation nuance requires the full
    // exchange, not a sequence of numbers.
    const history = (conv.context.recentMessages ?? []).map(m => ({
      role: m.role as 'vendor' | 'customer',
      text: m.text,
    }))

    // Fetch merchant's known products to boost NLP accuracy
    const merchantProducts = await this.db.query.products.findMany({
      where: and(eq(products.merchantId, merchantId), eq(products.active, true)),
    })
    const knownProducts: KnownProduct[] = merchantProducts.map(p => ({
      name: p.name,
      aliases: (p as unknown as { aliases: string[] }).aliases ?? [],
      unit: p.unit,
      price: p.price ? parseFloat(p.price) : undefined,
    }))

    // Per-merchant AI quota: bounds spend and traps misbehaving customers.
    // If exhausted, send the merchant a one-shot notification and drop this
    // message from automated processing (manual handling required until reset).
    if (this.aiQuota) {
      const merchantRow = await this.db.query.merchants.findFirst({
        where: eq(merchants.id, merchantId),
        columns: { phone: true, subscriptionTier: true },
      })
      const tier = (merchantRow?.subscriptionTier as SubscriptionTier | undefined) ?? 'starter'
      const quota = await this.aiQuota.checkAndConsume(merchantId, tier)
      if (!quota.allowed) {
        if (merchantRow && (await this.aiQuota.shouldNotifyExhaustion(merchantId))) {
          await this.nats.publish({
            subject: SUBJECTS.NOTIFICATION_SEND,
            merchantId,
            to: merchantRow.phone,
            channel: 'whatsapp' as const,
            message: `Daily AI processing limit reached (${quota.limit}/day). Incoming customer messages will require manual handling until midnight. Upgrade your plan for a higher limit.`,
          } satisfies NotificationSendEvent)
        }
        return
      }
    }

    const nlp = await analyseMessage(message.text, history, knownProducts)
    if (this.aiQuota) await this.aiQuota.recordUsage(merchantId, 'haiku')

    // Persist the current message in the rolling buffer so the next NLP call
    // for this conversation has it as context. Capture the returned record
    // so subsequent state transitions don't overwrite the appended buffer
    // with stale context.
    conv = await this.stateMachine.appendMessage(conv, 'customer', message.text)

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
        if (nlp.intent === 'COUNTER_OFFER') {
          // Customer re-opening negotiation after agreement
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
        } else if (nlp.intent === 'ORDER' || nlp.intent === 'AGREEMENT') {
          // Customer re-confirming or ordering again after merchant went quiet — re-trigger
          await this.handleAgreement(conv)
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
        await notify(`Open this link to connect Mono: ${appConfig.DASHBOARD_URL}/onboarding/mono`)
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

  private async handleMerchantSelfService(merchantId: string, text: string, merchantPhone: string): Promise<void> {
    const normalized = text.trim()
    const lower = normalized.toLowerCase()

    const notify = async (msg: string) => {
      await this.nats.publish({
        subject: SUBJECTS.NOTIFICATION_SEND,
        merchantId,
        to: merchantPhone,
        channel: 'whatsapp' as const,
        message: msg,
      } satisfies NotificationSendEvent)
    }

    // check stock / inventory
    if (lower.includes('stock') || lower.includes('inventory') || lower.includes('how many')) {
      const allProducts = await this.db.query.products.findMany({
        where: and(eq(products.merchantId, merchantId), eq(products.active, true)),
      })
      if (allProducts.length === 0) {
        await notify('No products yet. Send "add [name] - ₦[price]" to add one.')
        return
      }
      const lines = allProducts.map(p => {
        const low = p.stockQuantity <= p.lowStockThreshold ? ' ⚠️' : ''
        return `• ${p.name}: ${p.stockQuantity} ${p.unit}${low}`
      })
      await notify(`Stock levels:\n${lines.join('\n')}`)
      return
    }

    // add product: "add garri - ₦800"
    if (lower.startsWith('add')) {
      const withoutCmd = normalized.replace(/^add\s+/i, '').trim()
      if (!withoutCmd) {
        await notify('Format: add [product name] - ₦[price]\nExample: add Garri - ₦800')
        return
      }
      const items = this.parseProductLines(withoutCmd)
      if (items.length === 0) {
        await notify('Format: add [product name] - ₦[price]\nExample: add Garri - ₦800')
        return
      }
      for (const item of items) {
        const existing = await this.db.query.products.findFirst({
          where: and(eq(products.merchantId, merchantId), eq(products.name, item.name)),
        })
        if (existing) {
          await this.db.update(products)
            .set({ price: item.price.toString(), updatedAt: new Date() })
            .where(eq(products.id, existing.id))
          await notify(`Updated ${item.name} → ₦${item.price.toLocaleString()}`)
        } else {
          await this.db.insert(products).values({
            merchantId,
            name: item.name,
            price: item.price.toString(),
            unit: item.unit,
            stockQuantity: 0,
          })
          await notify(`Added ${item.name} at ₦${item.price.toLocaleString()}`)
        }
      }
      return
    }

    // update price: "update rice to ₦45000" or "change garri price - ₦900"
    if (lower.includes('update') || lower.includes('change') || lower.includes('price')) {
      // try "product - price" format after stripping the command word
      const stripped = normalized.replace(/^(update|change|set)\s+/i, '')
      const items = this.parseProductLines(stripped)
      if (items.length > 0) {
        for (const item of items) {
          const existing = await this.db.query.products.findFirst({
            where: and(eq(products.merchantId, merchantId), eq(products.name, item.name)),
          })
          if (existing) {
            await this.db.update(products)
              .set({ price: item.price.toString(), updatedAt: new Date() })
              .where(eq(products.id, existing.id))
            await notify(`Updated ${item.name} → ₦${item.price.toLocaleString()}`)
          } else {
            await notify(`"${item.name}" not found. Check the name and try again.`)
          }
        }
        return
      }
      // "update [name] to ₦[price]" pattern
      const toMatch = normalized.match(/^(?:update|change|set)\s+(.+?)\s+(?:to|at|price)\s+[₦#]?\s*([\d,.]+)/i)
      if (toMatch) {
        const productName = toMatch[1].trim()
        const price = parseFloat(toMatch[2].replace(/,/g, ''))
        const existing = await this.db.query.products.findFirst({
          where: and(eq(products.merchantId, merchantId), eq(products.name, productName)),
        })
        if (existing) {
          await this.db.update(products)
            .set({ price: price.toString(), updatedAt: new Date() })
            .where(eq(products.id, existing.id))
          await notify(`Updated ${productName} → ₦${price.toLocaleString()}`)
        } else {
          await notify(`"${productName}" not found. Check the name and try again.`)
        }
        return
      }
      await notify('Format: update [product name] to ₦[price]\nExample: update Garri to ₦900')
      return
    }

    // fallback help
    await notify(
      'Mesa commands:\n• "check stock" — see all stock levels\n• "add [name] - ₦[price]" — add a product\n• "update [name] to ₦[price]" — update price'
    )
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
    const items = conv.context.currentItems

    // Resolve the agreed total in priority order:
    //   1. explicit agreedPrice on context
    //   2. lastQuotedPrice (e.g. "₦42k final" before "okay deal")
    //   3. NLP-extracted unitPrice × quantity sum
    //   4. catalog price × quantity sum from products
    let agreedTotal = conv.context.agreedPrice
      ?? conv.context.lastQuotedPrice
      ?? items.reduce((sum, item) => sum + (item.unitPrice ?? 0) * item.quantity, 0)

    if ((!agreedTotal || agreedTotal <= 0) && items.length > 0) {
      let computed = 0
      for (const item of items) {
        let price = item.unitPrice
        if (!price || price <= 0) {
          const product = await this.db.query.products.findFirst({
            where: and(
              eq(products.merchantId, conv.merchantId),
              eq(products.active, true),
              eq(products.name, item.productName)
            ),
          })
          if (product?.price) {
            price = parseFloat(product.price)
          }
        }
        if (!price || price <= 0) {
          computed = 0
          break
        }
        computed += price * item.quantity
      }
      agreedTotal = computed
    }

    // No price could be determined. Don't create a ₦0 order — ask the merchant.
    if (!agreedTotal || agreedTotal <= 0) {
      if (conv.state === 'AGREED') {
        // AGREED → NEGOTIATING is permitted; restart the negotiation cleanly.
        await this.stateMachine.transition(
          conv as Parameters<ConversationStateMachine['transition']>[0],
          'NEGOTIATING'
        )
      }
      // If already NEGOTIATING, no transition (NEGOTIATING → NEGOTIATING is invalid).

      const merchant = await this.db.query.merchants.findFirst({
        where: eq(merchants.id, conv.merchantId),
        columns: { phone: true },
      })
      if (merchant) {
        const itemSummary = items.length > 0
          ? items.map(i => `${i.quantity}x ${i.productName}`).join(', ')
          : '(no items extracted)'
        const message = items.length > 0
          ? `Order from ${conv.customerPhone}: ${itemSummary}. No price detected — reply with the agreed amount (e.g. "5000").`
          : `Possible order from ${conv.customerPhone}, but no items detected. Please reply with what they want and the price.`
        const notify: NotificationSendEvent = {
          subject: SUBJECTS.NOTIFICATION_SEND,
          merchantId: conv.merchantId,
          to: merchant.phone,
          channel: 'whatsapp',
          message,
        }
        await this.nats.publish(notify)
      }
      return
    }

    // Valid total — transition to AGREED and publish ORDER_DETECTED.
    const agreed = await this.stateMachine.transition(
      conv as Parameters<ConversationStateMachine['transition']>[0],
      'AGREED',
      { agreedPrice: agreedTotal }
    )

    const orderEvent: OrderDetectedEvent = {
      subject: SUBJECTS.ORDER_DETECTED,
      conversationId: agreed.id,
      merchantId: agreed.merchantId,
      customerPhone: agreed.customerPhone,
      items: agreed.context.currentItems,
      agreedTotal,
    }

    if (this.eventStore) {
      await this.eventStore.emit(orderEvent)
    } else {
      await this.nats.publish(orderEvent)
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
