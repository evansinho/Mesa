import type { Db } from '@mesa/db'
import { fulfilments, merchants, orderItems, orders, conversations, payments } from '@mesa/db'
import type { MesaNatsClient } from '@mesa/nats'
import type { Redis } from 'ioredis'
import { NotificationSendEvent, PaymentConfirmedEvent, SUBJECTS } from '@mesa/types'
import { and, eq, desc } from 'drizzle-orm'
import type { PendingDecisions, PendingFulfilmentPayload } from './pending-decisions'
import { notifyMerchantOnSourceChannel } from './notify-merchant'
import { config } from '@mesa/config'
import * as fez from '../delivery/fez'
import * as kwik from '../delivery/kwik'
import { resolveProvider } from '../delivery/resolver'
import type { DeliveryQuoteInput, DeliveryOrderInput } from '../delivery/types'
import { enqueueKwikPoll } from './delivery.handler'

type OrderItemSummary = {
  productName: string
  quantity: number
  agreedPrice: string
}

function money(value: string | number): string {
  const numeric = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(numeric)) return `₦${value}`
  return `₦${numeric.toLocaleString()}`
}

function shortOrderRef(orderId: string): string {
  return orderId.slice(-8).toUpperCase()
}

function normalizeReply(text: string): string {
  return text.trim().toLowerCase().replace(/[.!?]+$/, '')
}

// Nigerian mobile numbers: 11-digit local (0[7-9][01]xxxxxxxx) or the same
// with a +234/234 prefix instead of the leading 0.
const NIGERIAN_PHONE_PATTERN = /(?:\+?234|0)[7-9][01]\d{8}\b/

// Instagram's customerPhone is really the customer's IGSID, not a callable
// number — pull an actual phone out of their address reply so the merchant
// has something to reach them on. WhatsApp already has a real phone in
// customerPhone, so this is only ever used for Instagram.
function extractContactPhone(text: string): { phone?: string; remainder: string } {
  const match = text.match(NIGERIAN_PHONE_PATTERN)
  if (!match) return { remainder: text }
  const remainder = (text.slice(0, match.index) + text.slice((match.index ?? 0) + match[0].length))
    .replace(/[,\s]{2,}/g, ' ')
    .trim()
  return { phone: match[0], remainder }
}

function formatItems(items: OrderItemSummary[]): string {
  if (items.length === 0) return 'Order items unavailable'
  return items.map(item => `${item.quantity}x ${item.productName}`).join('\n')
}

// WhatsApp's customerPhone is already a real, callable number — Instagram's
// is an IGSID, so the merchant has no way to reach the customer unless we
// ask for one here, alongside the address.
function addressRequestMessage(merchantName: string, customerChannel: string): string {
  const ask = customerChannel === 'instagram'
    ? `Please send your delivery address and a phone number so ${merchantName} can arrange delivery.`
    : `Please send your delivery address so ${merchantName} can arrange delivery.`
  return ['Your payment has been confirmed.', '', ask].join('\n')
}

function dispatchSummary(input: {
  orderId: string
  merchantName: string
  customerPhone: string
  customerName?: string | null
  contactPhone?: string | null
  itemsSummary: string
  totalPaid: string
  dropoffAddress: string
}): string {
  return [
    'Dispatch details ready.',
    '',
    `Order: ${shortOrderRef(input.orderId)}`,
    `Merchant: ${input.merchantName}`,
    `Customer: ${input.customerName ?? input.customerPhone}`,
    `Phone: ${input.contactPhone ?? input.customerPhone}`,
    '',
    'Items:',
    input.itemsSummary,
    '',
    `Total paid: ${input.totalPaid}`,
    '',
    'Delivery address:',
    input.dropoffAddress,
  ].join('\n')
}

