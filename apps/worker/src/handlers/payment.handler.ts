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

export class PaymentHandler {
  constructor(
    private db: Db,
    private nats: MesaNatsClient,
    private log: Pick<Console, 'info' | 'warn' | 'error'> = console,
    private eventStore?: {
      append: (aggregateId: string, aggregateType: string, eventType: string, payload: Record<string, unknown>) => Promise<void>
      appendOnce: (aggregateId: string, aggregateType: string, eventType: string, payload: Record<string, unknown>) => Promise<boolean>
    },
    private redis?: Redis
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

    // Run OCR
    const ocr = await extractPaymentDetails(screenshotUrl)

    // Fetch merchant Mono account ID
    const merchant = await this.db.query.merchants.findFirst({
      where: eq(merchants.id, merchantId),
    })
    const monoAccountId = (merchant?.config as Record<string, unknown>)?.monoAccountId as string | undefined

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
      // High confidence: auto-confirm
      const expectedTotal = parseFloat(order.total)
      const amountMatches = Math.abs(ocr.amount - expectedTotal) < 1 // allow ₦1 rounding

      if (amountMatches) {
        if (ocr.reference && monoAccountId) {
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
                reference: ocr.reference!,
                monoAccountId: monoAccountId!,
                amount: ocr.amount,
                attempt: 1,
              })
            }
            return
          }
        } else {
          await this.db
            .update(payments)
            .set({ status: 'CONFIRMED', confirmedAt: new Date() })
            .where(eq(payments.id, payment.id))
        }

        const confirmedEvent: PaymentConfirmedEvent = {
          subject: SUBJECTS.PAYMENT_CONFIRMED,
          orderId,
          merchantId,
          amount: ocr.amount,
          reference: ocr.reference,
        }
        await this.nats.publish(confirmedEvent)
        if (this.eventStore) {
          await this.eventStore.appendOnce(orderId, 'order', 'PAYMENT_CONFIRMED', {
            merchantId,
            amount: ocr.amount,
            reference: ocr.reference,
          })
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
      if (this.redis) {
        await this.redis.setex(
          `pending_payment_by_merchant:${merchantId}`,
          600,
          JSON.stringify({ orderId, received, expected })
        )
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
        await this.nats.publish(confirmedEvent)
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
    if (this.redis) {
      await this.redis.setex(`pending_payment_by_merchant:${merchantId}`, 600, JSON.stringify({ orderId }))
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
      if (this.redis) {
        await this.redis.setex(
          `pending_payment_by_merchant:${merchantId}`,
          600,
          JSON.stringify({ orderId })
        )
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
}
