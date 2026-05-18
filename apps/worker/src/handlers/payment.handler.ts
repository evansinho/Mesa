import { createHash } from 'crypto'
import type { Db } from '@mesa/db'
import { payments, orders, merchants } from '@mesa/db'
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
import type { PendingDecisions } from './pending-decisions'
import type { AiQuota, SubscriptionTier } from '../ai/quota'

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
        await this.pending.upsert(merchantId, 'PENDING_PAYMENT_REVIEW', {
          orderId,
          reason: 'amount_mismatch',
          received,
          expected,
        })
      }
      const notify: NotificationSendEvent = {
        subject: SUBJECTS.NOTIFICATION_SEND,
        merchantId,
        to: merchant.phone,
        channel: 'whatsapp' as const,
        message: `Payment amount mismatch for order ${orderId}. Received ₦${received}, expected ₦${expected}. Reply YES to confirm or NO to dispute.`,
      }
      await this.nats.publish(notify)
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
      await this.pending.upsert(merchantId, 'PENDING_PAYMENT_REVIEW', {
        orderId,
        reason: 'mono_failed',
      })
    }
    const notify: NotificationSendEvent = {
      subject: SUBJECTS.NOTIFICATION_SEND,
      merchantId,
      to: merchant.phone,
      channel: 'whatsapp',
      message: `Could not automatically verify payment for order ${orderId}. Please check your bank and reply YES to confirm or NO to dispute.`,
    }
    await this.nats.publish(notify)
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
        await this.pending.upsert(merchantId, 'PENDING_PAYMENT_REVIEW', {
          orderId,
          reason: 'low_confidence',
          screenshotUrl,
        })
      }
      const notify: NotificationSendEvent = {
        subject: SUBJECTS.NOTIFICATION_SEND,
        merchantId,
        to: merchant.phone,
        channel: 'whatsapp' as const,
        message: `Low confidence payment OCR for order ${orderId}. Reply YES to confirm or NO to dispute.`,
      }
      await this.nats.publish(notify)
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
      await this.pending.upsert(merchantId, 'PENDING_PAYMENT_REVIEW', {
        orderId,
        reason: 'reference_reused',
        reference,
        conflictingPaymentId,
      })
    }
    const notify: NotificationSendEvent = {
      subject: SUBJECTS.NOTIFICATION_SEND,
      merchantId,
      to: merchant.phone,
      channel: 'whatsapp',
      message: `Payment screenshot for order ${orderId} uses a reference (${reference}) we've already seen on a confirmed payment. This may be a duplicate or a forged screenshot. Verify with the customer and reply YES to confirm or NO to dispute.`,
    }
    await this.nats.publish(notify)
  }

  private async notifyMonoRequired(merchantId: string, orderId: string): Promise<void> {
    const merchant = await this.db.query.merchants.findFirst({
      where: eq(merchants.id, merchantId),
      columns: { phone: true },
    })
    if (!merchant) return
    if (this.pending) {
      await this.pending.upsert(merchantId, 'PENDING_PAYMENT_REVIEW', {
        orderId,
        reason: 'mono_required',
      })
    }
    const notify: NotificationSendEvent = {
      subject: SUBJECTS.NOTIFICATION_SEND,
      merchantId,
      to: merchant.phone,
      channel: 'whatsapp',
      message: `Payment for order ${orderId} needs manual review — Mono is not connected on your account. Reply YES to confirm or NO to dispute. To enable automatic confirmation, connect your bank via Mono in the dashboard.`,
    }
    await this.nats.publish(notify)
  }
}