// Best-effort extraction of a Nigerian state out of free-text so
// resolveProvider can tell same-city (Kwik-eligible) from interstate
// (FEZ-only). Never blocks on failure — an unmatched address just means
// resolveProvider falls back to FEZ, which is nationwide and safe.
const NIGERIA_STATES = [
  'Abia', 'Adamawa', 'Akwa Ibom', 'Anambra', 'Bauchi', 'Bayelsa', 'Benue', 'Borno',
  'Cross River', 'Delta', 'Ebonyi', 'Edo', 'Ekiti', 'Enugu', 'Gombe', 'Imo', 'Jigawa',
  'Kaduna', 'Kano', 'Katsina', 'Kebbi', 'Kogi', 'Kwara', 'Lagos', 'Nasarawa', 'Niger',
  'Ogun', 'Ondo', 'Osun', 'Oyo', 'Plateau', 'Rivers', 'Sokoto', 'Taraba', 'Yobe', 'Zamfara',
]
// Common city names likely to appear in a free-text address before (or
// instead of) the state itself.
const CITY_STATE_ALIASES: Record<string, string> = {
  abuja: 'FCT', fct: 'FCT',
  'port harcourt': 'Rivers', ph: 'Rivers',
  ibadan: 'Oyo', warri: 'Delta', asaba: 'Delta', aba: 'Abia', benin: 'Edo',
  jos: 'Plateau', onitsha: 'Anambra', calabar: 'Cross River', uyo: 'Akwa Ibom',
  abeokuta: 'Ogun',
}

function extractNigerianState(text: string | null | undefined): string | undefined {
  if (!text) return undefined
  const normalized = text.toLowerCase()
  for (const [alias, state] of Object.entries(CITY_STATE_ALIASES)) {
    if (new RegExp(`\\b${alias}\\b`).test(normalized)) return state
  }
  for (const state of NIGERIA_STATES) {
    if (new RegExp(`\\b${state.toLowerCase()}\\b`).test(normalized)) return state
  }
  return undefined
}

const DELIVERY_QUOTE_VALIDITY_MS = 10 * 60 * 1000

export class FulfilmentHandler {
  constructor(
    private db: Db,
    private nats: MesaNatsClient,
    private pending?: PendingDecisions,
    // Only needed for Kwik (session-token caching) and the booking-retry
    // queue — delivery integrations simply don't engage without it,
    // falling through to today's manual flow.
    private redis?: Redis,
  ) {}

  async startAfterPayment(event: PaymentConfirmedEvent): Promise<void> {
    const order = await this.db.query.orders.findFirst({
      where: eq(orders.id, event.orderId),
    })
    if (!order) return

    const merchant = await this.db.query.merchants.findFirst({
      where: eq(merchants.id, event.merchantId),
      columns: { name: true, phone: true, config: true, address: true },
    })
    if (!merchant?.phone) return

    const items = await this.db.query.orderItems.findMany({
      where: eq(orderItems.orderId, event.orderId),
      columns: { productName: true, quantity: true, agreedPrice: true },
    })
    const itemsSummary = formatItems(items)
    const merchantConfig = (merchant.config as Record<string, unknown>) ?? {}
    // merchants.address is the real, structured business-address column —
    // config.pickupAddress/businessAddress predate it and stay as a
    // fallback for merchants who set one before this column existed.
    const pickupAddress = (merchant.address
      ?? (merchantConfig.pickupAddress as string | undefined)
      ?? (merchantConfig.businessAddress as string | undefined))

    const [fulfilment] = await this.db
      .insert(fulfilments)
      .values({
        merchantId: event.merchantId,
        orderId: event.orderId,
        status: 'PENDING',
        customerPhone: order.customerPhone,
        customerName: order.customerName,
        pickupAddress,
        packageDescription: itemsSummary,
        packageValue: order.total,
      })
      .onConflictDoUpdate({
        target: fulfilments.orderId,
        set: {
          updatedAt: new Date(),
        },
      })
      .returning({ id: fulfilments.id })

    const conv = order.conversationId
      ? await this.db.query.conversations.findFirst({
        where: eq(conversations.id, order.conversationId),
        columns: { channel: true, customerName: true },
      })
      : undefined
    // orders.customerName is a one-time snapshot taken at order creation and
    // can be null even when the conversation's own name resolved later —
    // fall back to it rather than showing a raw phone/IGSID.
    const resolvedCustomerName = order.customerName ?? conv?.customerName ?? undefined

    const payload = {
      orderId: event.orderId,
      fulfilmentId: fulfilment.id,
      customerPhone: order.customerPhone,
      customerChannel: conv?.channel ?? 'whatsapp',
      customerName: resolvedCustomerName,
      itemsSummary,
      totalPaid: event.amount,
    }

    let surfaced = true
    if (this.pending) {
      const result = await this.pending.upsert(event.merchantId, 'PENDING_FULFILMENT_DECISION', payload)
      surfaced = result.surfaced
    }
    if (surfaced) {
      await this.notifyPendingFulfilmentDecision(event.merchantId, {
        ...payload,
        createdAt: new Date().toISOString(),
      })
    }
  }

