import { createHash, randomBytes } from 'crypto'
import type { Db } from '@mesa/db'
import { payments, orders, merchants, agentTasks, conversations } from '@mesa/db'
import type { MesaNatsClient } from '@mesa/nats'
import type { Redis } from 'ioredis'
import {
  PaymentScreenshotReceivedEvent,
  PaymentConfirmedEvent,
  NotificationSendEvent,
  SUBJECTS,
} from '@mesa/types'
import { extractPaymentDetails, OCR_CONFIDENCE_THRESHOLD } from '@mesa/ai'
import { eq } from 'drizzle-orm'
import { validate } from '../payments/mono'
import { checkReference } from '../payments/fraud-checks'
import type { PendingDecisions, PendingPaymentPayload } from './pending-decisions'
import type { AiQuota, SubscriptionTier } from '../ai/quota'
import { config } from '@mesa/config'
import { paymentsAutoConfirmed } from '../metrics'
import { notifyMerchantOnSourceChannel, type MerchantDecisionTemplate } from './notify-merchant'

export type PaymentReviewReason =
  | 'low_confidence'
  | 'amount_mismatch'
  | 'mono_failed'
  | 'reference_reused'
  | 'mono_required'

function formatNaira(amount: number | undefined): string {
  return amount && Number.isFinite(amount) && amount > 0
    ? `₦${amount.toLocaleString()}`
    : 'unknown amount'
}

function paymentReviewReasonText(reason: PaymentReviewReason, expected?: number, received?: number): string {
  switch (reason) {
    case 'amount_mismatch': {
      // Expected/received are already shown as their own lines in the
      // template — restating them here was redundant. What the merchant
      // actually needs from this line is how far off it is, in plain
      // terms, before they tap CONFIRM on what could be a partial payment.
      if (expected && expected > 0 && received != null && received >= 0) {
        const pct = Math.round((received / expected) * 100)
        if (received < expected) {
          return `Customer paid about ${pct}% of the order total — this looks like a partial payment, not a mismatch.`
        }
        return `Customer paid ${pct}% of the order total — more than expected.`
      }
      return 'Payment amount does not match the order total'
    }
    case 'low_confidence':
      return 'Payment proof could not be read clearly'
    case 'mono_failed':
      return 'Bank verification did not find the payment yet'
    case 'reference_reused':
      return 'Payment reference may have been used before'
    case 'mono_required':
      return 'Bank account not connected'
  }
}

// Shared by the initial payment-review prompt and the "check again" cron
// reminder (apps/worker/src/index.ts) — both need to be the exact same
// template/button structure, since a second, separately-defined template
// for the reminder previously drifted from what was actually approved on
// Meta and got rejected outright (#132018).
export function buildPaymentReviewTemplate(params: {
  orderId: string
  customerLabel: string
  expected: number | undefined
  received: number | undefined
  reason: PaymentReviewReason
}): MerchantDecisionTemplate {
  return {
    name: 'mesa_payment_needs_confirmation_v2',
    languageCode: 'en',
    bodyParams: [
      params.orderId.slice(-8).toUpperCase(),
      params.customerLabel,
      formatNaira(params.expected),
      formatNaira(params.received ?? params.expected),
      paymentReviewReasonText(params.reason, params.expected, params.received),
    ],
    buttons: [
      { type: 'quick_reply', index: 0, payload: 'confirm_payment' },
      { type: 'quick_reply', index: 1, payload: 'payment_not_yet' },
      { type: 'quick_reply', index: 2, payload: 'payment_dispute' },
    ],
  }
}

export class PaymentHandler {
  constructor(
    private db: Db,
    private nats: MesaNatsClient,
    private log: Pick<Console, 'info' | 'warn' | 'error'> = console,
    private eventStore?: {
      append: (aggregateId: string, aggregateType: string, eventType: string, payload: Record<string, unknown>) => Promise<void>
      appendOnce: (aggregateId: string, aggregateType: string, eventType: string, payload: Record<string, unknown>) => Promise<boolean>
      emit: <E extends { subject: string }>(event: E) => Promise<void>
    },
    private redis?: Redis,
    private pending?: PendingDecisions,
    private aiQuota?: AiQuota
  ) {}

