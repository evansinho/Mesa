import type { Db } from '@mesa/db'
import { conversations, fulfilments, fulfilmentStatusEnum, orders } from '@mesa/db'
import type { MesaNatsClient } from '@mesa/nats'
import type { Redis } from 'ioredis'
import { NotificationSendEvent, SUBJECTS } from '@mesa/types'
import { eq, isNotNull } from 'drizzle-orm'
import * as kwik from '../delivery/kwik'
import type { DeliveryStatusResult } from '../delivery/types'
import { notifyMerchantOnSourceChannel } from './notify-merchant'

type FulfilmentStatus = (typeof fulfilmentStatusEnum.enumValues)[number]

const KWIK_POLL_INITIAL_DELAY_MS = 2 * 60 * 1000
const KWIK_POLL_MAX_DELAY_MS = 15 * 60 * 1000
// Kwik is same-city, minutes-scale — if a booking hasn't reached a terminal
// status after this many polls (2min, 4min, 8min... capped at 15min each),
// stop polling rather than doing so forever. At the 15min cap this is ~15
// hours, comfortably past any real same-day delivery window.
const KWIK_POLL_MAX_ATTEMPTS = 60

function nextKwikPollDelayMs(attempt: number): number {
  return Math.min(KWIK_POLL_INITIAL_DELAY_MS * 2 ** (attempt - 1), KWIK_POLL_MAX_DELAY_MS)
}

// Standalone rather than a DeliveryHandler method — fulfilment.handler.ts
// calls this right after a successful Kwik booking (createTask), and
// shouldn't need a full DeliveryHandler instance just to kick off polling.
export async function enqueueKwikPoll(redis: Redis, fulfilmentId: string, attempt = 1): Promise<void> {
  const pollAt = Date.now() + nextKwikPollDelayMs(attempt)
  await redis.set(`kwik_poll:${fulfilmentId}`, JSON.stringify({ fulfilmentId, attempt }), 'EX', 24 * 60 * 60)
  await redis.zadd('kwik_polls', pollAt, fulfilmentId)
}

// Kwik has no webhooks — mirrors FEZ's webhook-driven updates for the one
// provider that requires polling instead.
function mapKwikStatusToFulfilmentStatus(raw: DeliveryStatusResult['status']): FulfilmentStatus | undefined {
  switch (raw) {
    case 'delivered':
      return 'DELIVERED'
    case 'cancelled':
    case 'failed':
      return 'CANCELLED'
    case 'in_transit':
      return 'IN_TRANSIT'
    default:
      // 'pending'/'assigned' — still in progress, not a regression from
      // whatever forward status (e.g. BOOKED) is already recorded.
      return undefined
  }
}

// One merchant-facing line per Mesa status, plus an optional customer line
// — matches the tone of the "Your delivery has been booked." message sent
// at booking time in fulfilment.handler.ts. Statuses with no entry here
// (QUOTE_PENDING, BOOKED, etc.) aren't provider-status transitions worth a
// separate notification — booking confirmation is already sent inline.
const STATUS_MESSAGES: Partial<Record<FulfilmentStatus, { merchant: string; customer?: string }>> = {
  IN_TRANSIT: {
    merchant: 'Delivery update: the rider has picked up this order and it is on the way.',
    customer: 'Your order is on the way!',
  },
  DELIVERED: {
    merchant: 'Delivery update: this order has been delivered.',
    customer: 'Your order has been delivered. Thank you for shopping with us!',
  },
  CANCELLED: {
    merchant: 'Delivery update: the delivery provider cancelled this booking. Please arrange delivery for this order manually.',
  },
}

export class DeliveryHandler {
  constructor(
    private db: Db,
    private nats: MesaNatsClient,
    private redis: Redis,
  ) {}

  async processKwikPolls(): Promise<void> {
    const due = await this.redis.zrangebyscore('kwik_polls', 0, Date.now())
    if (due.length === 0) return

    for (const fulfilmentId of due) {
      const raw = await this.redis.get(`kwik_poll:${fulfilmentId}`)
      // Claim before processing — never risk two worker replicas polling
      // (and both re-enqueueing) the same fulfilment off one due entry.
      await this.redis.zrem('kwik_polls', fulfilmentId)
      await this.redis.del(`kwik_poll:${fulfilmentId}`)
      if (!raw) continue

      const payload = JSON.parse(raw) as { fulfilmentId: string; attempt: number }
      const fulfilment = await this.db.query.fulfilments.findFirst({ where: eq(fulfilments.id, payload.fulfilmentId) })
      if (!fulfilment || fulfilment.provider !== 'KWIK' || !fulfilment.providerOrderId) continue
      if (fulfilment.status === 'DELIVERED' || fulfilment.status === 'CANCELLED') continue

      const result = await kwik.getStatus(this.redis, fulfilment.providerOrderId)
      const mappedStatus = mapKwikStatusToFulfilmentStatus(result.status)

      await this.db.update(fulfilments)
        .set({
          providerStatus: result.raw ?? fulfilment.providerStatus,
          ...(mappedStatus ? { status: mappedStatus } : {}),
          updatedAt: new Date(),
        })
        .where(eq(fulfilments.id, fulfilment.id))

      const isTerminal = mappedStatus === 'DELIVERED' || mappedStatus === 'CANCELLED'
      if (!isTerminal && payload.attempt < KWIK_POLL_MAX_ATTEMPTS) {
        await enqueueKwikPoll(this.redis, fulfilment.id, payload.attempt + 1)
      }
    }
  }

  // Turns a providerStatus change — however it got there, FEZ's webhook
  // (apps/api, no NATS access) or Kwik's poll above — into an actual
  // WhatsApp/Instagram message. This is the one place that does, for both
  // providers.
  async processDeliveryStatusNotifications(): Promise<void> {
    const rows = await this.db.query.fulfilments.findMany({
      where: isNotNull(fulfilments.provider),
    })

    for (const row of rows) {
      const messages = STATUS_MESSAGES[row.status]
      if (!messages) continue
      const lastNotified = (row.metadata as Record<string, unknown> | null | undefined)?.lastNotifiedProviderStatus
      if (lastNotified === row.providerStatus) continue

      const order = await this.db.query.orders.findFirst({ where: eq(orders.id, row.orderId) })
      const conv = order?.conversationId
        ? await this.db.query.conversations.findFirst({
          where: eq(conversations.id, order.conversationId),
          columns: { channel: true },
        })
        : undefined
      const channel = conv?.channel ?? 'whatsapp'

      await notifyMerchantOnSourceChannel(this.db, this.nats, {
        merchantId: row.merchantId,
        sourceChannel: channel,
        message: messages.merchant,
      })
      if (messages.customer) {
        await this.nats.publish({
          subject: SUBJECTS.NOTIFICATION_SEND,
          merchantId: row.merchantId,
          to: row.customerPhone,
          channel: channel as 'whatsapp' | 'instagram',
          message: messages.customer,
        } satisfies NotificationSendEvent)
      }

      await this.db.update(fulfilments)
        .set({ metadata: { ...(row.metadata ?? {}), lastNotifiedProviderStatus: row.providerStatus } })
        .where(eq(fulfilments.id, row.id))
    }
  }
}