  // Notifies the merchant about a pending fulfilment decision — either
  // right after it's created (the common case) or when it's promoted from
  // the queue after an earlier one for this merchant resolved.
  async notifyPendingFulfilmentDecision(merchantId: string, payload: PendingFulfilmentPayload): Promise<void> {
    if (payload.quote) {
      await notifyMerchantOnSourceChannel(this.db, this.nats, {
        merchantId,
        sourceChannel: payload.customerChannel,
        actionUrl: `${config.DASHBOARD_URL}/dashboard/orders`,
        template: {
          name: 'mesa_delivery_quote',
          languageCode: 'en',
          bodyParams: [
            shortOrderRef(payload.orderId),
            payload.quote.provider,
            money(payload.quote.feeKobo / 100),
          ],
          buttons: [
            { type: 'quick_reply', index: 0, payload: 'confirm_delivery' },
            { type: 'quick_reply', index: 1, payload: 'decline_delivery' },
          ],
        },
      })
      return
    }

    // No dedicated action-token page exists for fulfilment decisions (unlike
    // order/payment review) — the dashboard order list is the MVP fallback,
    // same as what the WhatsApp "LINK" reply already points merchants to.
    await notifyMerchantOnSourceChannel(this.db, this.nats, {
      merchantId,
      sourceChannel: payload.customerChannel,
      actionUrl: `${config.DASHBOARD_URL}/dashboard/orders`,
      template: {
        name: 'mesa_payment_confirmed',
        languageCode: 'en',
        bodyParams: [
          shortOrderRef(payload.orderId),
          payload.customerName ? `${payload.customerName}(${payload.customerPhone})` : payload.customerPhone,
          payload.itemsSummary,
          money(payload.totalPaid),
        ],
        buttons: [
          { type: 'quick_reply', index: 0, payload: 'book_rider' },
          { type: 'quick_reply', index: 1, payload: 'self_deliver' },
          { type: 'quick_reply', index: 2, payload: 'pickup' },
        ],
      },
    })
  }

