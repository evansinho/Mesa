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
  NLPResult,
  WhatsAppContactSyncEvent,
  WhatsAppHistorySyncEvent,
  WhatsAppMessageEchoEvent,
} from '@mesa/types'
import { analyseMessage, analyzeProductImage, generateSalesReply, type KnownProduct } from '@mesa/ai'
import { downloadMedia } from '@mesa/whatsapp'
import { uploadScreenshot } from '../storage/r2'
import { ConversationStateMachine } from '../conversation/state-machine'
import {
  applyNlpToLedger,
  applyCheapTextToLedger,
  applyMerchantQuoteToLedger,
  applyValidatedLedgerPatch,
  contextWithLedger,
  decideNextAction,
  evaluateDraftReadiness,
  itemKey,
  normalizeLedger,
  routeMessageForCost,
  type DraftOrder,
  type NextAction,
} from '../conversation/commerce-ledger'
import type { CommerceLedger } from '@mesa/types'
import type { Redis } from 'ioredis'
import { desc, eq, and } from 'drizzle-orm'
import type { OrderHandler } from './order.handler'
import { config as appConfig } from '@mesa/config'
import type { PendingDecisions, PendingFulfilmentPayload, PendingOrderPayload, PendingPaymentPayload, PendingProductMediaPayload } from './pending-decisions'
import type { AiQuota, SubscriptionTier } from '../ai/quota'
import type { FulfilmentHandler } from './fulfilment.handler'
import { BotOrchestrator } from '../bot/orchestrator'
import { activeCartHash, cartTotal, legacyContextToBotRuntime } from '../bot/runtime-context'

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