  async handle(event: PaymentScreenshotReceivedEvent): Promise<void> {
    const { orderId, merchantId, screenshotUrl, screenshotHash } = event

    // Idempotency check — has this screenshot already been processed?
    const duplicate = await this.db.query.payments.findFirst({
      where: eq(payments.screenshotHash, screenshotHash),
    })
    if (duplicate) {
      this.log.info(JSON.stringify({
        level: 'info',
        msg: 'Duplicate screenshot skipped',
        screenshotHash,
        orderId,
        merchantId,
      }))
      return
    }

    // Fetch the order to get expected amount
    const order = await this.db.query.orders.findFirst({
      where: eq(orders.id, orderId),
    })
    if (!order) {
      this.log.error(JSON.stringify({
        level: 'error',
        msg: 'Order not found for payment screenshot',
        orderId,
        merchantId,
      }))
      return
    }

    // message.handler.ts already sends a "screenshot received" ack the
    // moment the screenshot arrives (correctly on the customer's actual
    // channel) — this used to send a second, near-identical one on top of
    // it (and hardcoded to whatsapp, which is wrong for an Instagram
    // customer whose customerPhone is really an IGSID). Removed rather
    // than kept as the "before OCR" ack — message.handler.ts's fires even
    // earlier, so nothing is lost.

    // Fetch the merchant first — needed for both the AI quota check and the
    // downstream Mono / tier branches.
    const merchant = await this.db.query.merchants.findFirst({
      where: eq(merchants.id, merchantId),
    })
    const monoAccountId = (merchant?.config as Record<string, unknown>)?.monoAccountId as string | undefined

    // Per-merchant AI quota. OCR is the expensive call (Claude Sonnet vision).
    // If the merchant has exhausted their daily quota, skip OCR and route the
    // payment to manual review.
    if (this.aiQuota) {
      const tier = (merchant?.subscriptionTier as SubscriptionTier | undefined) ?? 'starter'
      const quota = await this.aiQuota.checkAndConsume(merchantId, tier)
      if (!quota.allowed) {
        // Create a minimal PENDING payment row so the merchant's eventual
        // YES has something to flip to CONFIRMED. Without this, the
        // pending-payment-review resolve path would silently do nothing.
        await this.db.insert(payments).values({
          orderId,
          merchantId,
          screenshotUrl,
          screenshotHash,
          status: 'PENDING',
        })
        if (merchant && (await this.aiQuota.shouldNotifyExhaustion(merchantId))) {
          await this.nats.publish({
            subject: SUBJECTS.NOTIFICATION_SEND,
            merchantId,
            to: merchant.phone,
            channel: 'whatsapp' as const,
            message: `Daily AI processing limit reached (${quota.limit}/day). Incoming payment screenshots will require manual confirmation until midnight. Upgrade your plan for a higher limit.`,
          } satisfies NotificationSendEvent)
        }
        await this.notifyMerchantLowConfidence(merchantId, orderId, screenshotUrl)
        this.log.warn(JSON.stringify({
          level: 'warn',
          msg: 'OCR skipped — AI quota exhausted',
          merchantId,
          orderId,
          used: quota.used,
          limit: quota.limit,
        }))
        return
      }
    }

    // Run OCR (two-tier: Haiku first, Sonnet escalation on low confidence).
    const ocr = await extractPaymentDetails(screenshotUrl)
    if (this.aiQuota) {
      // Record every Claude call that actually ran. An escalated OCR
      // billed for both Haiku and Sonnet; the dashboard tracks both.
      if (ocr.escalated) {
        await this.aiQuota.recordUsage(merchantId, 'haiku')
        await this.aiQuota.recordUsage(merchantId, 'sonnet')
      } else {
        await this.aiQuota.recordUsage(merchantId, ocr.modelUsed ?? 'haiku')
      }
    }

    // Create payment record
    const [payment] = await this.db
      .insert(payments)
      .values({
        orderId,
        merchantId,
        screenshotUrl,
        screenshotHash,
        amount: ocr.amount?.toString(),
        bankName: ocr.bankName,
        reference: ocr.reference,
        rawOcrData: ocr as unknown as Record<string, unknown>,
        status: 'PENDING',
      })
      .returning({ id: payments.id })
    if (this.eventStore) {
      await this.eventStore.appendOnce(orderId, 'order', 'PAYMENT_SCREENSHOT_RECEIVED', {
        merchantId,
        screenshotUrl,
        screenshotHash,
      })
    }

    if (ocr.confidence >= OCR_CONFIDENCE_THRESHOLD && ocr.amount) {
      // High confidence: candidate for auto-confirm.
      const expectedTotal = parseFloat(order.total)
      const amountMatches = Math.abs(ocr.amount - expectedTotal) < 1 // allow ₦1 rounding

      if (amountMatches) {
        // Fraud check: has this bank reference been seen on another CONFIRMED
        // payment in the last 72h? If so, this screenshot is either a replay
        // (forged) or a legitimate customer mix-up. Either way: do not
        // auto-confirm. Push to manual review.
        if (ocr.reference) {
          const fraud = await checkReference(this.db, merchantId, ocr.reference, payment.id)
          if (!fraud.ok) {
            this.log.warn(JSON.stringify({
              level: 'warn',
              msg: 'Payment flagged: reference reused',
              orderId,
              merchantId,
              reference: ocr.reference,
              reason: fraud.reason,
              conflictingPaymentId: fraud.conflictingPaymentId,
              conflictingMerchantId: fraud.conflictingMerchantId,
            }))
            await this.notifyReferenceReused(merchantId, orderId, ocr.reference, fraud.conflictingPaymentId)
            return
          }
        }

        // Auto-confirm requires Mono validation. No Mono account on the
        // merchant → manual review (the merchant has eyes on their bank, we
        // don't). OCR confidence + amount match alone are never sufficient.
        if (!monoAccountId) {
          this.log.info(JSON.stringify({
            level: 'info',
            msg: 'Payment routed to manual review — Mono not connected',
            orderId,
            merchantId,
          }))
          await this.notifyMonoRequired(merchantId, orderId)
          return
        }

        // Mono is connected but OCR didn't extract a reference — we have
        // nothing to validate against. Route to manual review under the
        // existing low-confidence flow.
        if (!ocr.reference) {
          this.log.info(JSON.stringify({
            level: 'info',
            msg: 'Payment routed to manual review — no reference extracted from OCR',
            orderId,
            merchantId,
          }))
          await this.notifyMerchantLowConfidence(merchantId, orderId, screenshotUrl)
          return
        }

        // Both present — Mono is the source of truth.
        const mono = await validate(ocr.reference, monoAccountId)
        if (mono.status === 'confirmed') {
          await this.db
            .update(payments)
            .set({ status: 'CONFIRMED', confirmedAt: new Date() })
            .where(eq(payments.id, payment.id))
        } else {
          const isPending = mono.status === 'reference_not_found'
          await this.db
            .update(payments)
            .set({ status: isPending ? 'PENDING' : 'FAILED' })
            .where(eq(payments.id, payment.id))
          if (isPending && this.redis) {
            await this.enqueueMonoRetry(payment.id, {
              orderId,
              merchantId,
              reference: ocr.reference,
              monoAccountId,
              amount: ocr.amount,
              attempt: 1,
            })
          }
          return
        }

        const confirmedEvent: PaymentConfirmedEvent = {
          subject: SUBJECTS.PAYMENT_CONFIRMED,
          orderId,
          merchantId,
          amount: ocr.amount,
          reference: ocr.reference,
        }
        if (this.eventStore) {
          await this.eventStore.emit(confirmedEvent)
        } else {
          await this.nats.publish(confirmedEvent)
        }

        paymentsAutoConfirmed.add(1)
        this.log.info(JSON.stringify({
          level: 'info',
          msg: 'Payment auto-confirmed',
          orderId,
          merchantId,
          amount: ocr.amount,
          reference: ocr.reference,
        }))
      } else {
        // Amount mismatch — notify merchant
        await this.notifyMerchantMismatch(merchantId, orderId, ocr.amount, expectedTotal)
      }
    } else {
      // Low confidence — flag for manual review
      await this.notifyMerchantLowConfidence(merchantId, orderId, screenshotUrl)
      this.log.warn(JSON.stringify({
        level: 'warn',
        msg: 'Payment flagged for manual review',
        orderId,
        merchantId,
        confidence: ocr.confidence,
      }))
    }
  }