  async handleMerchantReply(merchantId: string, text: string, replyChannel: 'whatsapp' | 'instagram'): Promise<boolean> {
    const pending = await this.pending?.get<PendingFulfilmentPayload>(merchantId, 'PENDING_FULFILMENT_DECISION')
    if (!pending) return false

    const reply = normalizeReply(text)
    if (['link', 'dashboard', 'open', 'review'].includes(reply)) {
      await notifyMerchantOnSourceChannel(this.db, this.nats, {
        merchantId,
        sourceChannel: replyChannel,
        message: 'Open Mesa to manage fulfilment from the order page.',
      })
      return true
    }

    if (pending.quote && ['confirm_delivery', 'confirm delivery'].includes(reply)) {
      await this.handleConfirmDelivery(merchantId, pending, replyChannel)
      return true
    }

    if (pending.quote && ['decline_delivery', 'decline delivery'].includes(reply)) {
      const { claimed, promoted } = await this.pending!.resolve(merchantId, 'PENDING_FULFILMENT_DECISION', 'DONE')
      if (claimed) {
        await this.dispatchManually(pending.fulfilmentId, merchantId, pending.customerPhone, pending.customerChannel)
        if (promoted) await this.notifyPendingFulfilmentDecision(merchantId, promoted as PendingFulfilmentPayload)
      }
      return true
    }

    if (['book_rider', 'book rider', 'book', 'rider'].includes(reply)) {
      await this.db.update(fulfilments)
        .set({ mode: 'BOOK_RIDER', status: 'ADDRESS_REQUIRED', updatedAt: new Date() })
        .where(eq(fulfilments.id, pending.fulfilmentId))
      if (this.pending) {
        const { promoted } = await this.pending.resolve(merchantId, 'PENDING_FULFILMENT_DECISION', 'DONE')
        if (promoted) await this.notifyPendingFulfilmentDecision(merchantId, promoted as PendingFulfilmentPayload)
      }

      const merchant = await this.db.query.merchants.findFirst({
        where: eq(merchants.id, merchantId),
        columns: { name: true },
      })
      await this.nats.publish({
        subject: SUBJECTS.NOTIFICATION_SEND,
        merchantId,
        to: pending.customerPhone,
        channel: pending.customerChannel as 'whatsapp' | 'instagram',
        message: addressRequestMessage(merchant?.name ?? 'the merchant', pending.customerChannel),
      } satisfies NotificationSendEvent)
      await notifyMerchantOnSourceChannel(this.db, this.nats, {
        merchantId,
        sourceChannel: replyChannel,
        message: 'Okay. Mesa has asked the customer for their delivery address.',
      })
      return true
    }

    if (['self_deliver', 'self deliver'].includes(reply)) {
      await this.db.update(fulfilments)
        .set({ mode: 'SELF_DELIVER', status: 'ADDRESS_REQUIRED', updatedAt: new Date() })
        .where(eq(fulfilments.id, pending.fulfilmentId))
      if (this.pending) {
        const { promoted } = await this.pending.resolve(merchantId, 'PENDING_FULFILMENT_DECISION', 'DONE')
        if (promoted) await this.notifyPendingFulfilmentDecision(merchantId, promoted as PendingFulfilmentPayload)
      }
      const merchant = await this.db.query.merchants.findFirst({
        where: eq(merchants.id, merchantId),
        columns: { name: true },
      })
      await this.nats.publish({
        subject: SUBJECTS.NOTIFICATION_SEND,
        merchantId,
        to: pending.customerPhone,
        channel: pending.customerChannel as 'whatsapp' | 'instagram',
        message: addressRequestMessage(merchant?.name ?? 'the merchant', pending.customerChannel),
      } satisfies NotificationSendEvent)
      await notifyMerchantOnSourceChannel(this.db, this.nats, {
        merchantId,
        sourceChannel: replyChannel,
        message: 'Okay. Mesa has asked the customer for their delivery address.',
      })
      return true
    }

    if (['pickup', 'customer pickup', 'pick up'].includes(reply)) {
      await this.db.update(fulfilments)
        .set({ mode: 'CUSTOMER_PICKUP', status: 'CUSTOMER_PICKUP', updatedAt: new Date() })
        .where(eq(fulfilments.id, pending.fulfilmentId))
      if (this.pending) {
        const { promoted } = await this.pending.resolve(merchantId, 'PENDING_FULFILMENT_DECISION', 'DONE')
        if (promoted) await this.notifyPendingFulfilmentDecision(merchantId, promoted as PendingFulfilmentPayload)
      }
      await this.nats.publish({
        subject: SUBJECTS.NOTIFICATION_SEND,
        merchantId,
        to: pending.customerPhone,
        channel: pending.customerChannel as 'whatsapp' | 'instagram',
        message: 'Your payment has been confirmed. The merchant will let you know when your order is ready for pickup.',
      } satisfies NotificationSendEvent)
      await notifyMerchantOnSourceChannel(this.db, this.nats, {
        merchantId,
        sourceChannel: replyChannel,
        message: 'Fulfilment marked as customer pickup.',
      })
      return true
    }

    return true
  }

