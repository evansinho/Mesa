import { createHash, randomBytes } from 'crypto'
import type { Db } from '@mesa/db'
import { agentTasks, conversations, merchants, orders, payments, products, merchantChannels } from '@mesa/db'
import type { MesaNatsClient } from '@mesa/nats'
import {
  InboundMessageEvent,
  OrderDetectedEvent,
  NotificationSendEvent,
  PaymentScreenshotReceivedEvent,
  SUBJECTS,
  ConversationState,
  ConversationContext,
  DetectedOrderItem,
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
import type { PendingDecisions, PendingFulfilmentPayload, PendingOrderPayload, PendingPaymentPayload } from './pending-decisions'
import type { AiQuota, SubscriptionTier } from '../ai/quota'
import type { FulfilmentHandler } from './fulfilment.handler'

const YES_WORDS = new Set(['yes', 'y', 'ok', 'okay', 'sure', 'confirm', 'confirmed', 'paid'])
const NO_WORDS = new Set(['no', 'n', 'cancel', 'reject', 'dispute'])

// Button payload values from WhatsApp template quick_reply buttons.
const KNOWN_BUTTON_PAYLOADS = new Set([
  'accept', 'edit_order', 'reject', 'confirm_payment', 'payment_not_yet', 'approve',
  'request_balance', 'mono_nudge_dismiss', 'payment_dispute', 'link',
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
  return NO_WORDS.has(n) || n === 'reject' || n === 'payment_dispute'
}

export function getButtonPayload(text: string): string | undefined {
  return KNOWN_BUTTON_PAYLOADS.has(text) ? text : undefined
}

function isLastPriceQuestion(text: string): boolean {
  const n = normalizeReply(text)
  return /\b(last price|final price|last)\b/.test(n)
}

function isPaymentDetailsRequest(text: string): boolean {
  const n = normalizeReply(text)
  return /\b(acc|account|bank|payment|pay)\b/.test(n)
    && /\b(detail|details|number|account|send|give|how|make|pay)\b/.test(n)
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

export function parseOrderCorrection(text: string): { items: DetectedOrderItem[]; total: number } | null {
  const [rawItems, rawTotal, ...rest] = text.split('=')
  if (!rawItems || !rawTotal || rest.length > 0) return null

  const total = Number(rawTotal.replace(/[^0-9.]/g, ''))
  if (!Number.isFinite(total) || total <= 0) return null

  const items = rawItems
    .split(/[,;\n]+/)
    .map(part => part.trim())
    .filter(Boolean)
    .map(part => {
      const match = part.match(/^(\d+(?:\.\d+)?)\s*x\s+(.+)$/i)
      if (!match) return null
      const quantity = Number(match[1])
      const productName = match[2].trim()
      if (!Number.isFinite(quantity) || quantity <= 0 || !productName) return null
      return { productName, quantity } satisfies DetectedOrderItem
    })

  if (!items.length || items.some(item => item == null)) return null
  return { items: items as DetectedOrderItem[], total }
}

// A merchant override is "reasonable" when it's within 10x of the detected
// total. Outside that window we ask the merchant to type CONFIRM <amount>.
export function priceWithinReasonableRange(override: number, detected: number): boolean {
  if (!detected || detected <= 0) return true
  const ratio = override / detected
  return ratio >= 0.1 && ratio <= 10
}

function normalizePhone(p: string): string {
  const digits = p.replace(/\D/g, '')
  const local = digits.startsWith('234') ? digits.slice(3) : digits.replace(/^0/, '')
  return `+234${local}`
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
const STALE_MS = 4 * 60 * 60 * 1000
const STUCK_STATES: ConversationState[] = ['NEGOTIATING', 'AGREED', 'ORDER_CREATED', 'AWAITING_PAYMENT']

type MerchantBotConfig = {
  enabled?: boolean
  tone?: string
  language?: string
  handoffMessage?: string
}

type ProductRow = typeof products.$inferSelect
type CatalogItem = DetectedOrderItem & {
  productId: string
  productName: string
  quantity: number
  unitPrice: number
  floorUnitPrice: number
}

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
    private aiQuota?: AiQuota,
    private fulfilmentHandler?: FulfilmentHandler
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

  private async resetIfStale(
    conv: Parameters<ConversationStateMachine['transition']>[0],
  ): Promise<Parameters<ConversationStateMachine['transition']>[0]> {
    const lastAt = conv.context.lastMessageAt ? new Date(conv.context.lastMessageAt).getTime() : 0
    const isStale = Date.now() - lastAt > STALE_MS
    if (!isStale || !STUCK_STATES.includes(conv.state)) return conv

    return this.stateMachine.transition(conv, 'IDLE', {
      currentItems: [],
      negotiationHistory: [],
      recentMessages: [],
      lastQuotedPrice: undefined,
      minimumAcceptableTotal: undefined,
      agreedPrice: undefined,
      awaitingOrderConfirmation: false,
      orderId: undefined,
      recentBotReply: undefined,
      manualLastAt: undefined,
      automationPausedUntil: undefined,
    })
  }

  async handle(event: InboundMessageEvent): Promise<void> {
    const { merchantId, message } = event

    // Merchant confirmation replies (YES/NO/button payload) — merchant phone ≠ customer phone
    if (message.channel === 'whatsapp') {
      const merchant = await this.db.query.merchants.findFirst({
        where: eq(merchants.id, merchantId),
        columns: { phone: true },
      })

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
            const actionUrl = (openTask as (PendingOrderPayload | PendingPaymentPayload) & { actionUrl?: string }).actionUrl ?? ''
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

        await this.handleMerchantReply(merchantId, message.text, merchant.phone)
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
    conv = await this.resetIfStale(conv)

    // Payment proofs can arrive as WhatsApp images or documents/PDFs.
    if ((message.type === 'image' || message.type === 'document') && conv.state === 'AWAITING_PAYMENT') {
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

    if (conv.state === 'AWAITING_PAYMENT' && normalizeReply(message.text) === 'done') {
      await this.handleDonePayment(conv)
      conv = await this.stateMachine.appendMessage(conv, 'customer', message.text)
      return
    }

    if (await this.fulfilmentHandler?.handleCustomerAddress(merchantId, message.customerId, message.text)) {
      await this.stateMachine.appendMessage(conv, 'customer', message.text)
      return
    }

    const hasDealContext = hasPendingDealContext(conv.context)
    const commerceSignal = hasCommerceSignal(message.text, conv.state)
    const rawOfferPrice = this.extractCustomerOfferPrice(message.text)
    const botConfig = ((merchantConfig?.config as Record<string, unknown> | undefined)?.bot ?? {}) as MerchantBotConfig
    const botEnabled = botConfig.enabled !== false

    if (
      conv.context.automationPausedUntil &&
      new Date(conv.context.automationPausedUntil) > new Date() &&
      !hasDealContext &&
      !commerceSignal
    ) {
      await this.stateMachine.appendMessage(conv, 'customer', message.text)
      return
    }

    if (botEnabled && rawOfferPrice && conv.context.currentItems.length > 0) {
      conv = await this.stateMachine.appendMessage(conv, 'customer', message.text)
      if (await this.handleBotModeText(conv, {
        intent: 'COUNTER_OFFER',
        items: [],
        agreementSignalDetected: false,
        counterOfferPrice: rawOfferPrice,
      }, [], botConfig, rawOfferPrice, message.text)) return
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

    if (nlp.intent === 'NONE' && !(rawOfferPrice && conv.context.currentItems.length > 0)) return

    if (botEnabled && await this.handleBotModeText(conv, nlp, merchantProducts, botConfig, rawOfferPrice, message.text)) return

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
        if (nlp.intent === 'ORDER' && nlp.items.length > 0) {
          const updated = await this.stateMachine.transition(conv, 'NEGOTIATING', {
            currentItems: nlp.items,
            negotiationHistory: [],
            lastQuotedPrice: nlp.lastMentionedPrice,
            agreedPrice: undefined,
          })

          if (nlp.agreementSignalDetected) {
            await this.handleAgreement(updated)
          }
        } else if (nlp.intent === 'COUNTER_OFFER') {
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

    const merchant = await this.db.query.merchants.findFirst({
      where: eq(merchants.id, merchantId),
      columns: { phone: true },
    })

    const pendingOrder = this.pending
      ? await this.pending.get<PendingOrderPayload>(merchantId, 'PENDING_ORDER_CONFIRMATION')
      : null
    if (
      merchant?.phone &&
      pendingOrder &&
      normalizePhone(message.customerId) !== normalizePhone(pendingOrder.customerPhone)
    ) {
      await this.handleMerchantReply(merchantId, message.text, merchant.phone)
      return
    }

    const pendingPayment = this.pending
      ? await this.pending.get<PendingPaymentPayload>(merchantId, 'PENDING_PAYMENT_REVIEW')
      : null
    if (merchant?.phone && pendingPayment) {
      const order = await this.db.query.orders.findFirst({
        where: eq(orders.id, pendingPayment.orderId),
        columns: { customerPhone: true },
      })
      if (!order || normalizePhone(message.customerId) !== normalizePhone(order.customerPhone)) {
        await this.handleMerchantReply(merchantId, message.text, merchant.phone)
        return
      }
    }

    const pendingFulfilment = this.pending
      ? await this.pending.get<PendingFulfilmentPayload>(merchantId, 'PENDING_FULFILMENT_DECISION')
      : null
    if (
      merchant?.phone &&
      pendingFulfilment &&
      normalizePhone(message.customerId) !== normalizePhone(pendingFulfilment.customerPhone)
    ) {
      await this.handleMerchantReply(merchantId, message.text, merchant.phone)
      return
    }

    const convId = await this.getOrCreateConversationId(merchantId, message.channel, message.customerId)
    let conv = await this.stateMachine.getOrCreate(merchantId, message.channel, message.customerId, convId)
    conv = await this.resetIfStale(conv)
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

  private handoffMessage(botConfig: MerchantBotConfig, fallback: string): string {
    return botConfig.handoffMessage?.trim() || fallback
  }

  private productMatches(product: ProductRow, name: string): boolean {
    const target = name.trim().toLowerCase()
    if (!target) return false
    if (product.name === name.trim()) return true
    if (product.name.toLowerCase() === target) return true
    const aliases = (product.aliases ?? []).map(alias => alias.toLowerCase())
    return aliases.includes(target)
  }

  private normalizeCatalogTerm(name: string): string {
    return name
      .trim()
      .toLowerCase()
      .replace(/[^\w\s-]/g, ' ')
      .replace(/\s+/g, ' ')
      .replace(/\b(t\s?shirts?|tees?)\b/g, 'shirt')
      .replace(/\bshirts\b/g, 'shirt')
      .trim()
  }

  private catalogTermVariants(term: string): string[] {
    const normalized = this.normalizeCatalogTerm(term)
    const variants = new Set<string>([normalized])
    if (normalized.length > 3 && normalized.endsWith('s')) {
      variants.add(normalized.slice(0, -1))
    } else if (normalized.length > 2) {
      variants.add(`${normalized}s`)
    }
    return [...variants].filter(Boolean)
  }

  private categoryMatches(product: ProductRow, requestedName: string): boolean {
    const target = this.normalizeCatalogTerm(requestedName)
    if (!target) return false
    const terms = [product.name, ...(product.aliases ?? [])].map(value => this.normalizeCatalogTerm(value))
    return terms.some(term => {
      if (term === target) return true
      const words = new Set(term.split(/\s+/).filter(Boolean))
      return words.has(target)
    })
  }

  private findCategoryMatches(requestedName: string, merchantProducts: ProductRow[]): ProductRow[] {
    return merchantProducts
      .filter(product => product.active && product.stockQuantity > 0 && this.categoryMatches(product, requestedName))
      .slice(0, 6)
  }

  private extractCategoryFromText(text: string, merchantProducts: ProductRow[]): string | undefined {
    const normalizedText = ` ${this.normalizeCatalogTerm(text)} `
    const stopWords = new Set([
      'available', 'have', 'need', 'want', 'what', 'type', 'types', 'kind', 'kinds',
      'price', 'much', 'your', 'sell', 'please', 'hello', 'there', 'this', 'that',
      'with', 'from', 'for', 'and', 'the', 'you', 'u',
    ])
    const candidates = new Set<string>()

    for (const product of merchantProducts) {
      for (const term of [product.name, ...(product.aliases ?? [])]) {
        const normalized = this.normalizeCatalogTerm(term)
        for (const word of normalized.split(/\s+/)) {
          if (word.length > 2 && !stopWords.has(word) && !/^\d+$/.test(word)) {
            candidates.add(word)
          }
        }
      }
    }

    for (const candidate of candidates) {
      if (this.catalogTermVariants(candidate).some(variant => normalizedText.includes(` ${variant} `))) {
        return candidate
      }
    }

    return undefined
  }

  private resolveCatalogItems(
    requested: DetectedOrderItem[],
    merchantProducts: ProductRow[],
  ): { ok: true; items: CatalogItem[]; listTotal: number; floorTotal: number } | { ok: false; reason: 'unknown' | 'stock'; productName: string } {
    const items: CatalogItem[] = []
    for (const item of requested) {
      const allMatches = merchantProducts.filter(p => p.active && this.productMatches(p, item.productName))
      // Multiple products share the same alias (e.g. "polo" → white polo + black polo).
      // Treat as unknown so the category matcher lists the options for the customer to pick.
      if (allMatches.length > 1) return { ok: false, reason: 'unknown', productName: item.productName }
      const product = allMatches[0]
      if (!product) return { ok: false, reason: 'unknown', productName: item.productName }
      const quantity = item.quantity > 0 ? item.quantity : 1
      if (product.stockQuantity <= 0 || product.stockQuantity < quantity) {
        return { ok: false, reason: 'stock', productName: product.name }
      }
      const unitPrice = parseFloat(product.price)
      const floorUnitPrice = product.lastPrice ? parseFloat(product.lastPrice) : unitPrice
      items.push({
        productId: product.id,
        productName: product.name,
        quantity,
        unitPrice,
        floorUnitPrice,
        agreedPrice: item.agreedPrice,
      })
    }
    return {
      ok: true,
      items,
      listTotal: items.reduce((sum, item) => sum + item.unitPrice * item.quantity, 0),
      floorTotal: items.reduce((sum, item) => sum + item.floorUnitPrice * item.quantity, 0),
    }
  }

  private allocateAgreedPrices(items: CatalogItem[], agreedTotal: number): CatalogItem[] {
    const listTotal = items.reduce((sum, item) => sum + item.unitPrice * item.quantity, 0)
    if (items.length === 0 || listTotal <= 0) return items
    return items.map(item => ({
      ...item,
      agreedPrice: Number(((item.unitPrice * item.quantity / listTotal) * agreedTotal).toFixed(2)),
    }))
  }

  private formatMoney(amount: number): string {
    return `₦${amount.toLocaleString()}`
  }

  private quoteText(items: CatalogItem[], total: number): string {
    if (items.length === 1) {
      const item = items[0]
      return `Yes, ${item.productName} is ${this.formatMoney(total)}.`
    }
    return `Yes, the total for those is ${this.formatMoney(total)}.`
  }

  private categoryListText(requestedName: string, matches: ProductRow[]): string {
    const label = this.normalizeCatalogTerm(requestedName) || requestedName.trim().toLowerCase()
    const lines = matches.map(product => `- ${product.name} — ${this.formatMoney(parseFloat(product.price))}`)
    return [`We have a few ${label} options:\n`, ...lines, '\nWhich one do you want?'].join('\n')
  }

  private orderSummaryText(items: CatalogItem[], total: number): string {
    const lines = items.map(item => `${item.quantity}x ${item.productName} - ${this.formatMoney(item.agreedPrice ?? item.unitPrice * item.quantity)}`)
    return [`Order summary:`, ...lines, `Total: ${this.formatMoney(total)}`].join('\n')
  }

  private agreementPrompt(items: CatalogItem[]): string {
    return items.length === 1
      ? 'Alright. Do you want to add anything else, or should I confirm this one?'
      : 'Alright. Do you want to add anything else, or should I confirm this order?'
  }

  private counterReply(items: CatalogItem[], total: number): string {
    return items.length === 1
      ? `I can do ${this.formatMoney(total)} for it.`
      : `I can do ${this.formatMoney(total)} for everything.`
  }

  private lastPriceReply(total: number): string {
    return `${this.formatMoney(total)} is the best I can do.`
  }

  private extractCustomerOfferPrice(text: string): number | undefined {
    const lower = text.toLowerCase()
    const looksLikePriceOffer = /(?:pay|do|make|last|offer|budget|take|for|₦|naira|\bk\b|\bm\b)/i.test(lower)
    if (!looksLikePriceOffer) return undefined

    const matches = [...lower.matchAll(/(?:₦|ngn|n)?\s*(\d+(?:[,.]\d+)?)(?:\s*(k|m))?\b/g)]
    const parsed = matches
      .map(match => {
        const amount = Number(match[1].replace(/,/g, ''))
        if (!Number.isFinite(amount) || amount <= 0) return undefined
        const suffix = match[2]
        if (suffix === 'm') return amount * 1_000_000
        if (suffix === 'k') return amount * 1_000
        return amount >= 1000 || /[₦]|ngn|naira/.test(lower) ? amount : undefined
      })
      .filter((amount): amount is number => typeof amount === 'number')

    return parsed[parsed.length - 1]
  }

  private mergeCatalogItems(current: CatalogItem[], incoming: CatalogItem[]): CatalogItem[] {
    const merged = current.map(item => ({ ...item }))
    for (const item of incoming) {
      const index = merged.findIndex(existing =>
        (existing.productId && item.productId && existing.productId === item.productId)
        || existing.productName.toLowerCase() === item.productName.toLowerCase()
      )
      if (index >= 0) {
        merged[index] = {
          ...merged[index],
          quantity: merged[index].quantity + item.quantity,
          agreedPrice: undefined,
        }
      } else {
        merged.push({ ...item, agreedPrice: undefined })
      }
    }
    return merged
  }

  private async notifyMerchant(merchantId: string, message: string): Promise<void> {
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
      message,
    } satisfies NotificationSendEvent)
  }

  private async replyWithCategoryMatches(
    conv: Parameters<ConversationStateMachine['transition']>[0],
    requestedName: string,
    merchantProducts: ProductRow[],
  ): Promise<boolean> {
    const matches = this.findCategoryMatches(requestedName, merchantProducts)
    if (matches.length === 0) return false
    const reply = this.categoryListText(requestedName, matches)
    await this.transitionOrUpdate(conv, 'BROWSING', {
      currentItems: [],
      lastQuotedPrice: undefined,
      minimumAcceptableTotal: undefined,
      agreedPrice: undefined,
      awaitingOrderConfirmation: false,
      recentBotReply: reply,
    })
    await this.nats.publish({
      subject: SUBJECTS.NOTIFICATION_SEND,
      merchantId: conv.merchantId,
      to: conv.customerPhone,
      channel: 'whatsapp' as const,
      message: reply,
    } satisfies NotificationSendEvent)
    return true
  }

  private async handleBotModeText(
    conv: Parameters<ConversationStateMachine['transition']>[0],
    nlp: { intent: string; items: DetectedOrderItem[]; agreementSignalDetected: boolean; counterOfferPrice?: number; lastMentionedPrice?: number },
    merchantProducts: ProductRow[],
    botConfig: MerchantBotConfig,
    rawOfferPrice?: number,
    rawText = '',
  ): Promise<boolean> {
    // Order is already placed — don't re-enter the agreement/quote flow.
    // Messages in these states are handled elsewhere (payment gate, fulfilment).
    if (conv.state === 'ORDER_CREATED' || conv.state === 'AWAITING_PAYMENT') return false

    if (conv.context.awaitingOrderConfirmation && (nlp.intent === 'INQUIRY' || nlp.intent === 'ORDER') && nlp.items.length > 0) {
      const resolved = this.resolveCatalogItems(nlp.items, merchantProducts)
      if (!resolved.ok) {
        if (resolved.reason === 'unknown' && await this.replyWithCategoryMatches(conv, resolved.productName, merchantProducts)) {
          return true
        }
        await this.notifyMerchant(
          conv.merchantId,
          resolved.reason === 'stock'
            ? `Stock check needed for ${resolved.productName}. Customer asked for it but available stock is not enough.`
            : `Customer asked for unknown product "${resolved.productName}". Please reply directly.`,
        )
        await this.nats.publish({
          subject: SUBJECTS.NOTIFICATION_SEND,
          merchantId: conv.merchantId,
          to: conv.customerPhone,
          channel: 'whatsapp' as const,
          message: this.handoffMessage(botConfig, resolved.reason === 'stock'
            ? 'Let me check stock with the store and get back to you.'
            : "I'll ask someone from the store to help with this."),
        } satisfies NotificationSendEvent)
        return true
      }

      const mergedItems = this.mergeCatalogItems(conv.context.currentItems as CatalogItem[], resolved.items)
      const listTotal = mergedItems.reduce((sum, item) => sum + item.unitPrice * item.quantity, 0)
      const floorTotal = mergedItems.reduce((sum, item) => sum + item.floorUnitPrice * item.quantity, 0)
      const reply = this.quoteText(mergedItems, listTotal)
      await this.transitionOrUpdate(conv, 'NEGOTIATING', {
        currentItems: mergedItems,
        lastQuotedPrice: listTotal,
        minimumAcceptableTotal: floorTotal,
        agreedPrice: undefined,
        awaitingOrderConfirmation: false,
        recentBotReply: reply,
      })
      await this.nats.publish({
        subject: SUBJECTS.NOTIFICATION_SEND,
        merchantId: conv.merchantId,
        to: conv.customerPhone,
        channel: 'whatsapp' as const,
        message: reply,
      } satisfies NotificationSendEvent)
      return true
    }

    const current = conv.context.currentItems as CatalogItem[]
    const agreedTotal = conv.context.agreedPrice ?? conv.context.lastQuotedPrice
    const paymentDetailsRequested = !rawOfferPrice && isPaymentDetailsRequest(rawText)

    if (!rawOfferPrice && isLastPriceQuestion(rawText) && current.length > 0 && agreedTotal && agreedTotal > 0) {
      const reply = this.lastPriceReply(agreedTotal)
      await this.transitionOrUpdate(conv, 'NEGOTIATING', {
        recentBotReply: reply,
      })
      await this.nats.publish({
        subject: SUBJECTS.NOTIFICATION_SEND,
        merchantId: conv.merchantId,
        to: conv.customerPhone,
        channel: 'whatsapp' as const,
        message: reply,
      } satisfies NotificationSendEvent)
      return true
    }

    if (nlp.intent === 'INQUIRY' || nlp.intent === 'ORDER') {
      if (nlp.items.length === 0) {
        const category = this.extractCategoryFromText(rawText, merchantProducts)
        if (category && await this.replyWithCategoryMatches(conv, category, merchantProducts)) {
          return true
        }
        return false
      }
      const resolved = this.resolveCatalogItems(nlp.items, merchantProducts)
      if (!resolved.ok) {
        if (resolved.reason === 'unknown' && await this.replyWithCategoryMatches(conv, resolved.productName, merchantProducts)) {
          return true
        }
        await this.notifyMerchant(
          conv.merchantId,
          resolved.reason === 'stock'
            ? `Stock check needed for ${resolved.productName}. Customer asked for it but available stock is not enough.`
            : `Customer asked for unknown product "${resolved.productName}". Please reply directly.`,
        )
        await this.nats.publish({
          subject: SUBJECTS.NOTIFICATION_SEND,
          merchantId: conv.merchantId,
          to: conv.customerPhone,
          channel: 'whatsapp' as const,
          message: this.handoffMessage(botConfig, resolved.reason === 'stock'
            ? "Let me check stock with the store and get back to you."
            : "I'll ask someone from the store to help with this."),
        } satisfies NotificationSendEvent)
        return true
      }

      const reply = this.quoteText(resolved.items, resolved.listTotal)
      await this.transitionOrUpdate(conv, 'NEGOTIATING', {
        currentItems: resolved.items,
        lastQuotedPrice: resolved.listTotal,
        minimumAcceptableTotal: resolved.floorTotal,
        awaitingOrderConfirmation: false,
        agreedPrice: undefined,
        recentBotReply: reply,
      })
      await this.nats.publish({
        subject: SUBJECTS.NOTIFICATION_SEND,
        merchantId: conv.merchantId,
        to: conv.customerPhone,
        channel: 'whatsapp' as const,
        message: reply,
      } satisfies NotificationSendEvent)

      return true
    }

    const wantsToProceed = nlp.agreementSignalDetected
      || nlp.intent === 'AGREEMENT'
      || (nlp.intent === 'PAYMENT_INTENT' && !rawOfferPrice)
      || paymentDetailsRequested

    if (wantsToProceed) {
      if (current.length === 0) return false
      if (!agreedTotal || agreedTotal <= 0) return false
      if (conv.context.awaitingOrderConfirmation || paymentDetailsRequested) {
        await this.createBotOrder(conv, agreedTotal)
        return true
      }

      const prompt = this.agreementPrompt(current)
      await this.transitionOrUpdate(conv, 'AGREED', {
        agreedPrice: agreedTotal,
        lastQuotedPrice: agreedTotal,
        awaitingOrderConfirmation: true,
        recentBotReply: prompt,
      })
      await this.nats.publish({
        subject: SUBJECTS.NOTIFICATION_SEND,
        merchantId: conv.merchantId,
        to: conv.customerPhone,
        channel: 'whatsapp' as const,
        message: prompt,
      } satisfies NotificationSendEvent)
      return true
    }

    const offeredPrice = rawOfferPrice
      ?? nlp.counterOfferPrice
      ?? (nlp.intent === 'COUNTER_OFFER' && nlp.lastMentionedPrice && nlp.lastMentionedPrice > 0 ? nlp.lastMentionedPrice : undefined)

    if (offeredPrice && offeredPrice > 0) {
      const current = conv.context.currentItems as CatalogItem[]
      if (current.length === 0) return false
      const floorTotal = conv.context.minimumAcceptableTotal
        ?? current.reduce((sum, item) => sum + ((item.floorUnitPrice ?? item.unitPrice ?? 0) * item.quantity), 0)
      const accepted = offeredPrice >= floorTotal
      const botPrice = accepted ? offeredPrice : floorTotal
      const pricedItems = this.allocateAgreedPrices(current, botPrice)
      const reply = this.counterReply(current, botPrice)
      await this.transitionOrUpdate(conv, 'NEGOTIATING', {
        currentItems: pricedItems,
        lastQuotedPrice: botPrice,
        minimumAcceptableTotal: floorTotal,
        agreedPrice: accepted ? botPrice : undefined,
        awaitingOrderConfirmation: false,
        negotiationHistory: [
          ...conv.context.negotiationHistory,
          { price: offeredPrice, from: 'customer', timestamp: new Date().toISOString() },
          { price: botPrice, from: 'vendor', timestamp: new Date().toISOString() },
        ],
        recentBotReply: reply,
      })
      await this.nats.publish({
        subject: SUBJECTS.NOTIFICATION_SEND,
        merchantId: conv.merchantId,
        to: conv.customerPhone,
        channel: 'whatsapp' as const,
        message: reply,
      } satisfies NotificationSendEvent)
      return true
    }

    return false
  }

  private async createBotOrder(
    conv: Parameters<ConversationStateMachine['transition']>[0],
    agreedTotal: number,
  ): Promise<void> {
    if (!this.orderHandler) return
    const updated = await this.transitionOrUpdate(conv, 'AGREED', {
      agreedPrice: agreedTotal,
      lastQuotedPrice: agreedTotal,
      awaitingOrderConfirmation: false,
    })
    await this.orderHandler.handleConfirmed(updated.merchantId, updated.id, agreedTotal)
  }

  private async handleDonePayment(conv: Parameters<ConversationStateMachine['transition']>[0]): Promise<void> {
    const orderId = conv.context.orderId
    if (!orderId) return
    const order = await this.db.query.orders.findFirst({
      where: eq(orders.id, orderId),
      columns: { total: true },
    })
    if (!order) return
    const merchant = await this.db.query.merchants.findFirst({
      where: eq(merchants.id, conv.merchantId),
      columns: { phone: true, config: true },
    })
    if (!merchant?.phone) return

    await this.db.insert(payments).values({
      orderId,
      merchantId: conv.merchantId,
      amount: order.total,
      status: 'PENDING',
      rawOcrData: { source: 'customer_done_reply' },
    })

    const monoAccountId = (merchant.config as Record<string, unknown>)?.monoAccountId as string | undefined
    const reason = monoAccountId ? 'mono_failed' : 'mono_required'
    const taskId = await this.pending?.upsert(conv.merchantId, 'PENDING_PAYMENT_REVIEW', {
      orderId,
      reason,
      received: parseFloat(order.total),
      expected: parseFloat(order.total),
    })
    if (taskId) {
      const token = randomBytes(32).toString('hex')
      const tokenHash = createHash('sha256').update(token).digest('hex')
      const actionUrl = `${appConfig.DASHBOARD_URL}/actions/payment/${token}`
      await this.db.update(agentTasks)
        .set({ actionTokenHash: tokenHash, expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000) })
        .where(eq(agentTasks.id, taskId))
      await this.pending?.update(conv.merchantId, 'PENDING_PAYMENT_REVIEW', { actionToken: token, actionUrl })
    }

    await this.nats.publish({
      subject: SUBJECTS.NOTIFICATION_SEND,
      merchantId: conv.merchantId,
      to: merchant.phone,
      channel: 'whatsapp' as const,
      message: '',
      template: {
        name: 'mesa_payment_needs_confirmation_v2',
        languageCode: 'en',
        bodyParams: [
          orderId.slice(-8).toUpperCase(),
          conv.customerPhone,
          this.formatMoney(parseFloat(order.total)),
          this.formatMoney(parseFloat(order.total)),
          monoAccountId ? 'Bank verification did not find the payment yet' : 'Bank account not connected',
        ],
        buttons: [
          { type: 'quick_reply' as const, index: 0, payload: 'confirm_payment' },
          { type: 'quick_reply' as const, index: 1, payload: 'payment_not_yet' },
          { type: 'quick_reply' as const, index: 2, payload: 'payment_dispute' },
        ],
      },
    } satisfies NotificationSendEvent)

    await this.nats.publish({
      subject: SUBJECTS.NOTIFICATION_SEND,
      merchantId: conv.merchantId,
      to: conv.customerPhone,
      channel: 'whatsapp' as const,
      message: 'Thanks. I am checking the payment and will confirm shortly.',
    } satisfies NotificationSendEvent)
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

  private async handleMerchantReply(merchantId: string, text: string, merchantPhone: string): Promise<void> {
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
      const wantsLink = ['link', 'dashboard', 'open', 'review'].includes(normalizeReply(text))
      if (wantsLink && pendingPayment.actionUrl) {
        await this.nats.publish({
          subject: SUBJECTS.NOTIFICATION_SEND,
          merchantId,
          to: merchantPhone,
          channel: 'whatsapp' as const,
          message: `Open the payment review page here: ${pendingPayment.actionUrl}`,
        } satisfies NotificationSendEvent)
        return
      }

      if (['payment_not_yet', 'not yet', 'later', 'check again'].includes(normalizeReply(text))) {
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
          to: merchantPhone,
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
      const wantsLink = ['link', 'dashboard', 'open', 'review'].includes(normalizeReply(text))
      if (wantsLink && pendingOrder.actionUrl) {
        await this.nats.publish({
          subject: SUBJECTS.NOTIFICATION_SEND,
          merchantId,
          to: merchantPhone,
          channel: 'whatsapp' as const,
          message: `Open the order review page here: ${pendingOrder.actionUrl}`,
        } satisfies NotificationSendEvent)
        return
      }

      if (normalizeReply(text) === 'edit_order' || normalizeReply(text) === 'edit') {
        await this.nats.publish({
          subject: SUBJECTS.NOTIFICATION_SEND,
          merchantId,
          to: merchantPhone,
          channel: 'whatsapp' as const,
          message: 'Send the corrected total, e.g. 140000.\nTo change items too, send: 2x rice, 1x beans = 180000\nReply LINK if you prefer the review page.',
        } satisfies NotificationSendEvent)
        return
      }

      const correction = parseOrderCorrection(text)
      if (correction && this.orderHandler) {
        const record = await this.db.query.conversations.findFirst({
          where: eq(conversations.id, pendingOrder.conversationId),
        })
        if (!record) return
        const conv = await this.stateMachine.getOrCreate(
          record.merchantId,
          record.channel,
          record.customerPhone,
          record.id
        )
        await this.stateMachine.updateContext(conv, {
          currentItems: correction.items,
          agreedPrice: correction.total,
        })
        await this.orderHandler.handleConfirmed(
          merchantId,
          pendingOrder.conversationId,
          correction.total
        )
        if (this.pending) await this.pending.resolve(merchantId, 'PENDING_ORDER_CONFIRMATION', 'DONE')
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
          to: merchantPhone,
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
          to: merchantPhone,
          channel: 'whatsapp' as const,
          message: `₦${priceReply.value.toLocaleString()} looks unusually ${direction} for this order (detected ₦${detected.toLocaleString()}). Reply CONFIRM ${priceReply.value} to use this price anyway, or send a different amount.`,
        } satisfies NotificationSendEvent)
        return
      }

      // Unrecognized merchant reply — leave pending state intact.
      return
    }

    if (await this.fulfilmentHandler?.handleMerchantReply(merchantId, text, merchantPhone)) {
      return
    }

    await this.handleMerchantSelfService(merchantId, text, merchantPhone)
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
