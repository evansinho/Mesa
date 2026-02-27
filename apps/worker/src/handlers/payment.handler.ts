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
            await this.db
              .update(payments)
              .set({ status: mono.status === 'reference_not_found' ? 'PENDING' : 'FAILED' })
              .where(eq(payments.id, payment.id))
            if (mono.status === 'reference_not_found') {
              // schedule retry in 5 minutes
              setTimeout(() => {
                this.handle({
                  subject: SUBJECTS.PAYMENT_SCREENSHOT_RECEIVED,
                  orderId,
                  merchantId,
                  screenshotUrl,
                  screenshotHash,
                }).catch(() => undefined)
              }, 5 * 60 * 1000)
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