  private async handleConfirmDelivery(
    merchantId: string,
    pending: PendingFulfilmentPayload,
    replyChannel: 'whatsapp' | 'instagram',
  ): Promise<void> {
    const quote = pending.quote!
    const fulfilment = await this.db.query.fulfilments.findFirst({ where: eq(fulfilments.id, pending.fulfilmentId) })
    if (!fulfilment) return

    let feeKobo = quote.feeKobo
    let providerQuoteId = quote.providerQuoteId

    if (new Date(quote.expiresAt).getTime() <= Date.now()) {
      const requoted = await this.requestQuote(quote.provider, fulfilment.pickupAddress, fulfilment.dropoffAddress, fulfilment.dropoffState, fulfilment.packageDescription, fulfilment.packageValue)
      if (requoted.status !== 'quoted' || requoted.feeKobo == null) {
        if (this.pending) {
          const { claimed, promoted } = await this.pending.resolve(merchantId, 'PENDING_FULFILMENT_DECISION', 'DONE')
          if (claimed) {
            await this.dispatchManually(pending.fulfilmentId, merchantId, pending.customerPhone, pending.customerChannel)
            if (promoted) await this.notifyPendingFulfilmentDecision(merchantId, promoted as PendingFulfilmentPayload)
          }
        }
        await notifyMerchantOnSourceChannel(this.db, this.nats, {
          merchantId,
          sourceChannel: replyChannel,
          message: "That delivery quote expired and a fresh one couldn't be fetched — this order has been routed for manual fulfilment instead.",
        })
        return
      }
      feeKobo = requoted.feeKobo
      providerQuoteId = requoted.providerQuoteId ?? providerQuoteId
    }

    // Compare-and-swap: only proceed from QUOTE_PENDING, so a duplicate tap
    // or a retried cron can never book the same fulfilment twice.
    const [claimedRow] = await this.db
      .update(fulfilments)
      .set({ updatedAt: new Date() })
      .where(and(eq(fulfilments.id, pending.fulfilmentId), eq(fulfilments.status, 'QUOTE_PENDING')))
      .returning({
        id: fulfilments.id,
        pickupAddress: fulfilments.pickupAddress,
        dropoffAddress: fulfilments.dropoffAddress,
        dropoffState: fulfilments.dropoffState,
        packageDescription: fulfilments.packageDescription,
        packageValue: fulfilments.packageValue,
      })
    if (!claimedRow) return // already booked or resolved via another path

    const orderInput: DeliveryOrderInput = {
      pickupAddress: claimedRow.pickupAddress ?? '',
      pickupState: extractNigerianState(claimedRow.pickupAddress) ?? '',
      dropoffAddress: claimedRow.dropoffAddress ?? '',
      dropoffState: claimedRow.dropoffState ?? '',
      packageDescription: claimedRow.packageDescription ?? undefined,
      packageValueNaira: claimedRow.packageValue ? parseFloat(claimedRow.packageValue) : undefined,
      providerQuoteId: providerQuoteId ?? '',
      customerPhone: pending.customerPhone,
      customerName: pending.customerName,
    }

    const booking = quote.provider === 'KWIK' && this.redis
      ? await kwik.createTask(this.redis, orderInput)
      : await fez.createOrder(orderInput)

    if (booking.status === 'booked') {
      await this.db.update(fulfilments)
        .set({ status: 'BOOKED', providerOrderId: booking.providerOrderId, trackingUrl: booking.trackingUrl, updatedAt: new Date() })
        .where(eq(fulfilments.id, pending.fulfilmentId))
      // Kwik has no webhooks — this is the only way a booked Kwik order's
      // status ever moves forward. FEZ gets a real webhook instead.
      if (quote.provider === 'KWIK' && this.redis) {
        await enqueueKwikPoll(this.redis, pending.fulfilmentId)
      }
      if (this.pending) {
        const { promoted } = await this.pending.resolve(merchantId, 'PENDING_FULFILMENT_DECISION', 'DONE')
        if (promoted) await this.notifyPendingFulfilmentDecision(merchantId, promoted as PendingFulfilmentPayload)
      }
      await notifyMerchantOnSourceChannel(this.db, this.nats, {
        merchantId,
        sourceChannel: replyChannel,
        message: [
          `Delivery booked with ${quote.provider}.`,
          booking.trackingUrl ? `Tracking: ${booking.trackingUrl}` : undefined,
        ].filter(Boolean).join('\n'),
      })
      await this.nats.publish({
        subject: SUBJECTS.NOTIFICATION_SEND,
        merchantId,
        to: pending.customerPhone,
        channel: pending.customerChannel as 'whatsapp' | 'instagram',
        message: [
          'Your delivery has been booked.',
          booking.trackingUrl ? `Track it here: ${booking.trackingUrl}` : undefined,
        ].filter(Boolean).join('\n'),
      } satisfies NotificationSendEvent)
      return
    }

    if (booking.status === 'retryable' && this.redis) {
      // Leave status as-is (still QUOTE_PENDING from the CAS update above)
      // and let a background retry pick this up — the merchant's
      // confirmation must never be silently dropped just because the
      // provider's API hiccuped.
      await this.enqueueBookingRetry({
        fulfilmentId: pending.fulfilmentId,
        merchantId,
        provider: quote.provider,
        orderInput,
        customerPhone: pending.customerPhone,
        customerChannel: pending.customerChannel,
        attempt: 1,
      })
      await notifyMerchantOnSourceChannel(this.db, this.nats, {
        merchantId,
        sourceChannel: replyChannel,
        message: `${quote.provider} is temporarily unavailable — Mesa will keep trying to book this delivery and let you know.`,
      })
      return
    }

    // Hard error, or retryable with no redis to queue against — fall back
    // to manual rather than leave the order stuck with nothing happening.
    if (this.pending) {
      const { claimed, promoted } = await this.pending.resolve(merchantId, 'PENDING_FULFILMENT_DECISION', 'DONE')
      if (claimed) {
        await this.dispatchManually(pending.fulfilmentId, merchantId, pending.customerPhone, pending.customerChannel)
        if (promoted) await this.notifyPendingFulfilmentDecision(merchantId, promoted as PendingFulfilmentPayload)
      }
    }
    await notifyMerchantOnSourceChannel(this.db, this.nats, {
      merchantId,
      sourceChannel: replyChannel,
      message: `Couldn't book with ${quote.provider} — this order has been routed for manual fulfilment instead.`,
    })
  }

