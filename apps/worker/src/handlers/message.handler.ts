import { createHash, randomBytes } from 'crypto'
import type { Db } from '@mesa/db'
import { agentTasks, conversations, merchants, orders, payments, products, merchantChannels, statusPosts } from '@mesa/db'
import type { MesaNatsClient } from '@mesa/nats'
import {
  InboundMessage,
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
  TRACKING_LINK_PLATFORMS,
  TrackingLinkPlatform,
} from '@mesa/types'
import { analyseMessage, analyzeProductImage, type KnownProduct } from '@mesa/ai'
import { downloadMedia } from '@mesa/whatsapp'
import { notifyMerchantOnSourceChannel } from './notify-merchant'
import { uploadScreenshot } from '../storage/r2'
import { ConversationStateMachine } from '../conversation/state-machine'
import {
  applyNlpToLedger,
  applyMerchantAcceptanceToLedger,
  applyMerchantQuoteToLedger,
  isSimilarProductName,
  applyValidatedLedgerPatch,
  contextWithLedger,
  decideNextAction,
  evaluateDraftReadiness,
  itemKey,
  normalizeLedger,
  type DraftOrder,
  type NextAction,
} from '../conversation/commerce-ledger'
import type { CommerceLedger } from '@mesa/types'
import type { Redis } from 'ioredis'
import { desc, eq, and } from 'drizzle-orm'
import type { OrderHandler } from './order.handler'
import { config as appConfig } from '@mesa/config'
import type { PendingDecisions, PendingFulfilmentPayload, PendingOrderPayload, PendingPaymentPayload } from './pending-decisions'
import type { AiQuota } from '../ai/quota'
import type { FulfilmentHandler } from './fulfilment.handler'
import { inboundCustomerMessages } from '../metrics'

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
  return /^(confirm|confirmed|yes confirm|go ahead|proceed|done|ok confirm|okay confirm|oya confirm|alright confirm|yes proceed|confirm (it|am|am o|the order|order)|nothing else|no (more|other|anything)|that('s| is) (all|it)|just confirm|pls confirm|please confirm|abeg confirm)$/.test(n)
    || /^(yes|ok|okay|oya|yep|yh|yeah|sure|alright|aight)(?:\s+(?:please|pls|abeg))?$/.test(n)
    || /^(?:yes|ok|okay|sure|fine|yeah|yep|yh|oya|alright|aight)\s+(?:please|pls|abeg)$/.test(n)
    || /^(?:(?:ok|okay|yes|sure|fine|alright|aight)[,\s]+)?(?:(?:i('|’)ll|i will|i go|i wan|i want to)\s+)?(?:take|buy|get|order)\s+(?:it|this|that)$/.test(n)
}

function isBareGreeting(text: string): boolean {
  return /^(hi|hello|hey|yo|good morning|good afternoon|good evening|gm|ga)$/i.test(normalizeReply(text))
}

function newSessionId(): string {
  return randomBytes(8).toString('hex')
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

// Parse a standalone money token, honouring Nigerian shorthand suffixes:
// "38k" → 38000, "1.5m" → 1500000, "38,000" → 38000, "₦38k" → 38000.
export function parseMoneyToken(raw: string): number | null {
  const cleaned = raw.trim().replace(/\s*naira$/i, '')
  const match = cleaned.match(/^[₦#$]?\s*(\d+(?:,\d{3})*(?:\.\d+)?)\s*([km])?$/i)
  if (!match) return null
  let value = Number(match[1].replace(/,/g, ''))
  if (!Number.isFinite(value) || value <= 0) return null
  const suffix = match[2]?.toLowerCase()
  if (suffix === 'k') value *= 1_000
  if (suffix === 'm') value *= 1_000_000
  return value
}

// Parse a merchant price reply. Accepts only messages whose entire body is a
// money token (optionally with a ₦/#/$ prefix, a "PRICE " prefix, commas, or
// a k/m suffix). "CONFIRM <number>" forces acceptance past the sanity check.
//
// Examples accepted: "5000", "5,000", "₦5000", "38k", "PRICE 5000", "CONFIRM ₦5,000"
// Examples rejected: "tomorrow at 3pm", "send 5000 later", "YES 5000"
export function parsePriceReply(text: string): { value: number; forced: boolean } | null {
  let body = text.trim()
  const forced = /^confirm\s+/i.test(body)
  body = body
    .replace(/^confirm\s+/i, '')
    .replace(/^price\s+/i, '')
  const value = parseMoneyToken(body)
  if (value == null) return null
  return { value, forced }
}

export function parseOrderCorrection(text: string): { items: DetectedOrderItem[]; total: number } | null {
  const [rawItems, rawTotal, ...rest] = text.split('=')
  if (!rawItems || !rawTotal || rest.length > 0) return null

  const total = parseMoneyToken(rawTotal)
  if (total == null) return null

  const items = rawItems
    .split(/[,;\n]+/)
    .map(part => part.trim())
    .filter(Boolean)
    .map(part => {
      const match = part.match(/^(\d+(?:\.\d+)?)\s*x\s+(.+)$/i)
      if (!match) return null
      const quantity = Number(match[1])
      let productName = match[2].trim()
      if (!Number.isFinite(quantity) || quantity <= 0 || !productName) return null

      // Optional per-item price: "1x bag - 20000" — agreedPrice is the
      // line's total (matches how DetectedOrderItem.agreedPrice is used
      // everywhere else). Only split on the LAST " - "/"—" and only treat
      // it as a price if the trailing segment parses as one whole money
      // token — a product name that legitimately contains a hyphen (e.g.
      // "SP-700W solar panel") is left untouched otherwise.
      let agreedPrice: number | undefined
      const priceSplit = productName.match(/^(.+?)\s*[-—]\s*([^-—]+)$/)
      if (priceSplit) {
        const maybePrice = parseMoneyToken(priceSplit[2])
        if (maybePrice != null && priceSplit[1].trim()) {
          productName = priceSplit[1].trim()
          agreedPrice = maybePrice
        }
      }

      return {
        productName,
        quantity,
        ...(agreedPrice != null ? { agreedPrice } : {}),
      } satisfies DetectedOrderItem
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

function deriveAdSourcePlatform(referral: NonNullable<InboundMessage['referral']>): string {
  const url = referral.sourceUrl ?? ''
  if (/instagram\.com/i.test(url)) return 'instagram_ad'
  if (/facebook\.com|fb\.com/i.test(url)) return 'facebook_ad'
  return 'meta_ad'
}

export interface ResolvedSource {
  source: string
  confidence: 'confirmed' | 'estimated'
}

// Order-source attribution for a single inbound message. Returns null when
// there is no fresh signal — callers must NEVER let a null result clear a
// previously-detected source back to null; it only means "this particular
// message carried no new evidence".
//
// A click record is required for every organic-link tier below — a message
// merely mentioning a platform name ("hey I saw this on tiktok") with no
// tracking-link click behind it must never be auto-tagged "confirmed"; that
// would misattribute ordinary chatter as a marketing win.
export async function resolveInboundSource(
  message: InboundMessage,
  merchantId: string,
  redis: Redis,
): Promise<ResolvedSource | null> {
  // Tier 0: Meta's own deterministic referral on a paid Click-to-WhatsApp ad.
  if (message.referral) {
    return { source: deriveAdSourcePlatform(message.referral), confidence: 'confirmed' }
  }

  // Tiers 1/2: organic tracking-link clicks, correlated by short-TTL Redis
  // keys the API's redirect route sets on every click (see LINK_CLICKED).
  const keys = TRACKING_LINK_PLATFORMS.map(p => `click:${merchantId}:${p}`)
  const values = await redis.mget(...keys).catch(() => null)
  if (!values) return null

  const candidates = TRACKING_LINK_PLATFORMS.filter((_, i) => values[i] != null)
  if (candidates.length !== 1) return null // no click, or ambiguous (multiple recent clicks)

  const platform: TrackingLinkPlatform = candidates[0]
  const text = message.text?.toLowerCase() ?? ''
  const confidence = text.includes(platform) ? 'confirmed' : 'estimated'
  return { source: platform, confidence }
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
const INACTIVE_SESSION_STATES = new Set<ConversationState>(['IDLE', 'BROWSING', 'COMPLETE'])

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

function minimumTotalForItems(items: DetectedOrderItem[], fallback?: number): number {
  const total = items.reduce((sum, item) => {
    const priced = item as DetectedOrderItem & { floorUnitPrice?: number; unitPrice?: number }
    return sum + ((priced.floorUnitPrice ?? priced.unitPrice ?? 0) * item.quantity)
  }, 0)
  return total > 0 ? total : fallback ?? 0
}

function isFreshShoppingOpener(text: string): boolean {
  const normalized = normalizeReply(text)
  if (normalized === 'done') return false
  if (isConfirmationPhrase(text) || isPaymentDetailsRequest(text) || isLastPriceQuestion(text)) return false
  if (/\b(paid|payment|transfer|receipt|proof|screenshot|sent|remove|cancel|refund|dispute|address|deliver|delivery)\b/.test(normalized)) {
    return false
  }
  // A message negotiating a specific naira amount ("if you gree 35k i go
  // take am", "make it ₦20,000") is continuing an existing deal, not
  // starting a new one — even though it also contains "take"/"buy"/"get" as
  // ordinary words. A bare quantity ("2 bag of rice") is NOT excluded here:
  // that's exactly what a genuine fresh order request looks like.
  if (/(?:₦|#)\s*\d[\d,]*|\b\d[\d,]*\s*(k|m)\b/i.test(normalized)) return false
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

// An agreement turn confirms the cart that was negotiated — it must never
// invent items. Haiku sees the catalog + history and sometimes re-extracts
// products the customer never asked for ("Is there polo available?" →
// "Alright I'll take it" suddenly carrying BOTH catalog polos). An NLP item
// on an agreement turn survives only if the customer's own words mention the
// product (by extracted name, catalog name, or a merchant-defined alias).
function itemMentionedInText(
  item: DetectedOrderItem,
  text: string,
  catalog: Array<{ name: string; aliases: string[] | null }>,
): boolean {
  const normalized = normalizeReply(text)
  const candidates = new Set<string>([item.productName.toLowerCase()])
  const product = catalog.find(p =>
    p.name.toLowerCase() === item.productName.toLowerCase() ||
    (p.aliases ?? []).some(a => a.toLowerCase() === item.productName.toLowerCase()))
  if (product) {
    candidates.add(product.name.toLowerCase())
    for (const alias of product.aliases ?? []) candidates.add(alias.toLowerCase())
  }
  return [...candidates].some(term => term.length > 1 && normalized.includes(term))
}

// Haiku sometimes flags negotiation pressure ("be like you no won sell for me
// abi") as a complaint. Only honour the signal when the words actually report
// a problem, or the customer already has an order in flight to complain about.
function looksLikeComplaint(text: string, state: ConversationState): boolean {
  const n = normalizeReply(text)
  if (/\b(refund|return|complain|complaint|wrong (item|thing|product|size|colou?r)|bad (product|item)|fake|scam|damag\w*|tear|spoil\w*|no dey work|not working|stop working|disappoint\w*|angry|vex)\b/.test(n)) {
    return true
  }
  return POST_ORDER_STATES.has(state)
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

  private appendCustomerMessage(
    conv: Parameters<ConversationStateMachine['appendMessage']>[0],
    message: InboundMessageEvent['message'],
  ): Promise<Parameters<ConversationStateMachine['appendMessage']>[0]> {
    return this.stateMachine.appendMessage(conv, 'customer', message.text ?? message.caption ?? '', 10, {
      messageId: message.messageId,
      replyContext: message.context,
    })
  }

  private async seedProductFromReplyContext(
    conv: Parameters<ConversationStateMachine['updateContext']>[0],
    merchantId: string,
    message: InboundMessageEvent['message'],
    catalog: Array<typeof products.$inferSelect>,
  ): Promise<Parameters<ConversationStateMachine['updateContext']>[0]> {
    const replyContext = message.context
    if (!replyContext) return conv

    const retailerId = replyContext.referredProduct?.productRetailerId
    let product = retailerId
      ? catalog.find(p => p.sku === retailerId || p.id === retailerId)
      : undefined

    if (!product && replyContext.id) {
      const statusPost = await this.db.query.statusPosts.findFirst({
        where: and(eq(statusPosts.merchantId, merchantId), eq(statusPosts.whatsappMessageId, replyContext.id)),
        columns: { productId: true },
      })
      if (statusPost?.productId) product = catalog.find(p => p.id === statusPost.productId)
    }

    if (!product) return conv
    if (conv.context.currentItems.some(item => {
      const withProductId = item as DetectedOrderItem & { productId?: string }
      return withProductId.productId === product.id || item.productName.toLowerCase() === product.name.toLowerCase()
    })) {
      return conv
    }

    const ledger = applyValidatedLedgerPatch(
      normalizeLedger(conv.context, conv.customerPhone),
      { items: [{ operation: 'add', productName: product.name }] },
      catalog,
    )

    return this.stateMachine.updateContext(conv, {
      checkoutStage: 'product_selection',
      ledger,
    })
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

  // Instagram attachments carry a directly-fetchable CDN URL (message.mediaUrl)
  // — no Graph API resolution needed. WhatsApp attachments carry an opaque
  // Graph media ID (message.mediaId) requiring downloadMedia()'s two-step
  // fetch. Shared by the payment-screenshot and product-photo handlers so
  // both work for either channel.
  private async fetchInboundMedia(
    merchantId: string,
    message: { mediaId?: string; mediaUrl?: string },
  ): Promise<{ buffer: Buffer; mimeType?: string }> {
    if (message.mediaUrl) {
      const res = await fetch(message.mediaUrl)
      if (!res.ok) throw new Error(`Instagram media fetch failed: ${res.status}`)
      const arrayBuffer = await res.arrayBuffer()
      return {
        buffer: Buffer.from(arrayBuffer),
        mimeType: res.headers.get('content-type') ?? undefined,
      }
    }

    if (!message.mediaId) throw new Error('Inbound message has no mediaId or mediaUrl')

    const merchantChannel = await this.db.query.merchantChannels.findFirst({
      where: and(eq(merchantChannels.merchantId, merchantId), eq(merchantChannels.channel, 'whatsapp')),
      columns: { accessToken: true },
    })
    return downloadMedia(message.mediaId, merchantChannel?.accessToken ?? undefined)
  }

  private async resetIfStale(
    conv: Parameters<ConversationStateMachine['transition']>[0],
  ): Promise<Parameters<ConversationStateMachine['transition']>[0]> {
    const lastAt = conv.context.lastMessageAt ? new Date(conv.context.lastMessageAt).getTime() : 0
    const isStale = Date.now() - lastAt > STALE_MS
    if (!isStale || !STUCK_STATES.includes(conv.state)) return conv

    const sessionId = newSessionId()
    return this.stateMachine.transition(conv, 'IDLE', {
      sessionId,
      currentItems: [],
      checkoutStage: 'product_selection',
      negotiationHistory: [],
      recentMessages: [],
      botRuntime: undefined,
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
    const shouldReset = (POST_ORDER_STATES.has(conv.state) || conv.state === 'AGREED') && isFreshShoppingOpener(text)
    if (!shouldReset) return conv
    return this.forceResetToIdle(conv)
  }

  // Shared by resetForFreshTransaction (text-pattern triggered) and
  // handleWithStaleStateRecovery (triggered by an actual failed transition —
  // see the comment on STALE_TRANSITION_ERROR above).
  private async forceResetToIdle(
    conv: Parameters<ConversationStateMachine['transition']>[0],
  ): Promise<Parameters<ConversationStateMachine['transition']>[0]> {
    const sessionId = newSessionId()
    const resetContext: Partial<ConversationContext> = {
      sessionId,
      currentItems: [],
      checkoutStage: 'product_selection',
      negotiationHistory: [],
      recentMessages: [],
      botRuntime: undefined,
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

  private async resetForFreshSession(
    conv: Parameters<ConversationStateMachine['transition']>[0],
    text?: string,
  ): Promise<Parameters<ConversationStateMachine['transition']>[0]> {
    if (!INACTIVE_SESSION_STATES.has(conv.state)) return conv
    if (!hasPendingDealContext(conv.context)) return conv
    if (text && !isBareGreeting(text) && !isFreshShoppingOpener(text)) return conv

    const sessionId = newSessionId()
    const resetContext: Partial<ConversationContext> = {
      sessionId,
      currentItems: [],
      checkoutStage: 'product_selection',
      negotiationHistory: [],
      recentMessages: [],
      botRuntime: undefined,
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

    if (this.stateMachine.canTransition(conv.state, 'IDLE')) {
      return this.stateMachine.transition(conv, 'IDLE', resetContext)
    }
    return this.stateMachine.updateContext(conv, resetContext)
  }

  // Customer messages and merchant echoes for the same chat arrive on separate
  // NATS consumers and both read-modify-write the conversation context.
  // Serialize per conversation so an echoed merchant quote can't be clobbered
  // by a concurrent NLP turn (observed in the field: vendor quotes lost when
  // messages arrive seconds apart).
  private async withConversationLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const lockKey = `conv_lock:${key}`
    const token = randomBytes(8).toString('hex')
    const deadline = Date.now() + 15_000
    while (Date.now() < deadline) {
      // Redis down/exhausted — same as a stuck holder: process rather than drop.
      const acquired = await this.redis.set(lockKey, token, 'PX', 30_000, 'NX').catch(() => null)
      if (acquired) {
        try {
          return await fn()
        } finally {
          const current = await this.redis.get(lockKey).catch(() => null)
          if (current === token) await this.redis.del(lockKey).catch(() => {})
        }
      }
      await new Promise(resolve => setTimeout(resolve, 150))
    }
    // Holder crashed or is stuck past the wait window — process rather than drop.
    return fn()
  }

  async handle(event: InboundMessageEvent): Promise<void> {
    const key = `${event.merchantId}:${event.message.channel}:${event.message.customerId}`
    return this.withConversationLock(key, () => this.handleWithStaleStateRecovery(event))
  }

  // isFreshShoppingOpener (used by resetForFreshTransaction below) can only
  // recognize text patterns we thought to anticipate — a returning customer's
  // first message often won't match ("let me give you 20k" before ever saying
  // "buy"). Rather than widen that regex forever, treat the state machine's
  // own rejection as the ground truth: any attempt to act on a customer
  // message from a completed-order state that isn't a valid transition means
  // the conversation is stale, not that the message should be dropped. Reset
  // once and reprocess the same message against a clean IDLE conversation.
  private static readonly STALE_TRANSITION_ERROR =
    /^Invalid transition: (ORDER_CREATED|AWAITING_PAYMENT|PAYMENT_RECEIVED|COMPLETE) →/

  private async handleWithStaleStateRecovery(event: InboundMessageEvent, alreadyRecovered = false): Promise<void> {
    try {
      await this.handleSerialized(event)
    } catch (err) {
      const isStaleTransition = err instanceof Error && MessageHandler.STALE_TRANSITION_ERROR.test(err.message)
      if (alreadyRecovered || !isStaleTransition) throw err

      const { merchantId, message } = event
      const convId = await this.getOrCreateConversationId(merchantId, message.channel, message.customerId)
      const conv = await this.stateMachine.getOrCreate(merchantId, message.channel, message.customerId, convId)
      if (!POST_ORDER_STATES.has(conv.state)) throw err

      await this.forceResetToIdle(conv)
      return this.handleWithStaleStateRecovery(event, true)
    }
  }

  private async handleSerialized(event: InboundMessageEvent): Promise<void> {
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

        await this.handleMerchantReply(merchantId, message.text, 'whatsapp')
        return
      }
    }

    // Instagram merchant replies arrive two ways, both tagged direction:
    // 'vendor' by the gateway (see packages/types InboundMessage), told apart
    // by channelAccountId — the same role WhatsApp's single-number gate above
    // plays, split across two accounts because Instagram has no equivalent of
    // "merchant's phone number == the number Mesa messages on":
    //   - Mesa's own platform account (mirrors the WhatsApp gate above): a
    //     merchant replying to Mesa directly — pending-decision actions only.
    //   - The merchant's own shop account (mirrors WhatsApp's message_echoes
    //     path below): the merchant typing natively to a customer — pending
    //     decisions AND ongoing negotiation quotes.
    if (message.channel === 'instagram' && message.direction === 'vendor') {
      const igChannel = await this.db.query.merchantChannels.findFirst({
        where: and(eq(merchantChannels.merchantId, merchantId), eq(merchantChannels.channel, 'instagram')),
        columns: { channelAccountId: true },
      })
      const isOwnShopAccountEcho = igChannel != null && message.channelAccountId === igChannel.channelAccountId

      if (!isOwnShopAccountEcho) {
        if (message.type !== 'text' || !message.text) return
        await this.handleMerchantReply(merchantId, message.text, 'instagram')
        return
      }

      // handleSerialized is already running inside handle()'s per-conversation
      // lock for this exact key — call the echo logic directly rather than
      // through handleMessageEcho's own lock wrapper, which would try to
      // re-acquire the same (non-reentrant) lock and stall for no reason.
      return this.handleMessageEchoSerialized(merchantId, message)
    }

    inboundCustomerMessages.add(1, { channel: message.channel, type: message.type })

    // Paused gate — skip all automated processing for customer messages
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

    // Order-source attribution — runs on every customer message (new or
    // existing conversation) so a returning customer's fresh ad-click/link
    // click ahead of a new order updates their attribution, rather than
    // being stuck with whatever (or nothing) was captured at first contact.
    // Only ever overwrites when a fresh signal is found — never clears a
    // previously-detected source back to null.
    const resolvedSource = await resolveInboundSource(message, merchantId, this.redis)
    if (resolvedSource) {
      await this.db.update(conversations)
        .set({ source: resolvedSource.source, sourceConfidence: resolvedSource.confidence })
        .where(eq(conversations.id, convId))
    }

    // Staleness reset: if the conversation has been in a non-terminal stuck
    // state for more than 4 hours with no activity, treat the next message as
    // a fresh start so old items never bleed into a new order.
    conv = await this.resetIfStale(conv)

    // Payment proofs can arrive as WhatsApp or Instagram images/documents.
    if ((message.type === 'image' || message.type === 'document') && conv.state === 'AWAITING_PAYMENT') {
      if (!message.mediaId && !message.mediaUrl) return

      const { buffer, mimeType } = await this.fetchInboundMedia(merchantId, message)
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

    if (conv.state === 'AWAITING_PAYMENT' && normalizeReply(message.text) === 'done') {
      await this.handleDonePayment(conv)
      conv = await this.appendCustomerMessage(conv, message)
      return
    }

    if (await this.fulfilmentHandler?.handleCustomerAddress(merchantId, message.customerId, message.text, message.channel)) {
      await this.appendCustomerMessage(conv, message)
      return
    }

    conv = await this.resetForFreshSession(conv, message.text)
    conv = await this.resetForFreshTransaction(conv, message.text)

    // Post-order: once an order is placed, the bot goes silent for plain text.
    // Only payment screenshots and DONE (handled above) are acted on. This
    // prevents the sales agent from re-entering the flow and wiping the cart
    // when the customer sends their name, address, or anything else.
    if (conv.state === 'ORDER_CREATED' || conv.state === 'AWAITING_PAYMENT') {
      await this.appendCustomerMessage(conv, message)
      return
    }

    const hasDealContext = hasPendingDealContext(conv.context)
    const trimmedText = message.text.trim()
    const rawOfferPrice = this.extractCustomerOfferPrice(message.text)
    let messageAppended = false

    if (
      conv.context.automationPausedUntil &&
      new Date(conv.context.automationPausedUntil) > new Date() &&
      !hasDealContext &&
      !hasCommerceSignal(message.text, conv.state)
    ) {
      await this.appendCustomerMessage(conv, message)
      return
    }

    if (!/[a-z0-9]/i.test(trimmedText)) {
      return
    }

    if (isBareGreeting(message.text)) {
      await this.appendCustomerMessage(conv, message)
      return
    }

    if (isRepeatOrderReference(message.text)) {
      const handledRepeat = await this.handleRepeatCustomerMemory(conv, message.text)
      if (handledRepeat) return
    }

    const merchantProducts = await this.db.query.products.findMany({
      where: and(eq(products.merchantId, merchantId), eq(products.active, true)),
    })
    conv = await this.seedProductFromReplyContext(conv, merchantId, message, merchantProducts)
    const history = (conv.context.recentMessages ?? []).map(m => ({
      role: m.role as 'vendor' | 'customer',
      text: m.text,
    }))
    const knownProducts: KnownProduct[] = merchantProducts.map(p => ({
      name: p.name,
      aliases: (p as unknown as { aliases: string[] }).aliases ?? [],
      unit: p.unit,
      price: p.price ? parseFloat(p.price) : undefined,
    }))

    if (this.aiQuota) {
      const merchantRow = await this.db.query.merchants.findFirst({
        where: eq(merchants.id, merchantId),
        columns: { phone: true, subscriptionTier: true },
      })
      const quotaTier = merchantRow?.subscriptionTier ?? 'starter'
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
        conv = await this.appendCustomerMessage(conv, message)
        messageAppended = true
      }
      // NLP failed — stay silent; the merchant is handling the conversation.
      return
    }
    nlp ??= {
      intent: 'NONE',
      items: [],
      agreementSignalDetected: false,
      confidence: 0,
      signals: {},
      facts: {},
    }
    if (this.aiQuota) await this.aiQuota.recordUsage(merchantId, 'haiku')

    // Scrub over-eager complaint signals at the source so they can't reach
    // any escalation path (ledger or direct).
    if (nlp.signals?.complaint && !looksLikeComplaint(message.text, conv.state)) {
      nlp = { ...nlp, signals: { ...nlp.signals, complaint: false } }
    }

    // "No wahala, add one white polo — how much be that one?" agrees to the
    // previous item but is still shopping: an open price question means the
    // deal is NOT final this turn. Track the new item, hold the tap.
    if (
      (nlp.agreementSignalDetected || nlp.intent === 'AGREEMENT') &&
      /\b(how much|what'?s the price|wetin be (the )?price|price of)\b/i.test(message.text ?? '')
    ) {
      nlp = {
        ...nlp,
        agreementSignalDetected: false,
        intent: nlp.intent === 'AGREEMENT' ? (nlp.items.length > 0 ? 'ORDER' : 'INQUIRY') : nlp.intent,
      }
    }

    // Agreement turns never expand the cart with items the customer didn't
    // say. "Alright I'll take it" must confirm what was negotiated, not what
    // the model re-imagined from the catalog.
    if ((nlp.agreementSignalDetected || nlp.intent === 'AGREEMENT') && nlp.items.length > 0) {
      const mentioned = nlp.items.filter(item => itemMentionedInText(item, message.text ?? '', merchantProducts))
      if (mentioned.length !== nlp.items.length) {
        nlp = { ...nlp, items: mentioned }
      }
    }

    if (!messageAppended) {
      conv = await this.appendCustomerMessage(conv, message)
      messageAppended = true
    }

    // Customer confirmed the deal ("yes", "confirm", "nothing else"). Never
    // create the order from customer text — route through the merchant
    // confirmation tap (ORDER_DETECTED); handleDetected dedupes repeats.
    if (conv.context.awaitingOrderConfirmation) {
      const n = normalizeReply(message.text)
      const isNothingElse = /^(no|nope|nah|nothing|nothing else|not really|nah na|that'?s all|no more|no other|i'?m good|im good|just confirm|proceed)$/.test(n)
      if (isConfirmationPhrase(message.text) || isNothingElse) {
        const total = conv.context.agreedPrice ?? conv.context.lastQuotedPrice
        if (total && total > 0) {
          await this.handleAgreement(conv)
          return
        }
      }
    }

    const wantsAgreementFlow =
      nlp.agreementSignalDetected ||
      nlp.intent === 'AGREEMENT' ||
      (nlp.intent === 'PAYMENT_INTENT' && !rawOfferPrice) ||
      isPaymentDetailsRequest(message.text)

    // Fast path only for item-less agreement ("I'll take it") — when the
    // agreement message explicitly names a product ("add the white polo too,
    // I'll take both"), fall through to the ledger path so the item merges
    // into the cart before the merchant tap fires.
    if (wantsAgreementFlow && conv.context.currentItems.length > 0 && nlp.items.length === 0) {
      const agreementContext = this.stateMachine.canTransition(conv.state, 'NEGOTIATING')
        ? await this.transitionOrUpdate(conv, 'NEGOTIATING', {
          currentItems: conv.context.currentItems,
          lastQuotedPrice: nlp.lastMentionedPrice ?? conv.context.lastQuotedPrice,
        })
        : conv
      await this.handleAgreement(agreementContext)
      return
    }

    if (nlp.intent === 'NONE' && !(rawOfferPrice && conv.context.currentItems.length > 0)) {
      if (nlp.signals?.complaint) {
        if (await this.handleLedgerDecision(conv, nlp, merchantProducts, rawOfferPrice, message.text)) return
      }
      // Nothing actionable — silent pass-through.
      return
    }

    if (await this.handleCommerceText(conv, nlp, merchantProducts, rawOfferPrice, message.text)) return

    if (nlp.signals?.complaint) {
      const complaintLedger = applyNlpToLedger(normalizeLedger(conv.context, conv.customerPhone), {
        ...nlp,
        intent: 'NONE',
        signals: { ...nlp.signals, complaint: true },
      }, merchantProducts)
      if (await this.executeLedgerAction(conv, { type: 'ESCALATE_TO_MERCHANT', reason: 'complaint' }, complaintLedger)) {
        return
      }
    }

    switch (conv.state) {
      case 'IDLE':
      case 'BROWSING': {
        if ((nlp.intent === 'ORDER' || nlp.intent === 'AGREEMENT') && nlp.items.length > 0) {
          const updated = await this.transitionOrUpdate(conv, 'NEGOTIATING', {
            currentItems: nlp.items,
            lastQuotedPrice: nlp.lastMentionedPrice,
          })

          if (nlp.agreementSignalDetected || nlp.intent === 'AGREEMENT') {
            await this.handleAgreement(updated)
          }
        } else if (nlp.intent === 'COUNTER_OFFER' && nlp.counterOfferPrice) {
          await this.transitionOrUpdate(conv, 'NEGOTIATING', this.parkCustomerCounterOffer(conv, nlp, merchantProducts))
        } else if (nlp.intent === 'PAYMENT_INTENT' && nlp.lastMentionedPrice && nlp.lastMentionedPrice > 0) {
          const items = nlp.items.length > 0 ? nlp.items : conv.context.currentItems
          await this.transitionOrUpdate(conv, 'NEGOTIATING', {
            currentItems: items,
            lastQuotedPrice: nlp.lastMentionedPrice,
          })
        } else if ((nlp.agreementSignalDetected || nlp.intent === 'AGREEMENT') && conv.context.currentItems.length > 0) {
          const updated = await this.transitionOrUpdate(conv, 'NEGOTIATING', {
            currentItems: conv.context.currentItems,
            lastQuotedPrice: nlp.lastMentionedPrice ?? conv.context.lastQuotedPrice,
          })
          await this.handleAgreement(updated)
        } else if (nlp.intent === 'INQUIRY') {
          if (nlp.items.length > 0) {
            conv = await this.transitionOrUpdate(conv, 'BROWSING', { currentItems: nlp.items })
          }
        }
        break
      }

      case 'NEGOTIATING': {
        if (nlp.agreementSignalDetected || nlp.intent === 'AGREEMENT') {
          let convForAgreement = conv
          if (nlp.lastMentionedPrice && nlp.lastMentionedPrice > 0) {
            convForAgreement = await this.stateMachine.updateContext(conv, {
              lastQuotedPrice: nlp.lastMentionedPrice,
            })
          }
          await this.handleAgreement(convForAgreement)
        } else if (nlp.intent === 'ORDER' && nlp.items.length > 0) {
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
          await this.transitionOrUpdate(conv, 'NEGOTIATING', this.parkCustomerCounterOffer(conv, nlp, merchantProducts))
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
        } else if (nlp.intent === 'COUNTER_OFFER' && nlp.counterOfferPrice) {
          await this.transitionOrUpdate(conv, 'NEGOTIATING', this.parkCustomerCounterOffer(conv, nlp, merchantProducts))
        } else if (nlp.intent === 'ORDER' || nlp.intent === 'AGREEMENT') {
          await this.handleAgreement(conv)
        }
        break
      }

      case 'COMPLETE':
      case 'PAYMENT_RECEIVED': {
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
    const key = `${event.merchantId}:${event.message.channel}:${event.message.customerId}`
    return this.withConversationLock(key, () => this.handleMessageEchoSerialized(event.merchantId, event.message))
  }

  // A message the business account itself sent to a customer — WhatsApp via
  // Business App coexistence echoes, Instagram via message_echoes on the
  // merchant's own shop account (see the is_echo branch in the gateway).
  // Also reachable directly from handleSerialized's Instagram branch above
  // (already holding the same per-conversation lock, so not re-wrapped here).
  private async handleMessageEchoSerialized(merchantId: string, message: InboundMessageEvent['message']): Promise<void> {
    if (message.type !== 'text' || !message.text) return
    if (isMesaGeneratedEscalationText(message.text)) return
    const normalized = normalizeReply(message.text)

    // Only whole-message task replies count as order actions. A conversational
    // quote to the customer ("It's 40k") contains a price but must flow to the
    // ledger below, not be swallowed by an open confirmation task.
    const isOrderAction = normalized === 'accept' || normalized === 'reject' ||
      parsePriceReply(message.text) != null || parseOrderCorrection(message.text) != null
    const isFulfilmentAction = ['book rider', 'book_rider', 'self deliver', 'self_deliver', 'pickup'].includes(normalized)
    const isPaymentAction = ['confirm payment', 'confirm', 'not yet', 'payment not yet', 'dispute'].includes(normalized)

    const pendingOrder = this.pending
      ? await this.pending.get<PendingOrderPayload>(merchantId, 'PENDING_ORDER_CONFIRMATION')
      : null
    const pendingPayment = this.pending
      ? await this.pending.get<PendingPaymentPayload>(merchantId, 'PENDING_PAYMENT_REVIEW')
      : null
    const pendingFulfilment = this.pending
      ? await this.pending.get<PendingFulfilmentPayload>(merchantId, 'PENDING_FULFILMENT_DECISION')
      : null

    if (pendingFulfilment && isFulfilmentAction) {
      await this.handleMerchantReply(merchantId, message.text, message.channel)
      return
    }
    if (pendingOrder && isOrderAction) {
      await this.handleMerchantReply(merchantId, message.text, message.channel)
      return
    }
    if (pendingPayment && isPaymentAction) {
      await this.handleMerchantReply(merchantId, message.text, message.channel)
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
      // Derive currentItems/lastQuotedPrice from the ledger rather than just
      // stamping the raw quotedPrice on lastQuotedPrice — with more than one
      // item in the cart, lastQuotedPrice must stay the running cart total,
      // not collapse to whichever single item was just re-quoted.
      Object.assign(contextUpdate, this.ledgerContextUpdate(conv, ledger, { manualLastAt }))
      // No item in the cart yet for the ledger to attach this quote to (e.g.
      // a price mentioned before any product was pinned down) — the ledger
      // total falls back to the stale lastQuotedPrice in that case, so record
      // the bare number directly instead of losing it.
      if (ledger.items.filter(item => item.status !== 'removed').length === 0) {
        contextUpdate.lastQuotedPrice = quotedPrice
      }
      // A fresh quote reopens the deal — any earlier agreed total is stale
      // the moment prices move (tap #2 showing old totals bug).
      contextUpdate.agreedPrice = undefined
    } else if (/\b(no wahala|ok|okay|oya|deal|gree|i don gree|leave am for you|make i (just )?leave am|carry am|na so|no p|no problem)\b/.test(normalizeReply(message.text))) {
      // The merchant accepted without repeating the number ("no wahala, make
      // I just leave am for you" after a 20k offer) — promote the customer's
      // pending offer to the settled price.
      const accepted = applyMerchantAcceptanceToLedger(normalizeLedger(conv.context, conv.customerPhone))
      if (accepted) {
        // Same reasoning as the quotedPrice branch above: without this, the
        // promoted price only lands in context.ledger, while currentItems
        // and lastQuotedPrice — what handleAgreement/handleConfirmed
        // actually read — stay stuck on the merchant's last-quoted (now
        // superseded) figure, so the customer's accepted offer never
        // reaches the order.
        Object.assign(contextUpdate, this.ledgerContextUpdate(conv, accepted, { manualLastAt }))
        contextUpdate.agreedPrice = undefined
      }
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

  private productMatches(product: ProductRow, name: string): boolean {
    const target = name.trim().toLowerCase()
    if (!target) return false
    if (product.name === name.trim()) return true
    if (product.name.toLowerCase() === target) return true
    const aliases = (product.aliases ?? []).map(alias => alias.toLowerCase())
    return aliases.includes(target)
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

  private async escalateUnknownProduct(
    conv: Parameters<ConversationStateMachine['transition']>[0],
    productName: string,
    reason: 'unknown' | 'stock',
    merchantProducts: ProductRow[],
  ): Promise<void> {
    const currentLedger = normalizeLedger(conv.context, conv.customerPhone)
    const key = itemKey(productName)
    const alreadyEscalated = currentLedger.items.some(
      i => itemKey(i.productName) === key && i.status !== 'removed' && !i.productId
    )
    if (!alreadyEscalated) {
      // Track the unresolved item silently (synced into currentItems so a
      // later agreement still fires a merchant tap, with "price TBD" if the
      // merchant's quote was never captured).
      const withPlaceholder = applyValidatedLedgerPatch(currentLedger, {
        items: [{ operation: 'add', productName }],
      }, merchantProducts)
      await this.stateMachine.updateContext(conv, this.ledgerContextUpdate(conv, withPlaceholder))
      // Only stock shortfalls alert the merchant — that is information they
      // may not have. An unknown product question is already on their phone;
      // Mesa pinging "do you carry this?" is noise.
      if (reason === 'stock') {
        await this.notifyMerchant(
          conv.merchantId,
          `Stock check needed for ${productName}. Customer asked for it but available stock is not enough. Please reply to the customer directly.`,
        )
      }
    }
  }

  private formatMoney(amount: number): string {
    return `₦${amount.toLocaleString()}`
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
    return items.length > 0 ? items : null
  }

  // The switch-statement COUNTER_OFFER branches below only run for customer
  // replies that handleCommerceText's ledger pipeline didn't already claim —
  // notably once a conversation is AGREED for an earlier item and the
  // customer negotiates an additional one, handleCommerceText's early-return
  // gate hands off here instead. Previously these branches only appended to
  // negotiationHistory without parking the offer on the item itself, so a
  // merchant accepting with a bare phrase ("no wahala, leave it for you")
  // had nothing for applyMerchantAcceptanceToLedger to promote — the
  // merchant's last explicit quote silently won instead of what the
  // customer actually offered.
  private parkCustomerCounterOffer(
    conv: Parameters<ConversationStateMachine['transition']>[0],
    nlp: BotNlpInput,
    merchantProducts: ProductRow[],
  ): Partial<ConversationContext> {
    const ledger = applyNlpToLedger(normalizeLedger(conv.context, conv.customerPhone), nlp, merchantProducts)
    return {
      ...this.ledgerContextUpdate(conv, ledger),
      negotiationHistory: [
        ...conv.context.negotiationHistory,
        { price: nlp.counterOfferPrice!, from: 'customer' as const, timestamp: new Date().toISOString() },
      ],
    }
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
    ledger: CommerceLedger,
  ): Promise<boolean> {
    switch (action.type) {
      // "Talky" ledger actions become silent state tracking: the merchant
      // handles the conversation; Mesa only keeps the ledger current so
      // agreement detection has a priced cart to work with.
      case 'REPLY_WITH_PRICE': {
        const items = this.draftToCatalogItems({ items: action.items, total: action.total })
        if (!items) return false
        const floorTotal = items.reduce((sum, item) => sum + item.floorUnitPrice * item.quantity, 0)
        // Reset draftOrder and correction so a re-quote starts a fresh cycle.
        const quoteLedger: CommerceLedger = {
          ...ledger,
          draftOrder: { status: 'none' },
          signals: { ...ledger.signals, correction: false, negotiation: false, asksLastPrice: false },
        }
        await this.transitionOrUpdate(conv, 'NEGOTIATING', {
          checkoutStage: 'product_selection',
          ...this.ledgerContextUpdate(conv, quoteLedger),
          currentItems: items,
          lastQuotedPrice: action.total,
          minimumAcceptableTotal: floorTotal,
          agreedPrice: undefined,
          awaitingOrderConfirmation: false,
        })
        return true
      }

      case 'REPLY_WITH_LAST_PRICE': {
        const updatedLedger: CommerceLedger = {
          ...ledger,
          signals: { ...ledger.signals, asksLastPrice: false },
        }
        await this.transitionOrUpdate(conv, conv.state === 'IDLE' ? 'NEGOTIATING' : conv.state, {
          ...this.ledgerContextUpdate(conv, updatedLedger),
          lastQuotedPrice: action.total,
        })
        return true
      }

      case 'ASK_QUANTITY': {
        await this.transitionOrUpdate(conv, conv.state === 'IDLE' ? 'BROWSING' : conv.state, {
          ...this.ledgerContextUpdate(conv, ledger),
        })
        return true
      }

      case 'ASK_COUNTER_OFFER': {
        await this.stateMachine.updateContext(conv, {
          ...this.ledgerContextUpdate(conv, ledger),
        })
        return true
      }

      case 'ASK_DELIVERY_ADDRESS': {
        await this.stateMachine.updateContext(conv, {
          ...this.ledgerContextUpdate(conv, ledger),
        })
        return true
      }

      case 'ACKNOWLEDGE_DELIVERY_ADDRESS': {
        const clearedLedger: CommerceLedger = {
          ...ledger,
          signals: { ...ledger.signals, asksDelivery: false },
        }
        await this.stateMachine.updateContext(conv, {
          ...this.ledgerContextUpdate(conv, clearedLedger),
        })
        return true
      }

      case 'ACKNOWLEDGE_CORRECTION': {
        await this.stateMachine.updateContext(conv, {
          ...this.ledgerContextUpdate(conv, ledger),
        })
        return true
      }

      case 'SEND_ORDER_SUMMARY': {
        const items = this.draftToCatalogItems(action.draft)
        if (!items) return false
        const updatedLedger: CommerceLedger = {
          ...ledger,
          draftOrder: { status: 'sent_to_customer', total: action.draft.total },
        }
        const baseConv = this.stateMachine.canTransition(conv.state, 'NEGOTIATING')
          ? await this.transitionOrUpdate(conv, 'NEGOTIATING', this.ledgerContextUpdate(conv, updatedLedger))
          : conv
        await this.handleAgreement({
          ...baseConv,
          context: {
            ...baseConv.context,
            ...this.ledgerContextUpdate(baseConv, updatedLedger),
            currentItems: items,
            agreedPrice: action.draft.total,
            lastQuotedPrice: action.draft.total,
            awaitingOrderConfirmation: true,
          },
        })
        return true
      }

      case 'REQUEST_PAYMENT': {
        const items = this.draftToCatalogItems(action.draft)
        if (!items) return false
        // Customer confirmed the draft. The order is never created directly —
        // the merchant confirms via the ORDER_DETECTED tap, and bank details
        // go to the customer only after ORDER_CONFIRMED.
        const updatedLedger: CommerceLedger = {
          ...ledger,
          draftOrder: { status: 'customer_confirmed', total: action.draft.total },
        }
        const updated = await this.transitionLedgerAction(conv, 'AGREED', {
          checkoutStage: 'cart_confirmation',
          ...this.ledgerContextUpdate(conv, updatedLedger),
          currentItems: items,
          agreedPrice: action.draft.total,
          lastQuotedPrice: action.draft.total,
          awaitingOrderConfirmation: false,
        })
        await this.handleAgreement(updated)
        return true
      }

      case 'NEGOTIATE': {
        const current = conv.context.currentItems as CatalogItem[]
        if (current.length === 0 || !action.customerOffer || action.customerOffer <= 0) return false
        const targetTotal = Math.max(action.customerOffer, action.floorTotal || action.customerOffer)
        const activeItems = ledger.items.filter(item => item.status !== 'removed')
        const basisTotal = activeItems.reduce((sum, item) =>
          sum + ((item.agreedUnitPrice ?? item.quotedUnitPrice ?? item.floorUnitPrice ?? 0) * (item.quantity ?? 1)), 0)
        // Record the customer's offer silently. Mesa never counters — the
        // merchant negotiates in their own chat, and their replies (echoes)
        // update lastQuotedPrice via applyMerchantQuoteToLedger.
        const updatedLedger: CommerceLedger = {
          ...ledger,
          items: ledger.items.map(item => {
            if (item.status === 'removed') return item
            const quantity = item.quantity ?? 1
            const basis = (item.agreedUnitPrice ?? item.quotedUnitPrice ?? item.floorUnitPrice ?? 0) * quantity
            const proportionalTotal = basisTotal > 0 ? targetTotal * (basis / basisTotal) : targetTotal / Math.max(activeItems.length, 1)
            const floorTotal = (item.floorUnitPrice ?? 0) * quantity
            return {
              ...item,
              agreedUnitPrice: Math.max(proportionalTotal, floorTotal) / quantity,
              status: 'negotiating' as const,
            }
          }),
        }
        await this.transitionOrUpdate(conv, 'NEGOTIATING', {
          ...this.ledgerContextUpdate(conv, updatedLedger),
          minimumAcceptableTotal: action.floorTotal,
          lastQuotedPrice: targetTotal,
          awaitingOrderConfirmation: false,
          negotiationHistory: [
            ...conv.context.negotiationHistory,
            { price: action.customerOffer, from: 'customer', timestamp: new Date().toISOString() },
          ],
        })
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
        const clearedLedger: CommerceLedger = {
          ...ledger,
          signals: {
            ...ledger.signals,
            complaint: false,
          },
        }
        // Alert the merchant only — the customer hears from the merchant, not Mesa.
        await this.stateMachine.updateContext(conv, {
          ...this.ledgerContextUpdate(conv, clearedLedger),
          automationPausedUntil: new Date(Date.now() + MANUAL_REPLY_PAUSE_MS).toISOString(),
          escalationReason: reason,
        })
        await this.notifyMerchant(
          conv.merchantId,
          isOutOfStock
            ? `Stock check needed — ${itemNames}. Customer wants to order but stock is insufficient.`
            : `Customer needs attention: ${action.reason}`,
        )
        return true
      }

      default:
        return false
    }
  }

  private async handleLedgerDecision(
    conv: Parameters<ConversationStateMachine['transition']>[0],
    nlp: BotNlpInput,
    merchantProducts: ProductRow[],
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
        paymentIntent: !rawOfferPrice && (nlp.signals?.paymentIntent || nlp.intent === 'PAYMENT_INTENT'),
      },
      facts: nlp.facts,
    }, merchantProducts)
    const readiness = evaluateDraftReadiness(nextLedger, merchantProducts)
    const action = decideNextAction(nextLedger, readiness)
    return this.executeLedgerAction(conv, action, nextLedger)
  }

  private async handleCommerceText(
    conv: Parameters<ConversationStateMachine['transition']>[0],
    nlp: BotNlpInput,
    merchantProducts: ProductRow[],
    rawOfferPrice?: number,
    rawText = '',
  ): Promise<boolean> {
    // Order is already placed or committed — don't re-enter the agreement flow.
    // ORDER_CREATED/AWAITING_PAYMENT are post-order states.
    // AGREED + awaitingOrderConfirmation=false means the merchant confirmation
    // tap is already out (ORDER_DETECTED published); block re-entry there too.
    if (conv.state === 'ORDER_CREATED' || conv.state === 'AWAITING_PAYMENT') return false
    if (conv.state === 'AGREED' && !conv.context.awaitingOrderConfirmation) return false

    if (await this.handleLedgerDecision(conv, nlp, merchantProducts, rawOfferPrice, rawText)) {
      return true
    }

    const current = conv.context.currentItems as CatalogItem[]
    const agreedTotal = conv.context.agreedPrice ?? conv.context.lastQuotedPrice
    const paymentDetailsRequested = !rawOfferPrice && isPaymentDetailsRequest(rawText)

    if (nlp.intent === 'INQUIRY' || nlp.intent === 'ORDER') {
      // Catalog questions with no concrete item are the merchant's to answer.
      if (nlp.items.length === 0) return false

      const resolved = this.resolveCatalogItems(nlp.items, merchantProducts)
      if (!resolved.ok) {
        // Unknown/ambiguous/out-of-stock item on an order-shaped message —
        // alert the merchant; the customer hears from them, not Mesa.
        await this.escalateUnknownProduct(conv, resolved.productName, resolved.reason, merchantProducts)
        return true
      }

      if (nlp.agreementSignalDetected || paymentDetailsRequested) {
        // If a negotiation already priced this same cart (merchant echo /
        // earlier quote), that price wins over the catalog list total — the
        // agreement message re-mentioning the item must not reset it.
        const sameCart = current.length > 0 &&
          current.length === resolved.items.length &&
          resolved.items.every(item =>
            current.some(existing => existing.productName.toLowerCase() === item.productName.toLowerCase()))
        const negotiated = sameCart ? (conv.context.agreedPrice ?? conv.context.lastQuotedPrice) : undefined
        const agreedTotal = negotiated && negotiated > 0 ? negotiated : resolved.listTotal
        const agreementContext = this.stateMachine.canTransition(conv.state, 'NEGOTIATING')
          ? await this.transitionOrUpdate(conv, 'NEGOTIATING', {
            currentItems: resolved.items,
            lastQuotedPrice: agreedTotal,
            minimumAcceptableTotal: resolved.floorTotal,
            agreedPrice: agreedTotal,
            awaitingOrderConfirmation: true,
          })
          : await this.stateMachine.updateContext(conv, {
            currentItems: resolved.items,
            lastQuotedPrice: agreedTotal,
            minimumAcceptableTotal: resolved.floorTotal,
            agreedPrice: agreedTotal,
            awaitingOrderConfirmation: true,
          })
        await this.handleAgreement(agreementContext)
        return true
      }

      // Track the cart silently at catalog prices so agreement detection has
      // a priced cart to work with. If a cart is already forming, merge.
      const trackedItems = current.length > 0
        ? this.mergeCatalogItems(current, resolved.items)
        : resolved.items
      const listTotal = trackedItems.reduce((sum, item) => sum + item.unitPrice * item.quantity, 0)
      const floorTotal = trackedItems.reduce((sum, item) => sum + item.floorUnitPrice * item.quantity, 0)
      await this.transitionOrUpdate(conv, 'NEGOTIATING', {
        checkoutStage: 'product_selection',
        currentItems: trackedItems,
        lastQuotedPrice: listTotal,
        minimumAcceptableTotal: floorTotal,
        awaitingOrderConfirmation: false,
        agreedPrice: undefined,
      })
      return true
    }

    const wantsToProceed = nlp.agreementSignalDetected
      || nlp.intent === 'AGREEMENT'
      || (nlp.intent === 'PAYMENT_INTENT' && !rawOfferPrice)
      || paymentDetailsRequested

    if (wantsToProceed) {
      if (current.length === 0) return false
      if (!agreedTotal || agreedTotal <= 0) return false
      // Agreement signal with a priced cart — straight to the merchant
      // confirmation tap. No "anything else?" prompt to the customer.
      const updated = await this.transitionOrUpdate(conv, 'AGREED', {
        checkoutStage: 'cart_confirmation',
        agreedPrice: agreedTotal,
        lastQuotedPrice: agreedTotal,
        awaitingOrderConfirmation: false,
      })
      await this.handleAgreement(updated)
      return true
    }

    const offeredPrice = rawOfferPrice
      ?? nlp.counterOfferPrice
      ?? (nlp.intent === 'COUNTER_OFFER' && nlp.lastMentionedPrice && nlp.lastMentionedPrice > 0 ? nlp.lastMentionedPrice : undefined)

    if (offeredPrice && offeredPrice > 0) {
      if (current.length === 0) return false
      // Record the customer's offer silently. Mesa never counters — the
      // merchant negotiates in their own chat; their echoed replies update
      // lastQuotedPrice, and agreement detection closes the loop.
      const floorTotal = conv.context.minimumAcceptableTotal
        ?? minimumTotalForItems(current, conv.context.lastQuotedPrice)
      const trackedPrice = Math.max(offeredPrice, floorTotal || offeredPrice)
      await this.transitionOrUpdate(conv, 'NEGOTIATING', {
        currentItems: current,
        minimumAcceptableTotal: floorTotal,
        lastQuotedPrice: trackedPrice,
        awaitingOrderConfirmation: false,
        negotiationHistory: [
          ...conv.context.negotiationHistory,
          { price: offeredPrice, from: 'customer', timestamp: new Date().toISOString() },
        ],
      })
      return true
    }

    return false
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
    let actionUrl = `${appConfig.DASHBOARD_URL}/actions/payment`
    if (taskId) {
      const token = randomBytes(32).toString('hex')
      const tokenHash = createHash('sha256').update(token).digest('hex')
      actionUrl = `${appConfig.DASHBOARD_URL}/actions/payment/${token}`
      await this.db.update(agentTasks)
        .set({ actionTokenHash: tokenHash, expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000) })
        .where(eq(agentTasks.id, taskId))
      await this.pending?.update(conv.merchantId, 'PENDING_PAYMENT_REVIEW', { actionToken: token, actionUrl })
    }

    await this.nats.publish({
      subject: SUBJECTS.NOTIFICATION_SEND,
      merchantId: conv.merchantId,
      to: conv.customerPhone,
      channel: conv.channel as 'whatsapp' | 'instagram',
      message: 'Checking it now.',
    } satisfies NotificationSendEvent)

    await notifyMerchantOnSourceChannel(this.db, this.nats, {
      merchantId: conv.merchantId,
      sourceChannel: conv.channel,
      actionUrl,
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
    })
  }

  private async handleCustomerProductMedia(
    merchantId: string,
    message: InboundMessageEvent['message'],
    conv: Parameters<ConversationStateMachine['updateContext']>[0],
  ): Promise<void> {
    if (!message.mediaId && !message.mediaUrl) return

    const { buffer, mimeType } = await this.fetchInboundMedia(merchantId, message)
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
        // Catalog match when confident, otherwise the vision-inferred label
        // ("Ecolion SP-700W solar panel") — either way the item is tracked
        // SILENTLY and Mesa keeps listening. The merchant sees the image on
        // their own phone and answers the customer; their echoed quote prices
        // this item, and agreement fires the tap as usual.
        const isCatalogMatch = Boolean(candidate && analysis.confidence >= 0.78 && candidate.stockQuantity > 0)
        const productName = isCatalogMatch
          ? candidate!.name
          : (analysis.inferredProductName?.trim() || 'Unidentified item (photo)')
        if (!analysis.inferredProductName?.trim() && !isCatalogMatch) {
          console.warn(JSON.stringify({
            level: 'warn',
            msg: 'vision_no_product_name',
            merchantId,
            conversationId: conv.id,
            confidence: analysis.confidence,
          }))
        }
        if (productName) {
          const currentLedger = normalizeLedger(conv.context, conv.customerPhone)
          // Vision labels for the same product vary between shots — a second
          // photo of the panel must not become a second cart line.
          const similar = currentLedger.items.find(item =>
            item.status !== 'removed' && isSimilarProductName(item.productName, productName))
          if (similar && !(isCatalogMatch && !similar.productId)) {
            return
          }
          const withItem = applyValidatedLedgerPatch(currentLedger, {
            items: [
              // A catalog match upgrades an earlier vision-labelled duplicate.
              ...(similar ? [{ operation: 'remove' as const, productName: similar.productName }] : []),
              { operation: 'add' as const, productName },
            ],
          }, catalog)
          await this.stateMachine.updateContext(conv, {
            checkoutStage: 'product_selection',
            ...this.ledgerContextUpdate(conv, withItem),
          })
        }
      } catch (err) {
        console.warn(JSON.stringify({
          level: 'warn',
          msg: 'product_image_analysis_failed',
          merchantId,
          conversationId: conv.id,
          err: err instanceof Error ? err.message : String(err),
        }))
      }
    }
    // Documents and unidentifiable images: nothing to track — stay silent and
    // keep listening. No merchant ping, no automation pause.
  }

  private async checkSubscriptionGate(merchantId: string): Promise<boolean> {
    const cacheKey = `subscription_gate:${merchantId}`
    // Redis is a 5-minute cache in front of this DB check — an error here
    // must fall through to the DB, not block message processing.
    const cached = await this.redis.get(cacheKey).catch(() => null)
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
      await this.redis.set(cacheKey, 'active', 'EX', 300).catch(() => {})
      return false
    }

    await this.redis.set(cacheKey, 'blocked', 'EX', 300).catch(() => {})
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

  private async handleMerchantReply(merchantId: string, text: string, replyChannel: 'whatsapp' | 'instagram'): Promise<void> {
    // Handle mono nudge dismiss — just acknowledge and drop (no state change).
    if (normalizeReply(text) === 'mono_nudge_dismiss') {
      console.info(JSON.stringify({
        level: 'info',
        msg: 'Mono nudge dismissed by merchant',
        merchantId,
      }))
      return
    }

    // Unambiguous fulfilment decisions win over any other open task — the
    // pending-order/payment blocks below swallow unrecognized replies, so a
    // "Book Rider" tap must be claimed before a stale task can eat it.
    const fulfilmentReply = ['book_rider', 'book rider', 'book', 'rider', 'self_deliver', 'self deliver', 'pickup', 'pick up']
      .includes(normalizeReply(text))
    if (fulfilmentReply && await this.fulfilmentHandler?.handleMerchantReply(merchantId, text, replyChannel)) {
      return
    }

    const pendingPayment = this.pending
      ? await this.pending.get<PendingPaymentPayload>(merchantId, 'PENDING_PAYMENT_REVIEW')
      : null
    if (pendingPayment) {
      const wantsLink = ['link', 'dashboard', 'open', 'review'].includes(normalizeReply(text))
      if (wantsLink && pendingPayment.actionUrl) {
        await notifyMerchantOnSourceChannel(this.db, this.nats, {
          merchantId,
          sourceChannel: replyChannel,
          message: `Open the payment review page here: ${pendingPayment.actionUrl}`,
        })
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
        await notifyMerchantOnSourceChannel(this.db, this.nats, {
          merchantId,
          sourceChannel: replyChannel,
          message: delay
            ? 'Okay. Mesa will check with you again later.'
            : 'Okay. This payment will stay pending in Mesa until you confirm or dispute it.',
        })
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
        await notifyMerchantOnSourceChannel(this.db, this.nats, {
          merchantId,
          sourceChannel: replyChannel,
          message: `Open the order review page here: ${pendingOrder.actionUrl}`,
        })
        return
      }

      if (normalizeReply(text) === 'edit_order' || normalizeReply(text) === 'edit') {
        await notifyMerchantOnSourceChannel(this.db, this.nats, {
          merchantId,
          sourceChannel: replyChannel,
          message: 'Send the corrected total, e.g. 140000.\nTo change items too, send: 2x rice, 1x beans = 180000\nOr set a price per item: 2x rice - 20000, 1x beans - 10000 = 30000\nReply LINK if you prefer the review page.',
        })
        return
      }

      const correction = parseOrderCorrection(text)
      if (correction && this.orderHandler) {
        // Same sanity gate as bare price replies — a mistyped total
        // ("= 38" instead of "= 38k") must not create a ₦38 order.
        const detectedTotal = pendingOrder.agreedTotal ?? 0
        if (!priceWithinReasonableRange(correction.total, detectedTotal)) {
          const direction = correction.total < detectedTotal ? 'low' : 'high'
          await notifyMerchantOnSourceChannel(this.db, this.nats, {
            merchantId,
            sourceChannel: replyChannel,
            message: `₦${correction.total.toLocaleString()} looks unusually ${direction} for this order (detected ₦${detectedTotal.toLocaleString()}). Resend the correction with the full amount (e.g. "${correction.items.map(i => `${i.quantity}x ${i.productName}`).join(', ')} = ${detectedTotal.toLocaleString()}").`,
          })
          return
        }
        // Claim the task before creating anything — this same confirmation
        // can also arrive via the web action page, which claims atomically
        // (UPDATE ... WHERE status = 'OPEN'). Claiming after handleConfirmed
        // leaves the task OPEN for the whole order-creation window, wide
        // enough for both paths to race and each create their own order.
        const claimed = this.pending
          ? await this.pending.resolve(merchantId, 'PENDING_ORDER_CONFIRMATION', 'DONE')
          : true
        if (!claimed) return

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
        // parseOrderCorrection("1x rice, 1x beans = 180000") used to only
        // extract productName/quantity, with no way to know the price
        // actually negotiated per item. Replacing currentItems outright
        // wiped whatever prices were already tracked, so a merchant fixing
        // a wrong TOTAL (the common case) also silently erased the real
        // per-item breakdown — handleConfirmed then found no known prices
        // and fell back to an even split across items, fabricating a
        // receipt with numbers nobody ever discussed. The merchant can now
        // also give an explicit per-item price in the correction itself
        // ("1x bag - 20000, 1x rice - 10000 = 30000") — that takes
        // precedence; otherwise carry forward the existing price for any
        // item that matches by name.
        const existingItems = conv.context.currentItems ?? []
        const enrichedItems = correction.items.map(item => {
          if (item.agreedPrice != null) return item
          const existing = existingItems.find(
            e => e.productName.toLowerCase() === item.productName.toLowerCase()
          )
          return existing
            ? { ...item, unitPrice: existing.unitPrice, agreedPrice: existing.agreedPrice }
            : item
        })
        await this.stateMachine.updateContext(conv, {
          currentItems: enrichedItems,
          agreedPrice: correction.total,
        })
        await this.orderHandler.handleConfirmed(
          merchantId,
          pendingOrder.conversationId,
          correction.total
        )
        return
      }

      if (isYes(text) && this.orderHandler) {
        const claimed = this.pending
          ? await this.pending.resolve(merchantId, 'PENDING_ORDER_CONFIRMATION', 'DONE')
          : true
        if (!claimed) return
        await this.orderHandler.handleConfirmed(
          merchantId,
          pendingOrder.conversationId,
          pendingOrder.agreedTotal ?? 0
        )
        return
      }

      if (isNo(text)) {
        if (this.pending) await this.pending.resolve(merchantId, 'PENDING_ORDER_CONFIRMATION', 'CANCELLED')
        await notifyMerchantOnSourceChannel(this.db, this.nats, {
          merchantId,
          sourceChannel: replyChannel,
          message: 'Order cancelled.',
        })
        return
      }

      const priceReply = parsePriceReply(text)
      if (priceReply && this.orderHandler) {
        const detected = pendingOrder.agreedTotal ?? 0
        const reasonable = priceWithinReasonableRange(priceReply.value, detected)

        if (reasonable || priceReply.forced) {
          const claimed = this.pending
            ? await this.pending.resolve(merchantId, 'PENDING_ORDER_CONFIRMATION', 'DONE')
            : true
          if (!claimed) return
          await this.orderHandler.handleConfirmed(
            merchantId,
            pendingOrder.conversationId,
            priceReply.value
          )
          return
        }

        // Override is wildly out of range — require explicit CONFIRM.
        const direction = priceReply.value < detected ? 'low' : 'high'
        await notifyMerchantOnSourceChannel(this.db, this.nats, {
          merchantId,
          sourceChannel: replyChannel,
          message: `₦${priceReply.value.toLocaleString()} looks unusually ${direction} for this order (detected ₦${detected.toLocaleString()}). Reply CONFIRM ${priceReply.value} to use this price anyway, or send a different amount.`,
        })
        return
      }

      // Unrecognized merchant reply — leave pending state intact.
      return
    }

    if (await this.fulfilmentHandler?.handleMerchantReply(merchantId, text, replyChannel)) {
      return
    }

    await this.handleMerchantSelfService(merchantId, text, replyChannel)
  }

  private async handleMerchantSelfService(merchantId: string, text: string, replyChannel: 'whatsapp' | 'instagram'): Promise<void> {
    const normalized = text.trim()
    const lower = normalized.toLowerCase()

    const notify = async (msg: string) => {
      await notifyMerchantOnSourceChannel(this.db, this.nats, {
        merchantId,
        sourceChannel: replyChannel,
        message: msg,
      })
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

    // Show the command menu only when the merchant explicitly asks for it.
    // Any other unrecognized text (stray "Accept" after a task closed, notes
    // to self, etc.) gets silence — Mesa never replies with noise.
    if (/^(help|menu|commands?|mesa)$/.test(lower)) {
      await notify(
        'Mesa commands:\n• "check stock" — see all stock levels\n• "add [name] - ₦[price]" — add a product\n• "update [name] to ₦[price]" — update price'
      )
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
        customerName: await this.getConversationCustomerName(agreed.id),
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

    // Valid total but no items — nothing to notify the merchant about yet.
    if (items.length === 0) return

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
      customerName: await this.getConversationCustomerName(agreed.id),
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
    await this.handleAgreement(updated)
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

    // Instagram's customerPhone is really the customer's IGSID — not human
    // readable anywhere Mesa shows it (dashboard order list, notifications).
    // WhatsApp already has a real phone number for this slot, so only fetch
    // here for Instagram, and only once, at conversation creation.
    const customerName = channel === 'instagram'
      ? await this.fetchInstagramCustomerName(merchantId, customerPhone)
      : undefined

    const [created] = await this.db
      .insert(conversations)
      .values({ merchantId, channel, customerPhone, customerName, state: 'IDLE' })
      .returning({ id: conversations.id })

    return created.id
  }

  private async getConversationCustomerName(conversationId: string): Promise<string | undefined> {
    const conv = await this.db.query.conversations.findFirst({
      where: eq(conversations.id, conversationId),
      columns: { customerName: true },
    })
    return conv?.customerName ?? undefined
  }

  // Instagram Messaging's user-profile lookup — requires the
  // instagram_business_manage_messages permission Mesa already requests.
  // Best-effort: a fetch failure (revoked token, no display name set) just
  // means the dashboard falls back to showing the raw IGSID, same as today.
  private async fetchInstagramCustomerName(merchantId: string, igsid: string): Promise<string | undefined> {
    const channel = await this.db.query.merchantChannels.findFirst({
      where: and(
        eq(merchantChannels.merchantId, merchantId),
        eq(merchantChannels.channel, 'instagram'),
        eq(merchantChannels.status, 'connected'),
      ),
      columns: { accessToken: true },
    })
    if (!channel?.accessToken) return undefined

    try {
      const url = new URL(`https://graph.instagram.com/v21.0/${igsid}`)
      url.searchParams.set('fields', 'name,username')
      url.searchParams.set('access_token', channel.accessToken)
      const res = await fetch(url.toString())
      if (!res.ok) return undefined
      const data = await res.json() as { name?: string; username?: string }
      return data.name || data.username || undefined
    } catch {
      return undefined
    }
  }
}
