import { createHash } from 'crypto'
import type { Db } from '@mesa/db'
import { payments, orders } from '@mesa/db'
import type { MesaNatsClient } from '@mesa/nats'
import {
  PaymentScreenshotReceivedEvent,
  PaymentConfirmedEvent,
  NotificationSendEvent,
  SUBJECTS,
} from '@mesa/types'
import { extractPaymentDetails, OCR_CONFIDENCE_THRESHOLD } from '@mesa/ai'
import { eq } from 'drizzle-orm'

export class PaymentHandler {
  constructor(
    private db: Db,
    private nats: MesaNatsClient
  ) {}

  async handle(event: PaymentScreenshotReceivedEvent): Promise<void> {
    const { orderId, merchantId, screenshotUrl, screenshotHash } = event

    // Idempotency check — has this screenshot already been processed?
    const duplicate = await this.db.query.payments.findFirst({
      where: eq(payments.screenshotHash, screenshotHash),
    })
    if (duplicate) {
      console.log(`Duplicate screenshot skipped: ${screenshotHash}`)
      return
    }

    // Fetch the order to get expected amount
    const order = await this.db.query.orders.findFirst({
      where: eq(orders.id, orderId),
    })
    if (!order) {
      console.error(`Order not found: ${orderId}`)
      return
    }

    // Run OCR
    const ocr = await extractPaymentDetails(screenshotUrl)

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
        rawOcrData: ocr as Record<string, unknown>,
        status: 'PENDING',
      })
      .returning({ id: payments.id })

    if (ocr.confidence >= OCR_CONFIDENCE_THRESHOLD && ocr.amount) {
      // High confidence: auto-confirm
      const expectedTotal = parseFloat(order.total)
      const amountMatches = Math.abs(ocr.amount - expectedTotal) < 1 // allow ₦1 rounding

      if (amountMatches) {
        await this.db
          .update(payments)
          .set({ status: 'CONFIRMED', confirmedAt: new Date() })
          .where(eq(payments.id, payment.id))

        const confirmedEvent: PaymentConfirmedEvent = {
          subject: SUBJECTS.PAYMENT_CONFIRMED,
          orderId,
          merchantId,
          amount: ocr.amount,
          reference: ocr.reference,
        }
        await this.nats.publish(confirmedEvent)

        console.log(`Payment auto-confirmed for order ${orderId}: ₦${ocr.amount}`)
      } else {
        // Amount mismatch — notify merchant
        await this.notifyMerchantMismatch(merchantId, orderId, ocr.amount, expectedTotal)
      }
    } else {
      // Low confidence — flag for manual review
      await this.notifyMerchantLowConfidence(merchantId, orderId, screenshotUrl)
      console.log(`Payment flagged for manual review: order ${orderId}, confidence ${ocr.confidence}`)
    }
  }

  private async notifyMerchantMismatch(
    merchantId: string,
    orderId: string,
    received: number,
    expected: number
  ): Promise<void> {
    // TODO: look up merchant WhatsApp number and send message
    console.warn(`Amount mismatch on order ${orderId}: received ₦${received}, expected ₦${expected}`)
  }

  private async notifyMerchantLowConfidence(
    merchantId: string,
    orderId: string,
    screenshotUrl: string
  ): Promise<void> {
    // TODO: send WhatsApp message to merchant requesting manual confirmation
    console.warn(`Low confidence OCR for order ${orderId} — manual review needed`)
  }
}