  private async requestQuote(
    provider: 'FEZ' | 'KWIK',
    pickupAddress: string | null,
    dropoffAddress: string | null,
    dropoffState: string | null,
    packageDescription: string | null,
    packageValue: string | null,
  ) {
    const input: DeliveryQuoteInput = {
      pickupAddress: pickupAddress ?? '',
      pickupState: extractNigerianState(pickupAddress) ?? '',
      dropoffAddress: dropoffAddress ?? '',
      dropoffState: dropoffState ?? '',
      packageDescription: packageDescription ?? undefined,
      packageValueNaira: packageValue ? parseFloat(packageValue) : undefined,
    }
    return provider === 'KWIK' && this.redis ? kwik.quote(this.redis, input) : fez.quote(input)
  }

  private async enqueueBookingRetry(payload: {
    fulfilmentId: string
    merchantId: string
    provider: 'FEZ' | 'KWIK'
    orderInput: DeliveryOrderInput
    customerPhone: string
    customerChannel: string
    attempt: number
  }): Promise<void> {
    if (!this.redis) return
    const retryAt = Date.now() + 5 * 60 * 1000
    await this.redis.set(`delivery_booking_retry:${payload.fulfilmentId}`, JSON.stringify(payload), 'EX', 3600)
    await this.redis.zadd('delivery_booking_retries', retryAt, payload.fulfilmentId)
  }

  async processBookingRetries(): Promise<void> {
    if (!this.redis) return
    const due = await this.redis.zrangebyscore('delivery_booking_retries', 0, Date.now())
    if (due.length === 0) return

    for (const fulfilmentId of due) {
      const raw = await this.redis.get(`delivery_booking_retry:${fulfilmentId}`)
      await this.redis.zrem('delivery_booking_retries', fulfilmentId)
      await this.redis.del(`delivery_booking_retry:${fulfilmentId}`)
      if (!raw) continue

      const payload = JSON.parse(raw) as {
        fulfilmentId: string; merchantId: string; provider: 'FEZ' | 'KWIK'
        orderInput: DeliveryOrderInput; customerPhone: string; customerChannel: string; attempt: number
      }

      // Only proceed if still QUOTE_PENDING — a merchant could have declined
      // or the order could have been resolved another way meanwhile.
      const fulfilment = await this.db.query.fulfilments.findFirst({ where: eq(fulfilments.id, payload.fulfilmentId) })
      if (!fulfilment || fulfilment.status !== 'QUOTE_PENDING') continue

      const booking = payload.provider === 'KWIK' && this.redis
        ? await kwik.createTask(this.redis, payload.orderInput)
        : await fez.createOrder(payload.orderInput)

      if (booking.status === 'booked') {
        await this.db.update(fulfilments)
          .set({ status: 'BOOKED', providerOrderId: booking.providerOrderId, trackingUrl: booking.trackingUrl, updatedAt: new Date() })
          .where(eq(fulfilments.id, payload.fulfilmentId))
        if (payload.provider === 'KWIK' && this.redis) {
          await enqueueKwikPoll(this.redis, payload.fulfilmentId)
        }
        await notifyMerchantOnSourceChannel(this.db, this.nats, {
          merchantId: payload.merchantId,
          sourceChannel: payload.customerChannel,
          message: [`Delivery booked with ${payload.provider}.`, booking.trackingUrl ? `Tracking: ${booking.trackingUrl}` : undefined].filter(Boolean).join('\n'),
        })
        await this.nats.publish({
          subject: SUBJECTS.NOTIFICATION_SEND,
          merchantId: payload.merchantId,
          to: payload.customerPhone,
          channel: payload.customerChannel as 'whatsapp' | 'instagram',
          message: ['Your delivery has been booked.', booking.trackingUrl ? `Track it here: ${booking.trackingUrl}` : undefined].filter(Boolean).join('\n'),
        } satisfies NotificationSendEvent)
      } else if (booking.status === 'retryable' && payload.attempt < 3) {
        await this.enqueueBookingRetry({ ...payload, attempt: payload.attempt + 1 })
      } else {
        await this.dispatchManually(payload.fulfilmentId, payload.merchantId, payload.customerPhone, payload.customerChannel)
        await notifyMerchantOnSourceChannel(this.db, this.nats, {
          merchantId: payload.merchantId,
          sourceChannel: payload.customerChannel,
          message: `Couldn't book with ${payload.provider} after retrying — this order has been routed for manual fulfilment instead.`,
        })
      }
    }
  }

