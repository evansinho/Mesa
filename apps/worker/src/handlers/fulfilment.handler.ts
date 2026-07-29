import type { Db } from '@mesa/db'
import { fulfilments, merchants, orderItems, orders, conversations } from '@mesa/db'
import type { MesaNatsClient } from '@mesa/nats'
import { NotificationSendEvent, PaymentConfirmedEvent, SUBJECTS } from '@mesa/types'
import { and, desc, eq } from 'drizzle-orm'
import type { PendingDecisions, PendingFulfilmentPayload } from './pending-decisions'
import { notifyMerchantOnSourceChannel } from './notify-merchant'
import { config } from '@mesa/config'

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

export class FulfilmentHandler {
  constructor(
    private db: Db,
    private nats: MesaNatsClient,
    private pending?: PendingDecisions,
  ) {}

  async startAfterPayment(event: PaymentConfirmedEvent): Promise<void> {
    const order = await this.db.query.orders.findFirst({
      where: eq(orders.id, event.orderId),
    })
    if (!order) return

    const merchant = await this.db.query.merchants.findFirst({
      where: eq(merchants.id, event.merchantId),
      columns: { name: true, phone: true, config: true },
    })
    if (!merchant?.phone) return

    const items = await this.db.query.orderItems.findMany({
      where: eq(orderItems.orderId, event.orderId),
      columns: { productName: true, quantity: true, agreedPrice: true },
    })
    const itemsSummary = formatItems(items)
    const pickupAddress = ((merchant.config as Record<string, unknown>)?.pickupAddress
      ?? (merchant.config as Record<string, unknown>)?.businessAddress) as string | undefined

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
        columns: { channel: true },
      })
      : undefined

    await this.pending?.upsert(event.merchantId, 'PENDING_FULFILMENT_DECISION', {
      orderId: event.orderId,
      fulfilmentId: fulfilment.id,
      customerPhone: order.customerPhone,
      customerChannel: conv?.channel ?? 'whatsapp',
      customerName: order.customerName ?? undefined,
      itemsSummary,
      totalPaid: event.amount,
    })

    // No dedicated action-token page exists for fulfilment decisions (unlike
    // order/payment review) — the dashboard order list is the MVP fallback,
    // same as what the WhatsApp "LINK" reply already points merchants to.
    await notifyMerchantOnSourceChannel(this.db, this.nats, {
      merchantId: event.merchantId,
      sourceChannel: conv?.channel ?? 'whatsapp',
      actionUrl: `${config.DASHBOARD_URL}/dashboard/orders`,
      template: {
        name: 'mesa_payment_confirmed',
        languageCode: 'en',
        bodyParams: [
          shortOrderRef(event.orderId),
          order.customerName ? `${order.customerName}(${order.customerPhone})` : order.customerPhone,
          itemsSummary,
          money(event.amount),
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

    if (['book_rider', 'book rider', 'book', 'rider', 'delivery', 'deliver'].includes(reply)) {
      await this.db.update(fulfilments)
        .set({ mode: 'BOOK_RIDER', status: 'ADDRESS_REQUIRED', updatedAt: new Date() })
        .where(eq(fulfilments.id, pending.fulfilmentId))
      await this.pending?.resolve(merchantId, 'PENDING_FULFILMENT_DECISION', 'DONE')

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

    if (['self_deliver', 'self deliver', 'self-deliver', 'self delivery', 'manual', 'i will deliver'].includes(reply)) {
      await this.db.update(fulfilments)
        .set({ mode: 'SELF_DELIVER', status: 'ADDRESS_REQUIRED', updatedAt: new Date() })
        .where(eq(fulfilments.id, pending.fulfilmentId))
      await this.pending?.resolve(merchantId, 'PENDING_FULFILMENT_DECISION', 'DONE')
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
      await this.pending?.resolve(merchantId, 'PENDING_FULFILMENT_DECISION', 'DONE')
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

    const [merchant, orderItemsRows] = await Promise.all([
      this.db.query.merchants.findFirst({
        where: eq(merchants.id, merchantId),
        columns: { name: true, phone: true },
      }),
      this.db.query.orderItems.findMany({
        where: eq(orderItems.orderId, fulfilment.orderId),
        columns: { productName: true, quantity: true, agreedPrice: true },
      }),
    ])

    const summary = dispatchSummary({
      orderId: fulfilment.orderId,
      merchantName: merchant?.name ?? 'Mesa merchant',
      customerPhone,
      customerName: fulfilment.customerName,
      contactPhone: contactPhone ?? (channel === 'instagram' ? undefined : customerPhone),
      itemsSummary: formatItems(orderItemsRows),
      totalPaid: money(fulfilment.packageValue ?? 0),
      dropoffAddress: address,
    })

    await this.db.update(fulfilments)
      .set({
        dropoffAddress: address,
        contactPhone: contactPhone ?? null,
        dispatchSummary: summary,
        status: 'READY_FOR_DISPATCH',
        updatedAt: new Date(),
      })
      .where(eq(fulfilments.id, fulfilment.id))

    if (merchant?.phone) {
      await notifyMerchantOnSourceChannel(this.db, this.nats, {
        merchantId,
        sourceChannel: channel,
        message: [
          summary,
          '',
          'Manual fulfilment MVP: send this to your rider or logistics partner.',
        ].join('\n'),
      })
    }

    await this.nats.publish({
      subject: SUBJECTS.NOTIFICATION_SEND,
      merchantId,
      to: customerPhone,
      channel: channel as 'whatsapp' | 'instagram',
      message: 'Thanks. Your delivery address has been received.',
    } satisfies NotificationSendEvent)

    return true
  }
}