  private async generatePaymentToken(merchantId: string, taskId: string): Promise<string> {
    const token = randomBytes(32).toString('hex')
    const tokenHash = createHash('sha256').update(token).digest('hex')
    const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000)
    const actionUrl = `${config.DASHBOARD_URL}/actions/payment/${token}`

    await this.db.update(agentTasks)
      .set({ actionTokenHash: tokenHash, expiresAt })
      .where(eq(agentTasks.id, taskId))
    await this.pending?.update(merchantId, 'PENDING_PAYMENT_REVIEW', {
      actionToken: token,
      actionUrl,
    })

    return token
  }

  private async notifyMerchantPaymentReview(
    merchantId: string,
    orderId: string,
    received: number | undefined,
    reason: PaymentReviewReason,
  ): Promise<void> {
    const order = await this.db.query.orders.findFirst({
      where: eq(orders.id, orderId),
      columns: { total: true, customerName: true, customerPhone: true, conversationId: true },
    })
    const expected = order?.total ? parseFloat(order.total) : undefined
    const conv = order?.conversationId
      ? await this.db.query.conversations.findFirst({
        where: eq(conversations.id, order.conversationId),
        columns: { channel: true, customerName: true },
      })
      : undefined
    const pendingPayload = await this.pending?.get<PendingPaymentPayload>(merchantId, 'PENDING_PAYMENT_REVIEW')
    const actionUrl = pendingPayload?.actionUrl ?? `${config.DASHBOARD_URL}/actions/payment`
    await notifyMerchantOnSourceChannel(this.db, this.nats, {
      merchantId,
      sourceChannel: conv?.channel ?? 'whatsapp',
      actionUrl,
      template: buildPaymentReviewTemplate({
        orderId,
        // orders.customerName is a one-time snapshot taken at order creation
        // and can be null even when the conversation's own name resolved
        // later — fall back to it rather than showing a raw phone/IGSID.
        customerLabel: order?.customerName ?? conv?.customerName ?? order?.customerPhone ?? 'Customer',
        expected,
        received,
        reason,
      }),
    }, this.log)
  }

  private async notifyMerchantMismatch(
    merchantId: string,
    orderId: string,
    received: number,
    expected: number
  ): Promise<void> {
    const merchant = await this.db.query.merchants.findFirst({
      where: eq(merchants.id, merchantId),
      columns: { phone: true },
    })
    if (merchant) {
      if (this.pending) {
        const taskId = await this.pending.upsert(merchantId, 'PENDING_PAYMENT_REVIEW', {
          orderId,
          reason: 'amount_mismatch',
          received,
          expected,
        })
        await this.generatePaymentToken(merchantId, taskId)
      }
      await this.notifyMerchantPaymentReview(merchantId, orderId, received, 'amount_mismatch')
    }
    this.log.warn(JSON.stringify({
      level: 'warn',
      msg: 'Amount mismatch on payment',
      orderId,
      merchantId,
      received,
      expected,
    }))
  }

  private async enqueueMonoRetry(
    paymentId: string,
    payload: { orderId: string; merchantId: string; reference: string; monoAccountId: string; amount: number | undefined; attempt: number }
  ): Promise<void> {
    if (!this.redis) return
    const retryAt = Date.now() + 5 * 60 * 1000
    await this.redis.set(`mono_retry:${paymentId}`, JSON.stringify(payload), 'EX', 3600)
    await this.redis.zadd('mono_retries', retryAt, paymentId)
  }

  async processMonoRetries(): Promise<void> {
    if (!this.redis) return
    const due = await this.redis.zrangebyscore('mono_retries', 0, Date.now())
    if (due.length === 0) return

    for (const paymentId of due) {
      const raw = await this.redis.get(`mono_retry:${paymentId}`)
      await this.redis.zrem('mono_retries', paymentId)
      await this.redis.del(`mono_retry:${paymentId}`)

      if (!raw) continue

      const payload = JSON.parse(raw) as {
        orderId: string; merchantId: string; reference: string
        monoAccountId: string; amount: number | undefined; attempt: number
      }

      const mono = await validate(payload.reference, payload.monoAccountId)

      if (mono.status === 'confirmed') {
        await this.db.update(payments)
          .set({ status: 'CONFIRMED', confirmedAt: new Date() })
          .where(eq(payments.id, paymentId))
        const confirmedEvent: PaymentConfirmedEvent = {
          subject: SUBJECTS.PAYMENT_CONFIRMED,
          orderId: payload.orderId,
          merchantId: payload.merchantId,
          amount: payload.amount ?? 0,
          reference: payload.reference,
        }
        if (this.eventStore) {
          await this.eventStore.emit(confirmedEvent)
        } else {
          await this.nats.publish(confirmedEvent)
        }
        paymentsAutoConfirmed.add(1)
        this.log.info(JSON.stringify({ level: 'info', msg: 'Mono retry confirmed payment', paymentId, attempt: payload.attempt }))
      } else if (mono.status === 'reference_not_found' && payload.attempt < 3) {
        await this.enqueueMonoRetry(paymentId, { ...payload, attempt: payload.attempt + 1 })
        this.log.info(JSON.stringify({ level: 'info', msg: 'Mono retry re-enqueued', paymentId, attempt: payload.attempt + 1 }))
      } else {
        await this.db.update(payments)
          .set({ status: 'FAILED' })
          .where(eq(payments.id, paymentId))
        await this.notifyMerchantMonoFailed(payload.merchantId, payload.orderId)
        this.log.warn(JSON.stringify({ level: 'warn', msg: 'Mono retry exhausted — manual review required', paymentId, attempt: payload.attempt }))
      }
    }
  }

  private async notifyMerchantMonoFailed(merchantId: string, orderId: string): Promise<void> {
    const merchant = await this.db.query.merchants.findFirst({
      where: eq(merchants.id, merchantId),
      columns: { phone: true },
    })
    if (!merchant) return
    if (this.pending) {
      const taskId = await this.pending.upsert(merchantId, 'PENDING_PAYMENT_REVIEW', {
        orderId,
        reason: 'mono_failed',
      })
      await this.generatePaymentToken(merchantId, taskId)
    }
    await this.notifyMerchantPaymentReview(merchantId, orderId, undefined, 'mono_failed')
  }

  private async notifyMerchantLowConfidence(
    merchantId: string,
    orderId: string,
    screenshotUrl: string
  ): Promise<void> {
    const merchant = await this.db.query.merchants.findFirst({
      where: eq(merchants.id, merchantId),
      columns: { phone: true },
    })
    if (merchant) {
      if (this.pending) {
        const taskId = await this.pending.upsert(merchantId, 'PENDING_PAYMENT_REVIEW', {
          orderId,
          reason: 'low_confidence',
          screenshotUrl,
        })
        await this.generatePaymentToken(merchantId, taskId)
      }
      await this.notifyMerchantPaymentReview(merchantId, orderId, undefined, 'low_confidence')
    }
    this.log.warn(JSON.stringify({
      level: 'warn',
      msg: 'Low confidence OCR — manual review needed',
      orderId,
      merchantId,
    }))
  }

  private async notifyReferenceReused(
    merchantId: string,
    orderId: string,
    reference: string,
    conflictingPaymentId?: string,
  ): Promise<void> {
    const merchant = await this.db.query.merchants.findFirst({
      where: eq(merchants.id, merchantId),
      columns: { phone: true },
    })
    if (!merchant) return
    if (this.pending) {
      const taskId = await this.pending.upsert(merchantId, 'PENDING_PAYMENT_REVIEW', {
        orderId,
        reason: 'reference_reused',
        reference,
        conflictingPaymentId,
      })
      await this.generatePaymentToken(merchantId, taskId)
    }
    await this.notifyMerchantPaymentReview(merchantId, orderId, undefined, 'reference_reused')
  }

  private async notifyMonoRequired(merchantId: string, orderId: string): Promise<void> {
    const merchant = await this.db.query.merchants.findFirst({
      where: eq(merchants.id, merchantId),
      columns: { phone: true },
    })
    if (!merchant) return
    if (this.pending) {
      const taskId = await this.pending.upsert(merchantId, 'PENDING_PAYMENT_REVIEW', {
        orderId,
        reason: 'mono_required',
      })
      await this.generatePaymentToken(merchantId, taskId)
    }
    await this.notifyMerchantPaymentReview(merchantId, orderId, undefined, 'mono_required')
    await this.maybeSendMonoNudge(merchantId)
  }

  private async maybeSendMonoNudge(merchantId: string): Promise<void> {
    const merchant = await this.db.query.merchants.findFirst({
      where: eq(merchants.id, merchantId),
      columns: { phone: true, config: true },
    })
    if (!merchant) return

    const monoNudgeSentAt = (merchant.config as Record<string, unknown>)?.monoNudgeSentAt
    if (monoNudgeSentAt) return

    await this.nats.publish({
      subject: SUBJECTS.NOTIFICATION_SEND,
      merchantId,
      to: merchant.phone,
      channel: 'whatsapp',
      message: '',
      template: {
        name: 'mesa_mono_nudge',
        languageCode: 'en',
        bodyParams: [],
        buttons: [
          { type: 'quick_reply', index: 1, payload: 'mono_nudge_dismiss' },
        ],
      },
    } satisfies NotificationSendEvent)

    // Mark nudge sent so we don't resend
    await this.db.update(merchants)
      .set({
        config: {
          ...((merchant.config as Record<string, unknown>) ?? {}),
          monoNudgeSentAt: new Date().toISOString(),
        },
      })
      .where(eq(merchants.id, merchantId))
  }
}