  // Today's exact manual-MVP behavior — the fulfilment row already has
  // dropoffAddress/dispatchSummary/contactPhone from handleCustomerAddress,
  // this just flips status and sends the merchant the summary to forward
  // to their own rider/logistics partner.
  private async dispatchManually(fulfilmentId: string, merchantId: string, customerPhone: string, channel: string): Promise<void> {
    const fulfilment = await this.db.query.fulfilments.findFirst({ where: eq(fulfilments.id, fulfilmentId) })
    if (!fulfilment) return

    await this.db.update(fulfilments)
      .set({ status: 'READY_FOR_DISPATCH', updatedAt: new Date() })
      .where(eq(fulfilments.id, fulfilmentId))

    const merchant = await this.db.query.merchants.findFirst({ where: eq(merchants.id, merchantId), columns: { phone: true } })
    if (merchant?.phone && fulfilment.dispatchSummary) {
      await notifyMerchantOnSourceChannel(this.db, this.nats, {
        merchantId,
        sourceChannel: channel,
        message: [
          fulfilment.dispatchSummary,
          '',
          'Manual fulfilment MVP: send this to your rider or logistics partner.',
        ].join('\n'),
      })
    }
  }

  async handleCustomerAddress(merchantId: string, customerPhone: string, text: string, channel = 'whatsapp'): Promise<boolean> {
    const trimmed = text.trim()
    if (trimmed.length < 8 || !/[a-z0-9]/i.test(trimmed)) return false

    const fulfilment = await this.db.query.fulfilments.findFirst({
      where: and(
        eq(fulfilments.merchantId, merchantId),
        eq(fulfilments.customerPhone, customerPhone),
        eq(fulfilments.status, 'ADDRESS_REQUIRED'),
      ),
      orderBy: [desc(fulfilments.createdAt)],
    })
    if (!fulfilment) return false

    // Only Instagram needs a phone pulled out — WhatsApp's customerPhone is
    // already a real, callable number.
    const { phone: contactPhone, remainder } = channel === 'instagram'
      ? extractContactPhone(trimmed)
      : { phone: undefined, remainder: trimmed }
    const address = remainder.length > 0 ? remainder : trimmed

    const [merchant, orderItemsRows, confirmedPayment] = await Promise.all([
      this.db.query.merchants.findFirst({
        where: eq(merchants.id, merchantId),
        columns: { name: true, phone: true, config: true },
      }),
      this.db.query.orderItems.findMany({
        where: eq(orderItems.orderId, fulfilment.orderId),
        columns: { productName: true, quantity: true, agreedPrice: true },
      }),
      this.db.query.payments.findFirst({
        where: and(eq(payments.orderId, fulfilment.orderId), eq(payments.status, 'CONFIRMED')),
        orderBy: [desc(payments.confirmedAt)],
        columns: { amount: true },
      }),
    ])

    const summary = dispatchSummary({
      orderId: fulfilment.orderId,
      merchantName: merchant?.name ?? 'Mesa merchant',
      customerPhone,
      customerName: fulfilment.customerName,
      contactPhone: contactPhone ?? (channel === 'instagram' ? undefined : customerPhone),
      itemsSummary: formatItems(orderItemsRows),
      // packageValue is the order's total (for the rider/insurance) — the
      // actual amount confirmed as paid can be less (a merchant can CONFIRM
      // despite a mismatch), and showing packageValue here as "Total paid"
      // silently told the merchant they'd been paid in full when they
      // hadn't. Fall back to packageValue only if no confirmed payment
      // record exists at all.
      totalPaid: money(confirmedPayment?.amount ?? fulfilment.packageValue ?? 0),
      dropoffAddress: address,
    })

    const dropoffState = extractNigerianState(address)

    // Address/summary are needed by both the manual and provider-quote
    // paths (the latter falls back to the former on any failure), so
    // persist them unconditionally before branching.
    await this.db.update(fulfilments)
      .set({
        dropoffAddress: address,
        dropoffState: dropoffState ?? null,
        contactPhone: contactPhone ?? null,
        dispatchSummary: summary,
        updatedAt: new Date(),
      })
      .where(eq(fulfilments.id, fulfilment.id))

    await this.nats.publish({
      subject: SUBJECTS.NOTIFICATION_SEND,
      merchantId,
      to: customerPhone,
      channel: channel as 'whatsapp' | 'instagram',
      message: 'Thanks. Your delivery address has been received.',
    } satisfies NotificationSendEvent)

    // Real delivery-provider dispatch — BOOK_RIDER only (self_deliver/pickup
    // are the merchant explicitly opting out of any provider), and only
    // when the feature is on. Anything else here falls through to today's
    // manual behavior further down.
    const deliveryIntegrationsEnabled = (config.DELIVERY_INTEGRATIONS_ENABLED ?? process.env.DELIVERY_INTEGRATIONS_ENABLED) === 'true'
    if (fulfilment.mode === 'BOOK_RIDER' && deliveryIntegrationsEnabled && this.redis) {
      const merchantConfig = (merchant?.config as Record<string, unknown> | undefined) ?? {}
      const deliveryConfig = (merchantConfig.delivery as { enabled?: boolean; preferredProvider?: 'FEZ' | 'KWIK' } | undefined)
      if (deliveryConfig?.enabled) {
        const pickupState = extractNigerianState(fulfilment.pickupAddress)
        const provider = resolveProvider({ pickupState, dropoffState, preferredProvider: deliveryConfig.preferredProvider })
        const quoteResult = await this.requestQuote(provider, fulfilment.pickupAddress, address, dropoffState ?? null, fulfilment.packageDescription, fulfilment.packageValue)

        if (quoteResult.status === 'quoted' && quoteResult.feeKobo != null) {
          const expiresAt = quoteResult.expiresAt ?? new Date(Date.now() + DELIVERY_QUOTE_VALIDITY_MS).toISOString()
          await this.db.update(fulfilments)
            .set({
              status: 'QUOTE_PENDING',
              provider,
              providerQuoteId: quoteResult.providerQuoteId,
              deliveryFeeKobo: quoteResult.feeKobo,
              quoteExpiresAt: new Date(expiresAt),
              updatedAt: new Date(),
            })
            .where(eq(fulfilments.id, fulfilment.id))

          const quotePayload: PendingFulfilmentPayload = {
            orderId: fulfilment.orderId,
            fulfilmentId: fulfilment.id,
            customerPhone,
            customerChannel: channel,
            customerName: fulfilment.customerName ?? undefined,
            itemsSummary: formatItems(orderItemsRows),
            totalPaid: confirmedPayment?.amount ? parseFloat(confirmedPayment.amount) : parseFloat(fulfilment.packageValue ?? '0'),
            createdAt: new Date().toISOString(),
            quote: {
              provider: provider as 'FEZ' | 'KWIK',
              feeKobo: quoteResult.feeKobo,
              providerQuoteId: quoteResult.providerQuoteId ?? '',
              expiresAt,
            },
          }

          let surfaced = true
          if (this.pending) {
            const result = await this.pending.upsert(merchantId, 'PENDING_FULFILMENT_DECISION', quotePayload)
            surfaced = result.surfaced
          }
          if (surfaced) await this.notifyPendingFulfilmentDecision(merchantId, quotePayload)
          return true
        }
        // quote unavailable/error — fall through to manual below.
      }
    }

    await this.dispatchManually(fulfilment.id, merchantId, customerPhone, channel)
    return true
  }
}