function isConfirmationPhrase(text: string): boolean {
  const n = normalizeReply(text)
  return /^(confirm|confirmed|yes confirm|go ahead|proceed|done|ok confirm|okay confirm|oya confirm|yes proceed|confirm (it|am|am o|the order|order)|nothing else|no (more|other|anything)|that('s| is) (all|it)|just confirm|pls confirm|please confirm|abeg confirm)$/.test(n)
    || /^(yes|ok|okay|oya|yep|yh|yeah|sure)$/.test(n)
}

function isBareGreeting(text: string): boolean {
  return /^(hi|hello|hey|yo|good morning|good afternoon|good evening|gm|ga)$/i.test(normalizeReply(text))
}

export function isPaymentDetailsRequest(text: string): boolean {
  const n = normalizeReply(text)
  if (/\b(aza|account details|acc details|send account|send aza)\b/.test(n)) return true
  return /\b(acc|account|bank|payment|pay)\b/.test(n)
    && /\b(detail|details|number|account|send|give|how|make)\b/.test(n)
}

function paymentRetryDelayMs(count: number): number | null {
  if (count <= 1) return 10 * 60 * 1000
  if (count === 2) return 30 * 60 * 1000
  if (count === 3) return 2 * 60 * 60 * 1000
  return null
}

function parseAvailabilityReply(text: string): { available: boolean; price?: number } | null {
  const normalized = normalizeReply(text)
  if (/^(no|n|not available|unavailable|out of stock|sold out|no stock)$/.test(normalized)) {
    return { available: false }
  }
  const hasYes = /^(yes|y|available|in stock|we have|have it|yes available)\b/.test(normalized)
  if (!hasYes) return null
  const price = [...normalized.matchAll(/(?:₦|ngn|n|#)?\s*(\d+(?:[,.]\d+)?)(?:\s*(k|m))?\b/g)]
    .map(match => {
      const amount = Number(match[1].replace(/,/g, ''))
      if (!Number.isFinite(amount) || amount <= 0) return undefined
      if (match[2] === 'm') return amount * 1_000_000
      if (match[2] === 'k') return amount * 1_000
      return amount
    })
    .filter((amount): amount is number => typeof amount === 'number')
    .at(-1)
  return { available: true, price }
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
const AI_CALL_TIMEOUT_MS = 8_000
const STUCK_STATES: ConversationState[] = ['NEGOTIATING', 'AGREED', 'ORDER_CREATED', 'AWAITING_PAYMENT']
const POST_ORDER_STATES = new Set<ConversationState>(['ORDER_CREATED', 'AWAITING_PAYMENT', 'PAYMENT_RECEIVED', 'COMPLETE'])

type MerchantBotConfig = {
  enabled?: boolean
  engine?: 'orchestrator' | 'legacy'
  tone?: string
  language?: string
  handoffMessage?: string
  agentReplies?: boolean
}

type ProductRow = typeof products.$inferSelect
type CatalogItem = DetectedOrderItem & {
  productId: string
  productName: string
  quantity: number
  unitPrice: number
  floorUnitPrice: number
}

type BotNlpInput = Pick<
  NLPResult,
  'intent' | 'items' | 'agreementSignalDetected' | 'lastMentionedPrice' | 'counterOfferPrice' | 'signals' | 'facts'
> & { confidence?: number }

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

function isFreshShoppingOpener(text: string): boolean {
  const normalized = normalizeReply(text)
  if (normalized === 'done') return false
  if (isConfirmationPhrase(text) || isPaymentDetailsRequest(text) || isLastPriceQuestion(text)) return false
  if (/\b(paid|payment|transfer|receipt|proof|screenshot|sent|remove|cancel|refund|dispute|address|deliver|delivery)\b/.test(normalized)) {
    return false
  }
  return /\b(i\s+)?(want|need|like|buy|order|get|take)\b/.test(normalized)
}

function isRepeatOrderReference(text: string): boolean {
  const normalized = normalizeReply(text)
  return /\b(same thing|same one|same order|same item|same cartons?|same goods?|what i bought before|the one i bought before|last order|again)\b/.test(normalized) ||
    /\b(bought|buy|ordered|collected)\b.*\b(last time|last month|before)\b/.test(normalized)
}

function repeatQuantityOverride(text: string): number | undefined {
  const normalized = normalizeReply(text)
  const match = normalized.match(/\b(?:make (?:it|am)|this time make (?:it|am)|make them|quantity|qty)\s+(\d+)\b/) ??
    normalized.match(/\b(?:same cartons? again|same thing again|same order again).{0,24}\b(\d+)\b/)
  if (!match) return undefined
  const quantity = Number(match[1])
  return Number.isFinite(quantity) && quantity > 0 ? quantity : undefined
}

function asksWhatTotalIsFor(text: string): boolean {
  const normalized = normalizeReply(text)
  return /\b(total|amount|price)\b.*\b(what|which|for what)\b/.test(normalized) ||
    /\b(what|which|for what)\b.*\b(total|amount|price)\b/.test(normalized) ||
    /\btotal for what\b/.test(normalized)
}

function isMesaGeneratedEscalationText(text: string): boolean {
  const normalized = normalizeReply(text)
  return normalized.startsWith('customer needs attention:') ||
    normalized.startsWith('customer sent a product image') ||
    normalized.startsWith('customer sent a product document') ||
    normalized.startsWith('stock check needed') ||
    normalized === "i'll ask someone from the store to help with this" ||
    normalized === "let me confirm this and get back to you shortly" ||
    normalized.startsWith('let me confirm stock availability')
}

async function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms)
  })
  try {
    return await Promise.race([promise, timeout])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

function allowsSalesAgentFallback(route: ReturnType<typeof routeMessageForCost>): boolean {
  return route === 'HAIKU_REPLY' || route === 'HAIKU_ANALYSIS'
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

  private async transitionLedgerAction(
    conv: Parameters<ConversationStateMachine['transition']>[0],
    to: ConversationState,
    contextUpdate: Partial<ConversationContext> = {},
  ): Promise<Parameters<ConversationStateMachine['transition']>[0]> {
    if (this.stateMachine.canTransition(conv.state, to) || conv.state === to) {
      return this.transitionOrUpdate(conv, to, contextUpdate)
    }

    if (to === 'AGREED' && (conv.state === 'IDLE' || conv.state === 'BROWSING')) {
      const negotiating = await this.transitionOrUpdate(conv, 'NEGOTIATING', contextUpdate)
      return this.transitionOrUpdate(negotiating, 'AGREED', contextUpdate)
    }

    if (to === 'ORDER_CREATED' && conv.state !== 'ORDER_CREATED') {
      if (this.stateMachine.canTransition(conv.state, 'ORDER_CREATED')) {
        return this.transitionOrUpdate(conv, 'ORDER_CREATED', contextUpdate)
      }
      if (conv.state === 'IDLE' || conv.state === 'BROWSING') {
        return this.transitionOrUpdate(conv, 'ORDER_CREATED', contextUpdate)
      }
      if (conv.state === 'AWAITING_PAYMENT') {
        return this.transitionOrUpdate(conv, 'ORDER_CREATED', contextUpdate)
      }
    }

    if (to === 'AWAITING_PAYMENT' && conv.state !== 'AWAITING_PAYMENT') {
      if (this.stateMachine.canTransition(conv.state, 'AWAITING_PAYMENT')) {
        return this.transitionOrUpdate(conv, 'AWAITING_PAYMENT', contextUpdate)
      }
      if (conv.state === 'AGREED' || conv.state === 'NEGOTIATING' || conv.state === 'BROWSING' || conv.state === 'IDLE') {
        const orderCreated = await this.transitionLedgerAction(conv, 'ORDER_CREATED', contextUpdate)
        return this.transitionOrUpdate(orderCreated, 'AWAITING_PAYMENT', contextUpdate)
      }
    }

    if (to === 'PAYMENT_RECEIVED' && conv.state !== 'AWAITING_PAYMENT') {
      const awaiting = this.stateMachine.canTransition(conv.state, 'AWAITING_PAYMENT')
        ? await this.transitionOrUpdate(conv, 'AWAITING_PAYMENT', contextUpdate)
        : conv
      if (awaiting.state === 'AWAITING_PAYMENT') {
        return this.transitionOrUpdate(awaiting, 'PAYMENT_RECEIVED', contextUpdate)
      }
    }

    return this.transitionOrUpdate(conv, to, contextUpdate)
  }

  private async resetIfStale(
    conv: Parameters<ConversationStateMachine['transition']>[0],
  ): Promise<Parameters<ConversationStateMachine['transition']>[0]> {
    const lastAt = conv.context.lastMessageAt ? new Date(conv.context.lastMessageAt).getTime() : 0
    const isStale = Date.now() - lastAt > STALE_MS
    if (!isStale || !STUCK_STATES.includes(conv.state)) return conv

    return this.stateMachine.transition(conv, 'IDLE', {
      currentItems: [],
      checkoutStage: 'product_selection',
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
      escalationReason: undefined,
    })
  }

  private async resetForFreshTransaction(
    conv: Parameters<ConversationStateMachine['transition']>[0],
    text: string,
  ): Promise<Parameters<ConversationStateMachine['transition']>[0]> {
    if (!POST_ORDER_STATES.has(conv.state) || !isFreshShoppingOpener(text)) return conv

    const resetContext: Partial<ConversationContext> = {
      currentItems: [],
      checkoutStage: 'product_selection',
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
      escalationReason: undefined,
      ledger: normalizeLedger({
        currentItems: [],
        negotiationHistory: [],
        recentMessages: [],
      }, conv.customerPhone),
    }

    if (conv.state === 'PAYMENT_RECEIVED') {
      conv = await this.stateMachine.transition(conv, 'COMPLETE', resetContext)
    }
    if (conv.state === 'COMPLETE') {
      return this.stateMachine.transition(conv, 'IDLE', resetContext)
    }
    if (conv.state !== 'IDLE') {
      return this.stateMachine.transition(conv, 'IDLE', resetContext)
    }
    return this.stateMachine.updateContext(conv, resetContext)
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
      columns: { config: true, name: true },
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

      const ledger = normalizeLedger(conv.context, conv.customerPhone)
      await this.stateMachine.updateContext(conv, {
        ledger: {
          ...ledger,
          payment: {
            ...ledger.payment,
            status: 'proof_received',
            proofUrl: screenshotUrl,
          },
          draftOrder: {
            ...ledger.draftOrder,
            status: 'merchant_confirmed',
            orderId,
          },
        },
      })

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

    if (message.type === 'image' || message.type === 'document') {
      await this.handleCustomerProductMedia(merchantId, message, conv)
      return
    }

    if (message.type !== 'text' || !message.text) return
    if (isMesaGeneratedEscalationText(message.text)) return

    const botConfig = ((merchantConfig?.config as Record<string, unknown> | undefined)?.bot ?? {}) as MerchantBotConfig
    const botEnabled = botConfig.enabled !== false
    const botEngine = botConfig.engine ?? 'legacy'

    if (botEnabled && botEngine === 'orchestrator' && conv.state === 'AWAITING_PAYMENT') {
      const orchestrator = new BotOrchestrator(
        this.db,
        this.redis,
        this.nats,
        this.stateMachine,
        this.orderHandler,
        this.pending,
      )
      await orchestrator.handleCustomerText({
        conv,
        text: message.text,
        messageId: message.messageId,
        merchantName: merchantConfig?.name,
      })
      return
    }

    if (conv.state === 'AWAITING_PAYMENT' && normalizeReply(message.text) === 'done') {
      await this.handleDonePayment(conv)
      conv = await this.stateMachine.appendMessage(conv, 'customer', message.text)
      return
    }

    if (await this.fulfilmentHandler?.handleCustomerAddress(merchantId, message.customerId, message.text)) {
      await this.stateMachine.appendMessage(conv, 'customer', message.text)
      return
    }

    conv = await this.resetForFreshTransaction(conv, message.text)

    // Post-order: once an order is placed, the bot goes silent for plain text.
    // Only payment screenshots and DONE (handled above) are acted on. This
    // prevents the sales agent from re-entering the flow and wiping the cart
    // when the customer sends their name, address, or anything else.
    if (conv.state === 'ORDER_CREATED' || conv.state === 'AWAITING_PAYMENT') {
      await this.stateMachine.appendMessage(conv, 'customer', message.text)
      return
    }

    const hasDealContext = hasPendingDealContext(conv.context)
    const commerceSignal = hasCommerceSignal(message.text, conv.state)
    const rawOfferPrice = this.extractCustomerOfferPrice(message.text)
    let merchantName = merchantConfig?.name
    let quotaTier: SubscriptionTier = 'starter'
    let messageAppended = false

    if (botEnabled && botEngine === 'legacy' && hasDealContext) {
      const shadowRuntime = legacyContextToBotRuntime(conv.context)
      const legacyStage = conv.context.checkoutStage ?? conv.state
      const mismatches = [
        shadowRuntime.checkoutStage === 'cart_review' && !conv.context.awaitingOrderConfirmation ? 'stage_cart_review_without_legacy_confirmation' : undefined,
        shadowRuntime.cart.length !== conv.context.currentItems.length ? 'cart_item_count_mismatch' : undefined,
        cartTotal(shadowRuntime.cart) > 0 && conv.context.lastQuotedPrice && Math.abs(cartTotal(shadowRuntime.cart) - conv.context.lastQuotedPrice) > 1 ? 'quote_total_mismatch' : undefined,
      ].filter(Boolean)
      console.info(JSON.stringify({
        level: 'info',
        msg: 'bot_orchestrator_shadow_hydration',
        merchantId,
        conversationId: conv.id,
        legacyState: conv.state,
        legacyStage,
        runtimeStage: shadowRuntime.checkoutStage,
        cartHash: activeCartHash(shadowRuntime.cart),
        cartTotal: cartTotal(shadowRuntime.cart),
        mismatches,
      }))
    }

    if (botEnabled && botEngine === 'orchestrator') {
      const orchestrator = new BotOrchestrator(
        this.db,
        this.redis,
        this.nats,
        this.stateMachine,
        this.orderHandler,
        this.pending,
      )
      await orchestrator.handleCustomerText({
        conv,
        text: message.text,
        messageId: message.messageId,
        merchantName,
      })
      return
    }

    if (
      conv.context.automationPausedUntil &&
      new Date(conv.context.automationPausedUntil) > new Date() &&
      !hasDealContext &&
      !commerceSignal
    ) {
      await this.stateMachine.appendMessage(conv, 'customer', message.text)
      return
    }

    if (botEnabled && !hasDealContext && isBareGreeting(message.text)) {
      const merchantProducts = await this.db.query.products.findMany({
        where: and(eq(products.merchantId, merchantId), eq(products.active, true)),
      })
      const summary = this.catalogCategorySummary(merchantProducts)
      const reply = summary
        ? `Hi! Welcome to ${merchantName ?? 'the shop'}. What would you like to buy today? We have ${summary}.`
        : `Hi! Welcome to ${merchantName ?? 'the shop'}. What would you like to buy today?`
      conv = await this.stateMachine.appendMessage(conv, 'customer', message.text)
      await this.transitionOrUpdate(conv, conv.state === 'IDLE' ? 'BROWSING' : conv.state, {
        checkoutStage: 'product_selection',
        recentBotReply: reply,
      })
      await this.nats.publish({
        subject: SUBJECTS.NOTIFICATION_SEND,
        merchantId,
        to: message.customerId,
        channel: message.channel,
        message: reply,
      } satisfies NotificationSendEvent)
      return
    }

    if (botEnabled && hasDealContext && !isLastPriceQuestion(message.text) && asksWhatTotalIsFor(message.text)) {
      const current = conv.context.currentItems as CatalogItem[]
      const total = conv.context.agreedPrice ?? conv.context.lastQuotedPrice ?? current.reduce((sum, item) => {
        const unitPrice = item.agreedPrice && item.quantity > 0 ? item.agreedPrice / item.quantity : item.unitPrice
        return sum + (unitPrice ?? 0) * item.quantity
      }, 0)
      if (current.length > 0 && total > 0) {
        conv = await this.stateMachine.appendMessage(conv, 'customer', message.text)
        const reply = `${this.orderSummaryText(current, total)}\n\nIs this correct?`
        await this.transitionOrUpdate(conv, conv.state === 'IDLE' ? 'NEGOTIATING' : conv.state, {
          recentBotReply: reply,
          checkoutStage: 'cart_confirmation',
          awaitingOrderConfirmation: true,
          agreedPrice: total,
          lastQuotedPrice: total,
        })
        await this.nats.publish({
          subject: SUBJECTS.NOTIFICATION_SEND,
          merchantId,
          to: message.customerId,
          channel: message.channel,
          message: reply,
        } satisfies NotificationSendEvent)
        return
      }
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

    // When bot already asked "add anything else or confirm?", bypass NLP for
    // unambiguous confirmation phrases so the customer never has to repeat themselves.
    if (botEnabled && conv.context.awaitingOrderConfirmation && isConfirmationPhrase(message.text)) {
      conv = await this.stateMachine.appendMessage(conv, 'customer', message.text)
      const total = conv.context.agreedPrice ?? conv.context.lastQuotedPrice
      if (total && total > 0) {
        await this.createBotOrder(conv, total)
        return
      }
    }

    // "No" / "nothing else" when awaiting confirmation means "no more items, go ahead".
    // Without this, bare "No" falls through to NLP → NONE intent → product clarification.
    if (botEnabled && conv.context.awaitingOrderConfirmation) {
      const n = normalizeReply(message.text)
      const isNothingElse = /^(no|nope|nah|nothing|nothing else|not really|nah na|that'?s all|no more|no other|i'?m good|im good|just confirm|proceed)$/.test(n)
      if (isNothingElse) {
        conv = await this.stateMachine.appendMessage(conv, 'customer', message.text)
        const total = conv.context.agreedPrice ?? conv.context.lastQuotedPrice
        if (total && total > 0) {
          await this.createBotOrder(conv, total)
          return
        }
      }
    }

    // Cost gate: skip the Claude NLP call (and the products query below) for
    // messages that can't be commerce — empty, pure emoji/punctuation, or a
    // bare greeting while no deal is in flight. A chatty customer's "hi" /
    // "thanks" no longer each cost a Haiku call. Mid-deal states still run NLP.
    if (!hasDealContext && !commerceSignal) return

    const costRoute = routeMessageForCost(message.text, normalizeLedger(conv.context, conv.customerPhone))
    if (botEnabled && costRoute === 'CHEAP_RULES') {
      conv = await this.stateMachine.appendMessage(conv, 'customer', message.text)
      messageAppended = true
      if (await this.handleCheapBotMessage(conv, message.text, botConfig)) return
    }

    if (botEnabled && costRoute === 'SONNET_ESCALATION') {
      conv = await this.stateMachine.appendMessage(conv, 'customer', message.text)
      messageAppended = true
      if (await this.handleCheapBotMessage(conv, message.text, botConfig)) return
    }

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

    if (botEnabled && costRoute === 'CATALOG_RULES') {
      conv = await this.stateMachine.appendMessage(conv, 'customer', message.text)
      messageAppended = true
      if (await this.handleCheapBotMessage(conv, message.text, botConfig, merchantProducts)) return
    }

    if (isRepeatOrderReference(message.text)) {
      if (!messageAppended) {
        conv = await this.stateMachine.appendMessage(conv, 'customer', message.text)
        messageAppended = true
      }
      const handledRepeat = await this.handleRepeatCustomerMemory(conv, message.text, botEnabled)
      if (handledRepeat) return
    }

    // Per-merchant AI quota: bounds spend and traps misbehaving customers.
    // If exhausted, send the merchant a one-shot notification and drop this
    // message from automated processing (manual handling required until reset).
    if (this.aiQuota) {
      const merchantRow = await this.db.query.merchants.findFirst({
        where: eq(merchants.id, merchantId),
        columns: { phone: true, subscriptionTier: true, name: true },
      })
      merchantName = merchantName ?? merchantRow?.name
      quotaTier = (merchantRow?.subscriptionTier as SubscriptionTier | undefined) ?? 'starter'
      const quota = await this.aiQuota.checkAndConsume(merchantId, quotaTier)
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

    let nlp: NLPResult
    try {
      nlp = await withTimeout(analyseMessage(message.text, history, knownProducts), AI_CALL_TIMEOUT_MS, 'analyseMessage')
    } catch (err) {
      console.warn(JSON.stringify({
        level: 'warn',
        msg: 'customer_reply_fallback_sent',
        reason: 'nlp_failed',
        merchantId,
        conversationId: conv.id,
        messageId: message.messageId,
        err: err instanceof Error ? err.message : String(err),
      }))
      if (!messageAppended) {
        conv = await this.stateMachine.appendMessage(conv, 'customer', message.text)
      }
      if (botEnabled && commerceSignal) {
        await this.replyWithProductClarification(conv, merchantProducts)
      }
      return
    }
    if (this.aiQuota) await this.aiQuota.recordUsage(merchantId, 'haiku')

    // Persist the current message in the rolling buffer so the next NLP call
    // for this conversation has it as context. Capture the returned record
    // so subsequent state transitions don't overwrite the appended buffer
    // with stale context.
    if (!messageAppended) {
      conv = await this.stateMachine.appendMessage(conv, 'customer', message.text)
    }

    if (botEnabled && nlp.items.length === 0 && (nlp.intent === 'NONE' || nlp.intent === 'INQUIRY' || nlp.intent === 'ORDER')) {
      const category = this.extractCategoryFromText(message.text, merchantProducts)
      if (category && await this.replyWithCategoryMatches(conv, category, merchantProducts)) return
    }

    if (nlp.intent === 'NONE' && !(rawOfferPrice && conv.context.currentItems.length > 0)) {
      if (botEnabled && allowsSalesAgentFallback(costRoute) && await this.maybeReplyWithSalesAgent(
        conv,
        message.text,
        botConfig,
        merchantProducts,
        history,
        merchantName,
        quotaTier,
      )) return
      if (botEnabled && commerceSignal) {
        await this.replyWithProductClarification(conv, merchantProducts)
      }
      return
    }

    if (botEnabled && await this.handleBotModeText(conv, nlp, merchantProducts, botConfig, rawOfferPrice, message.text)) return

    if (botEnabled && allowsSalesAgentFallback(costRoute) && nlp.items.length === 0 && await this.maybeReplyWithSalesAgent(
      conv,
      message.text,
      botConfig,
      merchantProducts,
      history,
      merchantName,
      quotaTier,
    )) return

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

    if (botEnabled && commerceSignal && nlp.items.length === 0) {
      console.warn(JSON.stringify({
        level: 'warn',
        msg: 'customer_reply_fallback_sent',
        reason: 'unhandled_commerce_branch',
        merchantId,
        conversationId: conv.id,
        messageId: message.messageId,
      }))
      await this.replyWithProductClarification(conv, merchantProducts)
    }
  }

  async handleMessageEcho(event: WhatsAppMessageEchoEvent): Promise<void> {
    const { merchantId, message } = event
    if (message.channel !== 'whatsapp') return
    if (message.type !== 'text' || !message.text) return
    if (isMesaGeneratedEscalationText(message.text)) return

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

    const pendingProductMedia = this.pending
      ? await this.pending.get<PendingProductMediaPayload>(merchantId, 'PENDING_PRODUCT_MEDIA_CONFIRMATION')
      : null
    if (
      merchant?.phone &&
      pendingProductMedia &&
      normalizePhone(message.customerId) !== normalizePhone(pendingProductMedia.customerPhone)
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
    if (quotedPrice != null) {
      const ledger = applyMerchantQuoteToLedger(normalizeLedger(conv.context, conv.customerPhone), quotedPrice)
      contextUpdate.lastQuotedPrice = quotedPrice
      contextUpdate.ledger = ledger
    }
    if (!isSalesContext) {
      contextUpdate.automationPausedUntil = new Date(Date.now() + MANUAL_REPLY_PAUSE_MS).toISOString()
      await this.redis.set(`last_paused_customer:${merchantId}`, message.customerId, 'EX', 3600)
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

  private catalogSynonyms(term: string): string[] {
    const normalized = this.normalizeCatalogTerm(term)
    if (!normalized) return []
    const words = normalized.split(/\s+/).filter(Boolean)
    const isOnlyCategoryWords = (allowed: Set<string>) => words.length > 0 && words.every(word => allowed.has(word))
    const pantsWords = new Set(['pant', 'pants', 'trouser', 'trousers', 'bottom', 'bottoms', 'jean', 'jeans', 'chino', 'chinos', 'cargo', 'cargos', 'jogger', 'joggers'])
    const topWords = new Set(['top', 'tops', 'shirt', 'shirts', 'polo', 'polos', 'tee', 'tees', 'tshirt', 'tshirts', 't', 'senator', 'ankara'])
    const shoeWords = new Set(['shoe', 'shoes', 'sneaker', 'sneakers', 'slides', 'slipper', 'slippers', 'sandal', 'sandals', 'boot', 'boots', 'footwear'])
    if (/\b(pants?|trousers?|bottoms?|jeans?|chinos?|cargos?|joggers?)\b/.test(normalized)) {
      return isOnlyCategoryWords(pantsWords) ? [...pantsWords] : []
    }
    if (/\b(tops?|shirts?|polo|polos|tees?|tshirts?|t shirts?|senator|ankara)\b/.test(normalized)) {
      return isOnlyCategoryWords(topWords) ? [...topWords] : []
    }
    if (/\b(shoes?|sneakers?|slides?|slippers?|sandals?|boots?|footwear)\b/.test(normalized)) {
      return isOnlyCategoryWords(shoeWords) ? [...shoeWords] : []
    }
    return []
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
    const targetTerms = new Set([target, ...this.catalogTermVariants(target), ...this.catalogSynonyms(target)])
    const terms = [product.name, ...(product.aliases ?? [])].map(value => this.normalizeCatalogTerm(value))
    return terms.some(term => {
      if (targetTerms.has(term)) return true
      const words = new Set(term.split(/\s+/).filter(Boolean))
      return [...targetTerms].some(targetTerm => words.has(targetTerm))
    })
  }

  private findCategoryMatches(requestedName: string, merchantProducts: ProductRow[]): ProductRow[] {
    return merchantProducts
      .filter(product => product.active && product.stockQuantity > 0 && this.categoryMatches(product, requestedName))
      .slice(0, 6)
  }

  private itemMatchesCategory(item: DetectedOrderItem, requestedName: string, merchantProducts: ProductRow[]): boolean {
    const exactMatches = merchantProducts.filter(product => product.active && this.productMatches(product, item.productName))
    if (exactMatches.length > 0) {
      return exactMatches.some(product => this.categoryMatches(product, requestedName))
    }
    return this.categoryMatches({
      name: item.productName,
      aliases: [],
      active: true,
      stockQuantity: 1,
    } as unknown as ProductRow, requestedName)
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

    for (const category of ['pants', 'tops', 'shoes']) {
      if (
        this.catalogSynonyms(category).some(alias => normalizedText.includes(` ${alias} `)) &&
        merchantProducts.some(product => product.active && product.stockQuantity > 0 && this.categoryMatches(product, category))
      ) {
        return category
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

  private resolveUnambiguousCatalogItems(
    requested: DetectedOrderItem[],
    merchantProducts: ProductRow[],
    ambiguousName: string,
  ): CatalogItem[] {
    const items: CatalogItem[] = []
    for (const item of requested) {
      if (item.productName.toLowerCase() === ambiguousName.toLowerCase()) continue
      const allMatches = merchantProducts.filter(p => p.active && this.productMatches(p, item.productName))
      if (allMatches.length !== 1) continue
      const product = allMatches[0]
      const quantity = item.quantity > 0 ? item.quantity : 1
      if (product.stockQuantity <= 0 || product.stockQuantity < quantity) continue
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
    return items
  }

  private async escalateUnknownProduct(
    conv: Parameters<ConversationStateMachine['transition']>[0],
    productName: string,
    reason: 'unknown' | 'stock',
    merchantProducts: ProductRow[],
    botConfig: MerchantBotConfig,
  ): Promise<void> {
    const currentLedger = normalizeLedger(conv.context, conv.customerPhone)
    const key = itemKey(productName)
    const alreadyEscalated = currentLedger.items.some(
      i => itemKey(i.productName) === key && i.status !== 'removed' && !i.productId
    )
    if (!alreadyEscalated) {
      // Save a placeholder item so we don't repeat the escalation on every message
      const withPlaceholder = applyValidatedLedgerPatch(currentLedger, {
        items: [{ operation: 'add', productName }],
      }, merchantProducts)
      await this.stateMachine.updateContext(conv, { ledger: withPlaceholder })
      await this.notifyMerchant(
        conv.merchantId,
        reason === 'stock'
          ? `Stock check needed for ${productName}. Customer asked for it but available stock is not enough.`
          : `Customer is asking for "${productName}" — do you carry this? Please reply to the customer directly.`,
      )
      await this.nats.publish({
        subject: SUBJECTS.NOTIFICATION_SEND,
        merchantId: conv.merchantId,
        to: conv.customerPhone,
        channel: 'whatsapp' as const,
        message: this.handoffMessage(botConfig, reason === 'stock'
          ? `Let me confirm the stock availability for ${productName} and get back to you.`
          : `Let me confirm if we have ${productName} available. I'll get back to you shortly.`),
      } satisfies NotificationSendEvent)
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

  private isCatalogBrowsingRequest(text: string): boolean {
    return /what.*(you|u|una).*(have|sell|got|carry|get)|what.*(product|item|thing|stuff|stock)|show.*(me|us).*(what|your|product|item)|what.*available|your.*(product|item|catalog|catalogue|list)|full.*(list|price)|price.*(list|all)|list.*product|wetin.*(you|u|una).*(get|have|sell|carry)|wetin.*sell|wetin.*dey/i.test(text)
  }

  private catalogAllText(merchantProducts: ProductRow[]): string {
    const active = merchantProducts.filter(p => p.active && p.stockQuantity > 0)
    if (active.length === 0) return "We don't have any products available right now. Check back soon!"
    const lines = active.map(p => `- ${p.name} — ${this.formatMoney(parseFloat(p.price))}`)
    return [`Here's what we have available:\n`, ...lines, '\nWhat would you like to order?'].join('\n')
  }

  private catalogCategorySummary(merchantProducts: ProductRow[]): string {
    const labels = new Set<string>()
    for (const product of merchantProducts.filter(p => p.active && p.stockQuantity > 0)) {
      const term = this.normalizeCatalogTerm([product.name, ...(product.aliases ?? [])].join(' '))
      if (/\b(pants?|trousers?|bottoms?|jeans?|chinos?|cargos?|joggers?)\b/.test(term)) {
        labels.add('trousers/jeans')
      } else if (/\b(shoes?|sneakers?|slides?|slippers?|sandals?|boots?|footwear)\b/.test(term)) {
        labels.add('shoes')
      } else if (/\b(polo|polos)\b/.test(term)) {
        labels.add('polos')
      } else if (/\b(tops?|shirts?|tees?|tshirts?|senator|ankara)\b/.test(term)) {
        labels.add('shirts/tops')
      }
    }
    return [...labels].slice(0, 4).join(', ')
  }

  private productClarificationText(merchantProducts: ProductRow[]): string {
    const active = merchantProducts.filter(p => p.active && p.stockQuantity > 0).slice(0, 5)
    if (active.length === 0) {
      return 'What product are you looking for?'
    }
    const summary = this.catalogCategorySummary(merchantProducts)
    const examples = active.map(p => p.name).join(', ')
    return summary
      ? `What product are you looking for? We have ${summary}. For example: ${examples}.`
      : `What product are you looking for? We have ${examples}.`
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

  private async handleCheapBotMessage(
    conv: Parameters<ConversationStateMachine['transition']>[0],
    text: string,
    botConfig: MerchantBotConfig,
    merchantProducts: ProductRow[] = [],
  ): Promise<boolean> {
    const ledger = normalizeLedger(conv.context, conv.customerPhone)
    const nextLedger = applyCheapTextToLedger(ledger, text, merchantProducts)
    if (!nextLedger) return false
    const readiness = evaluateDraftReadiness(nextLedger, merchantProducts)
    const action = decideNextAction(nextLedger, readiness)
    return this.executeLedgerAction(conv, action, botConfig, nextLedger)
  }

  private async maybeReplyWithSalesAgent(
    conv: Parameters<ConversationStateMachine['transition']>[0],
    text: string,
    botConfig: MerchantBotConfig,
    merchantProducts: ProductRow[],
    history: Array<{ role: 'vendor' | 'customer'; text: string }>,
    merchantName?: string | null,
    tier: SubscriptionTier = 'starter',
  ): Promise<boolean> {
    if (botConfig.agentReplies === false) return false
    if (typeof generateSalesReply !== 'function') return false

    if (this.aiQuota) {
      const quota = await this.aiQuota.checkAndConsume(conv.merchantId, tier)
      if (!quota.allowed) return false
    }

    const ledger = normalizeLedger(conv.context, conv.customerPhone)
    let reply
    try {
      reply = await withTimeout(generateSalesReply({
        merchantName: merchantName ?? undefined,
        botTone: botConfig.tone,
        botLanguage: botConfig.language,
        customerMessage: text,
        conversationHistory: history,
        products: merchantProducts.map(product => ({
          name: product.name,
          aliases: (product as unknown as { aliases: string[] }).aliases ?? [],
          unit: product.unit,
          price: product.price ? parseFloat(product.price) : undefined,
          stockQuantity: product.stockQuantity,
        })),
        ledger: {
          items: ledger.items
            .filter(item => item.status !== 'removed')
            .map(item => ({
              productName: item.productName,
              quantity: item.quantity,
              quotedUnitPrice: item.quotedUnitPrice,
              agreedUnitPrice: item.agreedUnitPrice,
              status: item.status,
            })),
          deliveryAddress: ledger.customer.deliveryAddress,
          paymentStatus: ledger.payment.status,
          draftStatus: ledger.draftOrder?.status,
        },
      }), AI_CALL_TIMEOUT_MS, 'generateSalesReply')
    } catch (err) {
      console.warn(JSON.stringify({
        level: 'warn',
        msg: 'Sales agent reply failed',
        merchantId: conv.merchantId,
        conversationId: conv.id,
        err: err instanceof Error ? err.message : String(err),
      }))
      return false
    }
    if (this.aiQuota && reply) await this.aiQuota.recordUsage(conv.merchantId, reply.modelUsed)
    if (!reply) return false

    await this.stateMachine.updateContext(conv, {
      recentBotReply: reply.message,
    })
    await this.nats.publish({
      subject: SUBJECTS.NOTIFICATION_SEND,
      merchantId: conv.merchantId,
      to: conv.customerPhone,
      channel: 'whatsapp' as const,
      message: reply.message,
    } satisfies NotificationSendEvent)
    return true
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
    // Keep items that are NOT the ambiguous one so a multi-item order like
    // "polo and jeans" doesn't lose the jeans while we clarify which polo.
    const remainingItems = (conv.context.currentItems as CatalogItem[]).filter(
      item => !this.categoryMatches({ name: item.productName, aliases: [], active: true, stockQuantity: 1 } as unknown as ProductRow, requestedName)
    )
    await this.transitionOrUpdate(conv, 'BROWSING', {
      checkoutStage: 'product_clarification',
      currentItems: remainingItems,
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

  private async replyWithProductClarification(
    conv: Parameters<ConversationStateMachine['transition']>[0],
    merchantProducts: ProductRow[],
  ): Promise<boolean> {
    const reply = this.productClarificationText(merchantProducts)
    await this.transitionOrUpdate(conv, conv.state === 'IDLE' ? 'BROWSING' : conv.state, {
      checkoutStage: 'product_selection',
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

  private draftToCatalogItems(draft: DraftOrder): CatalogItem[] | null {
    const items: CatalogItem[] = []
    for (const item of draft.items) {
      const unitPrice = item.quotedUnitPrice ?? item.agreedUnitPrice
      const floorUnitPrice = item.floorUnitPrice ?? unitPrice
      if (!item.productId || !unitPrice || !floorUnitPrice || !item.quantity || item.quantity <= 0) {
        return null
      }
      items.push({
        productId: item.productId,
        productName: item.productName,
        quantity: item.quantity,
        unitPrice,
        floorUnitPrice,
        agreedPrice: item.agreedUnitPrice ? item.agreedUnitPrice * item.quantity : undefined,
      })
    }
    return items
  }

  private ledgerContextUpdate(
    conv: Parameters<ConversationStateMachine['transition']>[0],
    ledger: CommerceLedger,
    contextUpdate: Partial<ConversationContext> = {},
  ): Partial<ConversationContext> {
    const merged = contextWithLedger({
      ...conv.context,
      ...contextUpdate,
      lastMessageAt: new Date().toISOString(),
    }, ledger)
    return {
      ...contextUpdate,
      currentItems: merged.currentItems,
      lastQuotedPrice: merged.lastQuotedPrice,
      agreedPrice: merged.agreedPrice,
      awaitingOrderConfirmation: merged.awaitingOrderConfirmation,
      orderId: merged.orderId,
      ledger,
    }
  }

  private async executeLedgerAction(
    conv: Parameters<ConversationStateMachine['transition']>[0],
    action: NextAction,
    botConfig: MerchantBotConfig,
    ledger: CommerceLedger,
  ): Promise<boolean> {
    switch (action.type) {
      case 'REPLY_WITH_PRICE': {
        const items = this.draftToCatalogItems({ items: action.items, total: action.total })
        if (!items) return false
        const floorTotal = items.reduce((sum, item) => sum + item.floorUnitPrice * item.quantity, 0)
        // Reset draftOrder and correction so a re-quote starts a fresh summary cycle.
        // Stale correction signal would re-enter REPLY_WITH_PRICE on subsequent agreements.
        const quoteLedger: CommerceLedger = {
          ...ledger,
          draftOrder: { status: 'none' },
          signals: { ...ledger.signals, correction: false, negotiation: false, asksLastPrice: false },
        }
        const completesClarification = conv.context.checkoutStage === 'product_clarification'
        const reply = completesClarification
          ? `${this.quoteText(items, action.total)}\n\n${this.agreementPrompt(items)}`
          : this.quoteText(items, action.total)
        await this.transitionOrUpdate(conv, 'NEGOTIATING', {
          checkoutStage: completesClarification ? 'cart_confirmation' : 'product_selection',
          ...this.ledgerContextUpdate(conv, quoteLedger),
          currentItems: items,
          lastQuotedPrice: action.total,
          minimumAcceptableTotal: floorTotal,
          agreedPrice: completesClarification ? action.total : undefined,
          awaitingOrderConfirmation: completesClarification,
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

      case 'REPLY_WITH_LAST_PRICE': {
        const updatedLedger: CommerceLedger = {
          ...ledger,
          signals: { ...ledger.signals, asksLastPrice: false },
        }
        const reply = this.lastPriceReply(action.total)
        await this.transitionOrUpdate(conv, conv.state === 'IDLE' ? 'NEGOTIATING' : conv.state, {
          ...this.ledgerContextUpdate(conv, updatedLedger),
          lastQuotedPrice: action.total,
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

      case 'ASK_QUANTITY': {
        const reply = `How many ${action.productName} should I prepare for you?`
        await this.transitionOrUpdate(conv, conv.state === 'IDLE' ? 'BROWSING' : conv.state, {
          ...this.ledgerContextUpdate(conv, ledger),
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

      case 'ASK_COUNTER_OFFER': {
        const reply = "What price are you offering?"
        await this.stateMachine.updateContext(conv, {
          ...this.ledgerContextUpdate(conv, ledger),
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

      case 'ASK_DELIVERY_ADDRESS': {
        const reply = "Please send your delivery address so I can confirm delivery for you."
        await this.stateMachine.updateContext(conv, {
          ...this.ledgerContextUpdate(conv, ledger),
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

      case 'ACKNOWLEDGE_DELIVERY_ADDRESS': {
        const clearedLedger: CommerceLedger = {
          ...ledger,
          signals: { ...ledger.signals, asksDelivery: false },
        }
        const reply = `Got it! I'll arrange delivery to ${action.address}.`
        await this.stateMachine.updateContext(conv, {
          ...this.ledgerContextUpdate(conv, clearedLedger),
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

      case 'ACKNOWLEDGE_CORRECTION': {
        const reply = "Noted."
        await this.stateMachine.updateContext(conv, {
          ...this.ledgerContextUpdate(conv, ledger),
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

      case 'SEND_ORDER_SUMMARY': {
        const items = this.draftToCatalogItems(action.draft)
        if (!items) return false
        const updatedLedger: CommerceLedger = {
          ...ledger,
          draftOrder: { status: 'sent_to_customer', total: action.draft.total },
        }
        const prompt = this.agreementPrompt(items)
        await this.transitionLedgerAction(conv, 'AGREED', {
          checkoutStage: 'cart_confirmation',
          ...this.ledgerContextUpdate(conv, updatedLedger),
          currentItems: items,
          agreedPrice: action.draft.total,
          lastQuotedPrice: action.draft.total,
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

      case 'REQUEST_PAYMENT': {
        const items = this.draftToCatalogItems(action.draft)
        if (!items) return false
        const updatedLedger: CommerceLedger = {
          ...ledger,
          payment: { ...ledger.payment, status: 'requested' },
          draftOrder: { status: 'customer_confirmed', total: action.draft.total },
        }
        const updated = await this.transitionLedgerAction(conv, 'AGREED', {
          checkoutStage: 'payment_pending',
          ...this.ledgerContextUpdate(conv, updatedLedger),
          currentItems: items,
          agreedPrice: action.draft.total,
          lastQuotedPrice: action.draft.total,
          awaitingOrderConfirmation: false,
        })
        await this.createBotOrder(updated, action.draft.total)
        return true
      }

      case 'NEGOTIATE': {
        const current = conv.context.currentItems as CatalogItem[]
        if (current.length === 0 || !action.customerOffer || action.customerOffer <= 0) return false
        const accepted = action.customerOffer >= action.floorTotal
        const botPrice = accepted ? action.customerOffer : action.floorTotal
        const pricedItems = this.allocateAgreedPrices(current, botPrice)
        const updatedLedger: CommerceLedger = {
          ...ledger,
          items: ledger.items.map(item => {
            const priced = pricedItems.find(p =>
              (item.productId && p.productId === item.productId) ||
              item.productName.toLowerCase() === p.productName.toLowerCase()
            )
            if (!priced) return item
            return {
              ...item,
              quantity: priced.quantity,
              quotedUnitPrice: priced.unitPrice,
              floorUnitPrice: priced.floorUnitPrice,
              agreedUnitPrice: priced.agreedPrice ? priced.agreedPrice / priced.quantity : undefined,
              status: accepted ? 'agreed' : 'quoted',
            }
          }),
          draftOrder: accepted ? { status: 'ready', total: botPrice } : ledger.draftOrder,
        }
        const reply = this.counterReply(current, botPrice)
        await this.transitionOrUpdate(conv, 'NEGOTIATING', {
          ...this.ledgerContextUpdate(conv, updatedLedger),
          currentItems: pricedItems,
          lastQuotedPrice: botPrice,
          minimumAcceptableTotal: action.floorTotal,
          agreedPrice: accepted ? botPrice : undefined,
          awaitingOrderConfirmation: false,
          negotiationHistory: [
            ...conv.context.negotiationHistory,
            { price: action.customerOffer, from: 'customer', timestamp: new Date().toISOString() },
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

      case 'ESCALATE_TO_MERCHANT': {
        if (action.reason === 'ambiguous_product') return false
        const reason = String(action.reason)
        const alreadyEscalated =
          conv.context.automationPausedUntil &&
          new Date(conv.context.automationPausedUntil) > new Date() &&
          conv.context.escalationReason === reason
        if (alreadyEscalated) return true

        const isOutOfStock = action.reason === 'out_of_stock'
        const itemNames = isOutOfStock
          ? ledger.items.filter(i => i.status !== 'removed').map(i => i.productName).join(', ')
          : null
        const customerReply = isOutOfStock
          ? this.handoffMessage(botConfig, `Let me confirm stock availability for ${itemNames} and get back to you.`)
          : this.handoffMessage(botConfig, "Let me confirm this and get back to you shortly.")
        const clearedLedger: CommerceLedger = {
          ...ledger,
          signals: {
            ...ledger.signals,
            complaint: false,
          },
        }
        await this.stateMachine.updateContext(conv, {
          ...this.ledgerContextUpdate(conv, clearedLedger),
          automationPausedUntil: new Date(Date.now() + MANUAL_REPLY_PAUSE_MS).toISOString(),
          escalationReason: reason,
          recentBotReply: customerReply,
        })
        await this.notifyMerchant(
          conv.merchantId,
          isOutOfStock
            ? `Stock check needed — ${itemNames}. Customer wants to order but stock is insufficient.`
            : `Customer needs attention: ${action.reason}`,
        )
        await this.nats.publish({
          subject: SUBJECTS.NOTIFICATION_SEND,
          merchantId: conv.merchantId,
          to: conv.customerPhone,
          channel: 'whatsapp' as const,
          message: customerReply,
        } satisfies NotificationSendEvent)
        return true
      }

      default:
        return false
    }
  }

  private async handleLedgerBotDecision(
    conv: Parameters<ConversationStateMachine['transition']>[0],
    nlp: BotNlpInput,
    merchantProducts: ProductRow[],
    botConfig: MerchantBotConfig,
    rawOfferPrice?: number,
    rawText = '',
  ): Promise<boolean> {
    if (merchantProducts.length === 0 && nlp.items.length > 0) return false
    const paymentDetailsRequested = !rawOfferPrice && isPaymentDetailsRequest(rawText)
    const hasItemlessActionSignal = paymentDetailsRequested ||
      rawOfferPrice ||
      nlp.agreementSignalDetected ||
      nlp.intent === 'AGREEMENT' ||
      nlp.intent === 'PAYMENT_INTENT' ||
      nlp.intent === 'COUNTER_OFFER' ||
      nlp.signals?.asksForAccount ||
      nlp.signals?.asksDelivery ||
      nlp.signals?.paymentIntent ||
      nlp.signals?.complaint ||
      Boolean(nlp.facts?.deliveryAddress || nlp.facts?.paymentReference || nlp.facts?.customerName)
    if ((nlp.intent === 'ORDER' || nlp.intent === 'INQUIRY') && nlp.items.length === 0 && !hasItemlessActionSignal) {
      return false
    }
    const ledger = normalizeLedger(conv.context, conv.customerPhone)
    const nextLedger = applyNlpToLedger(ledger, {
      ...nlp,
      intent: rawOfferPrice ? 'COUNTER_OFFER' : nlp.intent,
      counterOfferPrice: rawOfferPrice ?? nlp.counterOfferPrice,
      signals: {
        ...nlp.signals,
        asksForAccount: nlp.signals?.asksForAccount || paymentDetailsRequested,
        agreement: paymentDetailsRequested || nlp.agreementSignalDetected || nlp.intent === 'AGREEMENT',
        paymentIntent: nlp.signals?.paymentIntent || nlp.intent === 'PAYMENT_INTENT',
      },
      facts: nlp.facts,
    }, merchantProducts)
    const readiness = evaluateDraftReadiness(nextLedger, merchantProducts)
    const action = decideNextAction(nextLedger, readiness)
    return this.executeLedgerAction(conv, action, botConfig, nextLedger)
  }

  private async handleBotModeText(
    conv: Parameters<ConversationStateMachine['transition']>[0],
    nlp: BotNlpInput,
    merchantProducts: ProductRow[],
    botConfig: MerchantBotConfig,
    rawOfferPrice?: number,
    rawText = '',
  ): Promise<boolean> {
    // Order is already placed or committed — don't re-enter the agreement/quote flow.
    // ORDER_CREATED/AWAITING_PAYMENT are post-order states.
    // AGREED + awaitingOrderConfirmation=false means createBotOrder was already called (narrow window
    // before handleConfirmed completes its ORDER_CREATED transition); block re-entry there too.
    if (conv.state === 'ORDER_CREATED' || conv.state === 'AWAITING_PAYMENT') return false
    if (conv.state === 'AGREED' && !conv.context.awaitingOrderConfirmation) return false

    if ((nlp.intent === 'ORDER' || nlp.intent === 'INQUIRY') && nlp.items.length > 0) {
      const rawCategory = this.extractCategoryFromText(rawText, merchantProducts)
      const rawCategoryMatches = rawCategory ? this.findCategoryMatches(rawCategory, merchantProducts) : []
      if (
        rawCategory &&
        rawCategoryMatches.length > 1 &&
        (nlp.items.length > 1 || nlp.items.some(item =>
          merchantProducts.filter(product => product.active && this.productMatches(product, item.productName)).length !== 1
        )) &&
        nlp.items.every(item => this.itemMatchesCategory(item, rawCategory, merchantProducts))
      ) {
        if (await this.replyWithCategoryMatches(conv, rawCategory, merchantProducts)) {
          return true
        }
      }

      const ambiguous = nlp.items.find(item =>
        merchantProducts.filter(product => product.active && this.productMatches(product, item.productName)).length > 1 ||
        this.findCategoryMatches(item.productName, merchantProducts).length > 1
      )
      if (ambiguous) {
        const preserved = this.resolveUnambiguousCatalogItems(nlp.items, merchantProducts, ambiguous.productName)
        const merged = preserved.length > 0
          ? await this.stateMachine.updateContext(conv, {
            checkoutStage: 'product_clarification',
            currentItems: this.mergeCatalogItems(conv.context.currentItems as CatalogItem[], preserved),
          })
          : conv
        if (await this.replyWithCategoryMatches(merged, ambiguous.productName, merchantProducts)) {
          return true
        }
      }
    }

    if (await this.handleLedgerBotDecision(conv, nlp, merchantProducts, botConfig, rawOfferPrice, rawText)) {
      return true
    }

    if (conv.context.awaitingOrderConfirmation && (nlp.intent === 'INQUIRY' || nlp.intent === 'ORDER') && nlp.items.length > 0) {
      const resolved = this.resolveCatalogItems(nlp.items, merchantProducts)
      if (!resolved.ok) {
        if (resolved.reason === 'unknown') {
          const preserved = this.resolveUnambiguousCatalogItems(nlp.items, merchantProducts, resolved.productName)
          const merged = preserved.length > 0
            ? await this.stateMachine.updateContext(conv, {
              checkoutStage: 'product_clarification',
              currentItems: this.mergeCatalogItems(conv.context.currentItems as CatalogItem[], preserved),
            })
            : conv
          if (await this.replyWithCategoryMatches(merged, resolved.productName, merchantProducts)) {
            return true
          }
        }
        await this.escalateUnknownProduct(conv, resolved.productName, resolved.reason, merchantProducts, botConfig)
        return true
      }

      const mergedItems = this.mergeCatalogItems(conv.context.currentItems as CatalogItem[], resolved.items)
      const listTotal = mergedItems.reduce((sum, item) => sum + item.unitPrice * item.quantity, 0)
      const floorTotal = mergedItems.reduce((sum, item) => sum + item.floorUnitPrice * item.quantity, 0)
      const reply = this.quoteText(mergedItems, listTotal)
      await this.transitionOrUpdate(conv, 'NEGOTIATING', {
        checkoutStage: 'product_selection',
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
        // General "what do you have?" query — list the full catalog
        if (this.isCatalogBrowsingRequest(rawText)) {
          const reply = this.catalogAllText(merchantProducts)
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
      const resolved = this.resolveCatalogItems(nlp.items, merchantProducts)
      if (!resolved.ok) {
        if (resolved.reason === 'unknown') {
          const preserved = this.resolveUnambiguousCatalogItems(nlp.items, merchantProducts, resolved.productName)
          const merged = preserved.length > 0
            ? await this.stateMachine.updateContext(conv, {
              checkoutStage: 'product_clarification',
              currentItems: this.mergeCatalogItems(conv.context.currentItems as CatalogItem[], preserved),
            })
            : conv
          if (await this.replyWithCategoryMatches(merged, resolved.productName, merchantProducts)) {
            return true
          }
        }
        await this.escalateUnknownProduct(conv, resolved.productName, resolved.reason, merchantProducts, botConfig)
        return true
      }

      const reply = this.quoteText(resolved.items, resolved.listTotal)
      await this.transitionOrUpdate(conv, 'NEGOTIATING', {
        checkoutStage: 'product_selection',
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
        checkoutStage: 'cart_confirmation',
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

    if (!offeredPrice && nlp.intent === 'COUNTER_OFFER' && (conv.context.currentItems as CatalogItem[]).length > 0) {
      // Customer signalled a counter-offer but no price was extractable ("abeg reduce am", "can you do better?").
      // Prompt them to name a price rather than going silent.
      const reply = "What price are you offering?"
      await this.nats.publish({
        subject: SUBJECTS.NOTIFICATION_SEND,
        merchantId: conv.merchantId,
        to: conv.customerPhone,
        channel: 'whatsapp' as const,
        message: reply,
      } satisfies NotificationSendEvent)
      return true
    }

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
      checkoutStage: 'payment_pending',
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

    const ledger = normalizeLedger(conv.context, conv.customerPhone)
    await this.stateMachine.updateContext(conv, {
      ledger: {
        ...ledger,
        payment: {
          ...ledger.payment,
          status: 'proof_received',
          amount: parseFloat(order.total),
        },
        draftOrder: {
          ...ledger.draftOrder,
          status: 'merchant_confirmed',
          orderId,
        },
      },
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
      to: conv.customerPhone,
      channel: 'whatsapp' as const,
      message: monoAccountId
        ? 'Thanks. I am checking the payment and will confirm shortly.'
        : 'Thanks. I have sent this to the merchant to confirm payment.',
    } satisfies NotificationSendEvent)

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
  }

  private async handleCustomerProductMedia(
    merchantId: string,
    message: InboundMessageEvent['message'],
    conv: Parameters<ConversationStateMachine['updateContext']>[0],
  ): Promise<void> {
    if (message.channel !== 'whatsapp') return
    if (!message.mediaId) return

    const merchantChannel = await this.db.query.merchantChannels.findFirst({
      where: and(eq(merchantChannels.merchantId, merchantId), eq(merchantChannels.channel, 'whatsapp')),
      columns: { accessToken: true },
    })
    const { buffer, mimeType } = await downloadMedia(message.mediaId, merchantChannel?.accessToken ?? undefined)
    const mediaUrl = await uploadScreenshot(buffer, mimeType)
    const mediaLabel = message.type === 'document' ? 'document' : 'image'
    const caption = message.caption?.trim()

    await this.stateMachine.appendMessage(
      conv,
      'customer',
      caption ? `[${mediaLabel}: ${caption}]` : `[${mediaLabel}]`,
    )

    const catalog = await this.db.query.products.findMany({
      where: and(eq(products.merchantId, merchantId), eq(products.active, true)),
    })

    if (message.type === 'image' && (mimeType ?? '').startsWith('image/')) {
      try {
        const analysis = await analyzeProductImage(mediaUrl, catalog.map(product => ({
          name: product.name,
          aliases: product.aliases ?? [],
          price: product.price ? parseFloat(product.price) : undefined,
          stockQuantity: product.stockQuantity,
        })))
        const candidate = analysis.candidateProductName
          ? catalog.find(product => product.name.toLowerCase() === analysis.candidateProductName?.toLowerCase())
          : undefined
        if (candidate && analysis.confidence >= 0.78 && candidate.stockQuantity > 0) {
          const price = candidate.lastPrice ? parseFloat(candidate.lastPrice) : parseFloat(candidate.price)
          const reply = `I can see this looks like ${candidate.name}. Price is ${this.formatMoney(price)}. If that's right, reply "${candidate.name}" so I can add it.`
          await this.stateMachine.updateContext(conv, {
            checkoutStage: 'product_selection',
            recentBotReply: reply,
          })
          await this.nats.publish({
            subject: SUBJECTS.NOTIFICATION_SEND,
            merchantId,
            to: message.customerId,
            channel: message.channel,
            message: reply,
          } satisfies NotificationSendEvent)
          return
        }

        await this.notifyMerchantForCustomerMedia(merchantId, conv.id, conv.customerPhone, mediaUrl, mediaLabel, {
          candidateProductName: analysis.candidateProductName,
        })
      } catch (err) {
        console.warn(JSON.stringify({
          level: 'warn',
          msg: 'product_image_analysis_failed',
          merchantId,
          conversationId: conv.id,
          err: err instanceof Error ? err.message : String(err),
        }))
        await this.notifyMerchantForCustomerMedia(merchantId, conv.id, conv.customerPhone, mediaUrl, mediaLabel, {
          candidateProductName: undefined,
        })
      }
    } else {
      await this.notifyMerchantForCustomerMedia(merchantId, conv.id, conv.customerPhone, mediaUrl, mediaLabel, {
        candidateProductName: undefined,
      })
    }

    const reply = `I received the ${mediaLabel}. Let me ask the store to confirm this item and get back to you.`
    await this.stateMachine.updateContext(conv, {
      automationPausedUntil: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
      escalationReason: 'customer_product_media',
      recentBotReply: reply,
    })
    await this.nats.publish({
      subject: SUBJECTS.NOTIFICATION_SEND,
      merchantId,
      to: message.customerId,
      channel: message.channel,
      message: reply,
    } satisfies NotificationSendEvent)
  }

  private async notifyMerchantForCustomerMedia(
    merchantId: string,
    conversationId: string,
    customerPhone: string,
    mediaUrl: string,
    mediaLabel: string,
    details: {
      candidateProductName?: string
    },
  ): Promise<void> {
    const merchant = await this.db.query.merchants.findFirst({
      where: eq(merchants.id, merchantId),
      columns: { phone: true },
    })
    if (!merchant?.phone) return

    await this.pending?.upsert(merchantId, 'PENDING_PRODUCT_MEDIA_CONFIRMATION', {
      conversationId,
      customerPhone,
      mediaUrl,
      mediaLabel: mediaLabel === 'document' ? 'document' : 'image',
      candidateProductName: details.candidateProductName,
    })

    const parts = [
      `Customer sent a product ${mediaLabel}.`,
      `Customer: ${customerPhone}`,
      details.candidateProductName ? `Possible match: ${details.candidateProductName}` : undefined,
      'Reply YES <price> if available, or NO if not available.',
      `Media: ${mediaUrl}`,
    ].filter(Boolean)

    await this.nats.publish({
      subject: SUBJECTS.NOTIFICATION_SEND,
      merchantId,
      to: merchant.phone,
      channel: 'whatsapp' as const,
      message: parts.join('\n'),
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
    const ledger = normalizeLedger(conv.context, conv.customerPhone)
    await this.transitionLedgerAction(conv, 'ORDER_CREATED', {
      orderId,
      ledger: {
        ...ledger,
        draftOrder: {
          ...ledger.draftOrder,
          status: 'merchant_confirmed',
          orderId,
          total: ledger.draftOrder?.total ?? conv.context.agreedPrice ?? conv.context.lastQuotedPrice,
        },
      },
    })
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
    const ledger = normalizeLedger(conv.context, conv.customerPhone)
    await this.transitionLedgerAction(conv, 'AWAITING_PAYMENT', {
      orderId,
      ledger: {
        ...ledger,
        payment: {
          ...ledger.payment,
          status: 'requested',
        },
        draftOrder: {
          ...ledger.draftOrder,
          status: 'merchant_confirmed',
          orderId,
          total: ledger.draftOrder?.total ?? conv.context.agreedPrice ?? conv.context.lastQuotedPrice,
        },
      },
    })
  }

  async markPaymentVerified(conversationId: string, orderId: string, amount: number, reference?: string): Promise<void> {
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
    const ledger = normalizeLedger(conv.context, conv.customerPhone)
    await this.transitionLedgerAction(conv, 'PAYMENT_RECEIVED', {
      orderId,
      ledger: {
        ...ledger,
        payment: {
          ...ledger.payment,
          status: 'verified',
          amount,
          reference: reference ?? ledger.payment.reference,
        },
        draftOrder: {
          ...ledger.draftOrder,
          status: 'merchant_confirmed',
          orderId,
          total: ledger.draftOrder?.total ?? conv.context.agreedPrice ?? conv.context.lastQuotedPrice,
        },
      },
    })
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

    const pendingProductMedia = this.pending
      ? await this.pending.get<PendingProductMediaPayload>(merchantId, 'PENDING_PRODUCT_MEDIA_CONFIRMATION')
      : null
    if (pendingProductMedia) {
      const availability = parseAvailabilityReply(text)
      if (!availability) return

      const record = await this.db.query.conversations.findFirst({
        where: eq(conversations.id, pendingProductMedia.conversationId),
      })
      if (!record) {
        if (this.pending) await this.pending.resolve(merchantId, 'PENDING_PRODUCT_MEDIA_CONFIRMATION', 'CANCELLED')
        return
      }
      const conv = await this.stateMachine.getOrCreate(
        record.merchantId,
        record.channel,
        record.customerPhone,
        record.id,
      )

      if (!availability.available) {
        const reply = "Sorry, the store confirmed this item is not available."
        await this.stateMachine.updateContext(conv, {
          automationPausedUntil: undefined,
          escalationReason: undefined,
          recentBotReply: reply,
        })
        await this.nats.publish({
          subject: SUBJECTS.NOTIFICATION_SEND,
          merchantId,
          to: pendingProductMedia.customerPhone,
          channel: conv.channel as 'whatsapp',
          message: reply,
        } satisfies NotificationSendEvent)
        if (this.pending) await this.pending.resolve(merchantId, 'PENDING_PRODUCT_MEDIA_CONFIRMATION', 'CANCELLED')
        return
      }

      if (!availability.price) {
        await this.nats.publish({
          subject: SUBJECTS.NOTIFICATION_SEND,
          merchantId,
          to: merchantPhone,
          channel: 'whatsapp' as const,
          message: 'Please reply with the price too, e.g. YES 15000. Reply NO if it is not available.',
        } satisfies NotificationSendEvent)
        return
      }

      const itemName = pendingProductMedia.candidateProductName ?? 'the item in your image'
      const reply = pendingProductMedia.candidateProductName
        ? `The store confirmed ${itemName} is available for ${this.formatMoney(availability.price)}. Reply "${pendingProductMedia.candidateProductName}" if you'd like me to add it.`
        : `The store confirmed the item in your image is available for ${this.formatMoney(availability.price)}. Would you like to order it?`
      await this.stateMachine.updateContext(conv, {
        automationPausedUntil: undefined,
        escalationReason: undefined,
        recentBotReply: reply,
      })
      await this.nats.publish({
        subject: SUBJECTS.NOTIFICATION_SEND,
        merchantId,
        to: pendingProductMedia.customerPhone,
        channel: conv.channel as 'whatsapp',
        message: reply,
      } satisfies NotificationSendEvent)
      if (this.pending) await this.pending.resolve(merchantId, 'PENDING_PRODUCT_MEDIA_CONFIRMATION', 'DONE')
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

    // resume bot for the most recently manually-handled conversation
    if (lower === 'resume' || lower === 'resume bot' || lower === 'bot on') {
      const customerPhone = await this.redis.get(`last_paused_customer:${merchantId}`)
      if (customerPhone) {
        const convId = await this.getOrCreateConversationId(merchantId, 'whatsapp', customerPhone)
        const pausedConv = await this.stateMachine.getOrCreate(merchantId, 'whatsapp', customerPhone, convId)
        await this.stateMachine.updateContext(pausedConv, { automationPausedUntil: undefined })
        await this.redis.del(`last_paused_customer:${merchantId}`)
        await notify(`Bot resumed for ${customerPhone}.`)
      } else {
        await notify('No paused conversations found.')
      }
      return
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
        source: 'ledger',
        conversationId: agreed.id,
        merchantId: agreed.merchantId,
        customerPhone: agreed.customerPhone,
        items: agreed.context.currentItems,
        agreedTotal: 0,
      }

      if (this.eventStore) {
        if (this.orderHandler) await this.orderHandler.handleDetected(orderEvent)
        await this.eventStore.emit(orderEvent)
      } else {
        if (this.orderHandler) await this.orderHandler.handleDetected(orderEvent)
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
      source: 'ledger',
      conversationId: agreed.id,
      merchantId: agreed.merchantId,
      customerPhone: agreed.customerPhone,
      items: agreed.context.currentItems,
      agreedTotal,
    }

    if (this.eventStore) {
      if (this.orderHandler) await this.orderHandler.handleDetected(orderEvent)
      await this.eventStore.emit(orderEvent)
    } else {
      if (this.orderHandler) await this.orderHandler.handleDetected(orderEvent)
      await this.nats.publish(orderEvent)
    }
  }

  private async handleRepeatCustomerMemory(
    conv: Parameters<ConversationStateMachine['transition']>[0],
    text: string,
    botEnabled: boolean,
  ): Promise<boolean> {
    const latestOrders = await this.db.query.orders.findMany({
      where: and(
        eq(orders.merchantId, conv.merchantId),
        eq(orders.customerPhone, conv.customerPhone),
      ),
      orderBy: [desc(orders.createdAt)],
      limit: 5,
      with: { items: true },
    })
    const source = latestOrders.find(order =>
      ['CONFIRMED', 'AWAITING_PAYMENT', 'PAID', 'FULFILLED'].includes(order.status) &&
      order.items.length > 0
    )
    if (!source) return false

    const quantityOverride = repeatQuantityOverride(text)
    const canApplyOverride = source.items.length === 1 && quantityOverride != null
    const items: CatalogItem[] = source.items.map(item => {
      const quantity = canApplyOverride ? quantityOverride! : item.quantity
      const unitPrice = Number(item.unitPrice)
      const agreedUnitPrice = Number(item.agreedPrice)
      return {
        productId: item.productId ?? '',
        productName: item.productName,
        quantity,
        unitPrice: Number.isFinite(unitPrice) && unitPrice > 0 ? unitPrice : agreedUnitPrice,
        floorUnitPrice: Number.isFinite(agreedUnitPrice) && agreedUnitPrice > 0 ? agreedUnitPrice : unitPrice,
        agreedPrice: Number.isFinite(agreedUnitPrice) && agreedUnitPrice > 0 ? agreedUnitPrice * quantity : undefined,
      }
    }).filter(item => item.productName && item.quantity > 0 && item.unitPrice > 0)

    if (items.length === 0) return false

    const total = items.reduce((sum, item) => {
      const unit = item.agreedPrice && item.quantity > 0 ? item.agreedPrice / item.quantity : item.unitPrice
      return sum + unit * item.quantity
    }, 0)
    const updated = await this.transitionOrUpdate(conv, 'NEGOTIATING', {
      currentItems: items,
      lastQuotedPrice: total,
      agreedPrice: undefined,
      awaitingOrderConfirmation: false,
      repeatCustomerMemory: {
        sourceOrderId: source.id,
        resolvedAt: new Date().toISOString(),
        reason: 'repeat_order_reference',
        items,
        total,
      },
    })

    if (!botEnabled) {
      await this.handleAgreement(updated)
      return true
    }

    const summary = this.orderSummaryText(items, total)
    const reply = `I found your last order:\n\n${summary}\n\nIs this what you want to order again?`
    await this.transitionOrUpdate(updated, 'AGREED', {
      checkoutStage: 'cart_confirmation',
      agreedPrice: total,
      lastQuotedPrice: total,
      awaitingOrderConfirmation: true,
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
