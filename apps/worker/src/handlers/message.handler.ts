import { createHash } from 'crypto'
import type { Db } from '@mesa/db'
import { conversations, merchants, payments, products, merchantChannels } from '@mesa/db'
import type { MesaNatsClient } from '@mesa/nats'
import {
  InboundMessageEvent,
  OrderDetectedEvent,
  NotificationSendEvent,
  PaymentScreenshotReceivedEvent,
  SUBJECTS,
  ConversationState,
  ConversationContext,
  WhatsAppContactSyncEvent,
  WhatsAppHistorySyncEvent,
  WhatsAppMessageEchoEvent,
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

// Button payload values from WhatsApp template quick_reply buttons.
const KNOWN_BUTTON_PAYLOADS = new Set([
  'accept', 'edit_order', 'reject', 'confirm_payment', 'payment_not_yet', 'approve',
  'request_balance', 'mono_nudge_dismiss',
])

export function normalizeReply(text: string): string {
  return text.trim().toLowerCase().replace(/[.!?]+$/, '')
}

export function isYes(text: string): boolean {
  const n = normalizeReply(text)
  return YES_WORDS.has(n) || n === 'accept' || n === 'confirm_payment' || n === 'approve'
}

export function isNo(text: string): boolean {
  const n = normalizeReply(text)
  return NO_WORDS.has(n) || n === 'reject'
}

export function getButtonPayload(text: string): string | undefined {
  return KNOWN_BUTTON_PAYLOADS.has(text) ? text : undefined
}

function paymentRetryDelayMs(count: number): number | null {
  if (count <= 1) return 10 * 60 * 1000
  if (count === 2) return 30 * 60 * 1000
  if (count === 3) return 2 * 60 * 60 * 1000
  return null
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

// Bare greetings/acks that are never an order on their own. Only used to skip
// NLP when no deal is in flight — mid-negotiation, "ok"/"okay" are meaningful
// (agreement signals) so the state gate below excludes those states.
const NON_COMMERCE_WORDS = new Set([
  'hi', 'hello', 'hey', 'yo', 'thanks', 'thank you', 'ok', 'okay', 'k',
  'good morning', 'good afternoon', 'good evening', 'gm', 'ga', 'gn',
])

// States where we always run NLP because short words carry meaning there
// (e.g. "ok", "e don do", "send account" during a live negotiation).
const ACTIVE_DEAL_STATES = new Set<ConversationState>([
  'NEGOTIATING', 'AGREED', 'ORDER_CREATED', 'AWAITING_PAYMENT',
])

const MANUAL_REPLY_PAUSE_MS = 30 * 60 * 1000

function extractMentionedPrice(text: string): number | undefined {
  const match = text.match(/(?:₦|#)?\s*(\d+(?:[,.]\d+)?)(\s*[km])?/i)
  if (!match) return undefined
  const base = Number(match[1].replace(/,/g, ''))
  if (!Number.isFinite(base) || base <= 0) return undefined
  const suffix = match[2]?.trim().toLowerCase()
  if (suffix === 'k') return base * 1000
  if (suffix === 'm') return base * 1000000
  return base
}

// Cost gate before the Claude NLP call. Returns false for messages that
// cannot be commerce, so we skip the API call (and the products query) for
// them. Conservative by design — it only skips when BOTH the message looks
// non-commercial AND there is no active deal, so it can't drop a real order.
export function hasCommerceSignal(text: string, state: ConversationState): boolean {
  const normalized = text.trim().toLowerCase().replace(/[.!?]+$/, '')
  if (normalized.length === 0) return false
  // Mid-deal: always analyze. Short tokens and even an emoji thumbs-up can be
  // a meaningful confirmation while a negotiation/payment is in flight.
  if (ACTIVE_DEAL_STATES.has(state)) return true
  // Idle/browsing/complete: skip pure emoji/punctuation (no letters or digits)
  // and bare greetings — these can't be an order with no deal context.
  if (!/[a-z0-9]/i.test(normalized)) return false
  if (NON_COMMERCE_WORDS.has(normalized)) return false
  return true
}

function hasPendingDealContext(context: ConversationContext): boolean {
  return context.currentItems.length > 0 ||
    (context.lastQuotedPrice ?? 0) > 0 ||
    (context.agreedPrice ?? 0) > 0
}

export class MessageHandler {
  private stateMachine: ConversationStateMachine

  constructor(
    private db: Db,
    private redis: Redis,
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

  private async transitionOrUpdate(
    conv: Parameters<ConversationStateMachine['transition']>[0],
    to: ConversationState,
    contextUpdate: Partial<ConversationContext> = {},
  ): Promise<Parameters<ConversationStateMachine['transition']>[0]> {
    if (conv.state === to) {
      return this.stateMachine.updateContext(conv, contextUpdate)
    }
    return this.stateMachine.transition(conv, to, contextUpdate)
  }

  async handle(event: InboundMessageEvent): Promise<void> {
    const { merchantId, message } = event

    // Merchant confirmation replies (YES/NO/button payload) — merchant phone ≠ customer phone
    if (message.channel === 'whatsapp') {
      const merchant = await this.db.query.merchants.findFirst({
        where: eq(merchants.id, merchantId),
        columns: { phone: true },
      })

      const normalizePhone = (p: string) => { const d = p.replace(/\D/g, ''); const n = d.startsWith('234') ? d.slice(3) : d.replace(/^0/, ''); return `+234${n}` }
      if (merchant && normalizePhone(message.customerId) === normalizePhone(merchant.phone)) {

        // Handle unsupported message type (e.g. sticker, reaction) from the merchant.
        // If there's an open pending task, resend the action link as a text fallback.
        // message.type is typed as WhatsAppMessageType but the gateway may send 'unsupported'
        // for unknown types (sticker, reaction, etc.) at runtime.
        if ((message.type as string) === 'unsupported') {
          const openOrder = this.pending
            ? await this.pending.get<PendingOrderPayload>(merchantId, 'PENDING_ORDER_CONFIRMATION')
            : null
          const openPayment = this.pending
            ? await this.pending.get<PendingPaymentPayload>(merchantId, 'PENDING_PAYMENT_REVIEW')
            : null
          const openTask = openOrder ?? openPayment
          if (openTask && 'actionUrl' in openTask) {
            const actionUrl = (openTask as PendingOrderPayload & { actionUrl?: string }).actionUrl ?? ''
            await this.nats.publish({
              subject: SUBJECTS.NOTIFICATION_SEND,
              merchantId,
              to: merchant.phone,
              channel: 'whatsapp' as const,
              message: `We couldn't read your reply. Tap here to review: ${actionUrl}`,
            } satisfies NotificationSendEvent)
          }
          return
        }

        if (message.type !== 'text' || !message.text) return

        const text = message.text

        // Handle mono nudge dismiss — just acknowledge and drop (no state change).
        if (normalizeReply(text) === 'mono_nudge_dismiss') {
          console.info(JSON.stringify({
            level: 'info',
            msg: 'Mono nudge dismissed by merchant',
            merchantId,
          }))
          return
        }

        const pendingPayment = this.pending
          ? await this.pending.get<PendingPaymentPayload>(merchantId, 'PENDING_PAYMENT_REVIEW')
          : null
        if (pendingPayment) {
          if (normalizeReply(text) === 'payment_not_yet' || normalizeReply(text) === 'not yet') {
            const nextCount = (pendingPayment.notYetCount ?? 0) + 1
            const delay = paymentRetryDelayMs(nextCount)
            const now = new Date()
            await this.pending?.update<PendingPaymentPayload>(merchantId, 'PENDING_PAYMENT_REVIEW', {
              notYetCount: nextCount,
              lastNotYetAt: now.toISOString(),
              nextReminderAt: delay ? new Date(now.getTime() + delay).toISOString() : undefined,
              remindersStopped: !delay,
            })
            await this.nats.publish({
              subject: SUBJECTS.NOTIFICATION_SEND,
              merchantId,
              to: merchant.phone,
              channel: 'whatsapp' as const,
              message: delay
                ? 'Okay. Mesa will check with you again later.'
                : 'Okay. This payment will stay pending in Mesa until you confirm or dispute it.',
            } satisfies NotificationSendEvent)
            return
          }

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
          if (normalizeReply(text) === 'edit_order' || normalizeReply(text) === 'edit') {
            if (pendingOrder.actionToken) {
              await this.nats.publish({
                subject: SUBJECTS.NOTIFICATION_SEND,
                merchantId,
                to: merchant.phone,
                channel: 'whatsapp' as const,
                message: '',
                template: {
                  name: 'mesa_order_edit_link',
                  languageCode: 'en',
                  bodyParams: [],
                  buttons: [{ type: 'url', index: 0, urlSuffix: pendingOrder.actionToken }],
                },
              } satisfies NotificationSendEvent)
            } else if (pendingOrder.actionUrl) {
              await this.nats.publish({
                subject: SUBJECTS.NOTIFICATION_SEND,
                merchantId,
                to: merchant.phone,
                channel: 'whatsapp' as const,
                message: `Open this order page to edit before accepting: ${pendingOrder.actionUrl}`,
              } satisfies NotificationSendEvent)
            }
            return
          }

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

        await this.handleMerchantSelfService(merchantId, message.text, merchant.phone)
        return
      }
    }

    // Bot paused gate — skip all automated processing for customer messages
    const merchantConfig = await this.db.query.merchants.findFirst({
      where: eq(merchants.id, merchantId),
      columns: { config: true },
    })
    if ((merchantConfig?.config as Record<string, unknown> | null)?.paused === true) return

    if (await this.checkSubscriptionGate(merchantId)) return

    // Get or create conversation record
    const channel = message.channel
    const customerId = message.customerId
    const convId = await this.getOrCreateConversationId(merchantId, channel, customerId)
    let conv = await this.stateMachine.getOrCreate(merchantId, channel, customerId, convId)

    // Staleness reset: if the conversation has been in a non-terminal stuck
    // state for more than 4 hours with no activity, treat the next message as
    // a fresh start so old items never bleed into a new order.
    const STALE_MS = 4 * 60 * 60 * 1000
    const lastAt = conv.context.lastMessageAt ? new Date(conv.context.lastMessageAt).getTime() : 0
    const isStale = Date.now() - lastAt > STALE_MS
    const STUCK_STATES: ConversationState[] = ['NEGOTIATING', 'AGREED', 'ORDER_CREATED', 'AWAITING_PAYMENT']
    if (isStale && STUCK_STATES.includes(conv.state)) {
      conv = await this.stateMachine.transition(conv, 'IDLE', {
        currentItems: [],
        negotiationHistory: [],
        lastQuotedPrice: undefined,
        agreedPrice: undefined,
      })
    }

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
      await this.nats.publish({
        subject: SUBJECTS.NOTIFICATION_SEND,
        merchantId,
        to: message.customerId,
        channel: message.channel,
        message: "Got it! Your payment screenshot is being reviewed. We'll confirm shortly.",
      } satisfies NotificationSendEvent)
      return
    }

    if (message.type !== 'text' || !message.text) return

    const hasDealContext = hasPendingDealContext(conv.context)
    const commerceSignal = hasCommerceSignal(message.text, conv.state)

    if (
      conv.context.automationPausedUntil &&
      new Date(conv.context.automationPausedUntil) > new Date() &&
      !hasDealContext &&
      !commerceSignal
    ) {
      await this.stateMachine.appendMessage(conv, 'customer', message.text)
      return
    }

    // Cost gate: skip the Claude NLP call (and the products query below) for
    // messages that can't be commerce — empty, pure emoji/punctuation, or a
    // bare greeting while no deal is in flight. A chatty customer's "hi" /
    // "thanks" no longer each cost a Haiku call. Mid-deal states still run NLP.
    if (!hasDealContext && !commerceSignal) return

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
          const updated = await this.transitionOrUpdate(conv, 'NEGOTIATING', {
            currentItems: nlp.items,
            lastQuotedPrice: nlp.lastMentionedPrice,
          })

          if (nlp.agreementSignalDetected || nlp.intent === 'AGREEMENT') {
            // Direct order with no negotiation needed
            await this.handleAgreement(updated)
          }
        } else if (nlp.intent === 'COUNTER_OFFER' && nlp.counterOfferPrice) {
          const items = nlp.items.length > 0 ? nlp.items : conv.context.currentItems
          await this.transitionOrUpdate(conv, 'NEGOTIATING', {
            currentItems: items,
            lastQuotedPrice: nlp.counterOfferPrice,
          })
        } else if (nlp.intent === 'PAYMENT_INTENT' && nlp.lastMentionedPrice && nlp.lastMentionedPrice > 0) {
          // "Let me pay 20k for it" — price offer, not yet a completed payment
          const items = nlp.items.length > 0 ? nlp.items : conv.context.currentItems
          await this.transitionOrUpdate(conv, 'NEGOTIATING', {
            currentItems: items,
            lastQuotedPrice: nlp.lastMentionedPrice,
          })
        } else if ((nlp.agreementSignalDetected || nlp.intent === 'AGREEMENT') && conv.context.currentItems.length > 0) {
          // Customer agrees while in BROWSING (vendor replied manually, customer says "okay")
          const updated = await this.transitionOrUpdate(conv, 'NEGOTIATING', {
            currentItems: conv.context.currentItems,
            lastQuotedPrice: nlp.lastMentionedPrice ?? conv.context.lastQuotedPrice,
          })
          await this.handleAgreement(updated)
        } else if (nlp.intent === 'INQUIRY') {
          // Save any items the customer mentioned so later messages have context
          if (nlp.items.length > 0) {
            conv = await this.transitionOrUpdate(conv, 'BROWSING', { currentItems: nlp.items })
          }
          // Vendor handles the inquiry reply manually — Mesa doesn't auto-respond to inquiries
        }
        break
      }

      case 'NEGOTIATING': {
        if (nlp.agreementSignalDetected || nlp.intent === 'AGREEMENT') {
          // Capture any price mentioned in the agreement message (e.g. "Oya na, I go take am 12k")
          // before resolving, since lastQuotedPrice is only set on counter-offers, not vendor echoes.
          let convForAgreement = conv
          if (nlp.lastMentionedPrice && nlp.lastMentionedPrice > 0) {
            convForAgreement = await this.stateMachine.updateContext(conv, {
              lastQuotedPrice: nlp.lastMentionedPrice,
            })
          }
          await this.handleAgreement(convForAgreement)
        } else if (nlp.intent === 'ORDER' && nlp.items.length > 0) {
          // Customer adding more items to the current order (e.g. "also add 2 shoes").
          // Merge into existing context: update quantity for existing products, append new ones.
          const merged = [...conv.context.currentItems]
          for (const incoming of nlp.items) {
            const idx = merged.findIndex(
              i => i.productName.toLowerCase() === incoming.productName.toLowerCase()
            )
            if (idx >= 0) {
              merged[idx] = { ...merged[idx], quantity: merged[idx].quantity + incoming.quantity }
            } else {
              merged.push(incoming)
            }
          }
          conv = await this.transitionOrUpdate(conv, 'NEGOTIATING', {
            currentItems: merged,
            lastQuotedPrice: nlp.lastMentionedPrice ?? conv.context.lastQuotedPrice,
          })
        } else if (nlp.intent === 'COUNTER_OFFER' && nlp.counterOfferPrice) {
          // Update negotiation history
          await this.transitionOrUpdate(conv, 'NEGOTIATING', {
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
        } else if (nlp.intent === 'PAYMENT_INTENT' && nlp.lastMentionedPrice && nlp.lastMentionedPrice > 0) {
          // "Let me pay 20k for it" — treat price as the customer's agreed amount
          await this.transitionOrUpdate(conv, 'NEGOTIATING', {
            lastQuotedPrice: nlp.lastMentionedPrice,
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

  async handleMessageEcho(event: WhatsAppMessageEchoEvent): Promise<void> {
    const { merchantId, message } = event
    if (message.channel !== 'whatsapp') return
    if (message.type !== 'text' || !message.text) return

    const convId = await this.getOrCreateConversationId(merchantId, message.channel, message.customerId)
    let conv = await this.stateMachine.getOrCreate(merchantId, message.channel, message.customerId, convId)
    conv = await this.stateMachine.appendMessage(conv, 'vendor', message.text)

    const manualLastAt = new Date(Math.max(message.timestamp * 1000, Date.now())).toISOString()
    const quotedPrice = extractMentionedPrice(message.text)
    const isSalesContext =
      quotedPrice != null ||
      conv.context.currentItems.length > 0 ||
      ACTIVE_DEAL_STATES.has(conv.state)

    const contextUpdate: Partial<ConversationContext> = {
      manualLastAt,
    }
    if (quotedPrice != null) contextUpdate.lastQuotedPrice = quotedPrice
    if (!isSalesContext) {
      contextUpdate.automationPausedUntil = new Date(Date.now() + MANUAL_REPLY_PAUSE_MS).toISOString()
    }
    await this.stateMachine.updateContext(conv, contextUpdate)
  }

  async handleHistorySync(event: WhatsAppHistorySyncEvent): Promise<void> {
    const sorted = event.messages
      .filter(message => message.type === 'text' && message.text)
      .sort((a, b) => a.timestamp - b.timestamp)

    for (const message of sorted) {
      const convId = await this.getOrCreateConversationId(event.merchantId, message.channel, message.customerId)
      const conv = await this.stateMachine.getOrCreate(event.merchantId, message.channel, message.customerId, convId)
      await this.stateMachine.appendMessage(conv, message.direction === 'vendor' ? 'vendor' : 'customer', message.text!)
    }
  }

  async handleContactSync(event: WhatsAppContactSyncEvent): Promise<void> {
    // Mesa does not have a durable contacts table yet. Acknowledge contact sync
    // without creating orders/tasks; customer rows are created lazily when a
    // real conversation arrives.
    void event
  }

  private async checkSubscriptionGate(merchantId: string): Promise<boolean> {
    const cacheKey = `subscription_gate:${merchantId}`
    const cached = await this.redis.get(cacheKey)
    if (cached === 'active') return false
    if (cached === 'blocked') {
      await this.sendSubscriptionCta(merchantId)
      return true
    }

    const merchant = await this.db.query.merchants.findFirst({
      where: eq(merchants.id, merchantId),
      columns: { subscriptionStatus: true, trialEndsAt: true },
    })
    if (!merchant) return true

    const trialEndsAt = merchant.trialEndsAt ?? new Date(0)
    const allowed = merchant.subscriptionStatus === 'active'
      || (merchant.subscriptionStatus === 'trialing' && trialEndsAt > new Date())

    if (allowed) {
      await this.redis.set(cacheKey, 'active', 'EX', 300)
      return false
    }

    await this.redis.set(cacheKey, 'blocked', 'EX', 300)
    await this.sendSubscriptionCta(merchantId)
    return true
  }

  private async sendSubscriptionCta(merchantId: string): Promise<void> {
    const ctaKey = `subscription_cta_sent:${merchantId}`
    const sent = await this.redis.set(ctaKey, '1', 'EX', 3600, 'NX')
    if (sent !== 'OK') return

    const merchant = await this.db.query.merchants.findFirst({
      where: eq(merchants.id, merchantId),
      columns: { phone: true },
    })
    if (!merchant?.phone) return

    await this.nats.publish({
      subject: SUBJECTS.NOTIFICATION_SEND,
      merchantId,
      to: merchant.phone,
      channel: 'whatsapp' as const,
      message: `Your Mesa trial or subscription is inactive, so customer order automation is paused. Subscribe to reactivate:\n\n${appConfig.DASHBOARD_URL}/billing`,
    } satisfies NotificationSendEvent)
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

    // No price could be determined — still notify the merchant via the template
    // so they can review and set the price on the action page (shows "price TBD").
    // Drop only if we have no items at all (nothing useful to show).
    if (!agreedTotal || agreedTotal <= 0) {
      if (items.length === 0) return

      const agreed = await this.transitionOrUpdate(
        conv as Parameters<ConversationStateMachine['transition']>[0],
        'AGREED',
        { agreedPrice: 0 }
      )

      const orderEvent: OrderDetectedEvent = {
        subject: SUBJECTS.ORDER_DETECTED,
        conversationId: agreed.id,
        merchantId: agreed.merchantId,
        customerPhone: agreed.customerPhone,
        items: agreed.context.currentItems,
        agreedTotal: 0,
      }

      if (this.eventStore) {
        await this.eventStore.emit(orderEvent)
      } else {
        await this.nats.publish(orderEvent)
      }
      return
    }

    // Valid total — transition to AGREED and publish ORDER_DETECTED.
    const agreed = await this.transitionOrUpdate(
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
