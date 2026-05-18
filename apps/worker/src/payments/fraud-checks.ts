import type { Db } from '@mesa/db'
import { payments } from '@mesa/db'
import { and, eq, gt, ne } from 'drizzle-orm'

export type FraudReason = 'reference_reused_self' | 'reference_reused_global'

export interface FraudCheckResult {
  ok: boolean
  reason?: FraudReason
  conflictingPaymentId?: string
  conflictingMerchantId?: string
}

const REFERENCE_DEDUP_WINDOW_MS = 72 * 60 * 60 * 1000

// Check whether the OCR-extracted bank reference has already been seen on a
// CONFIRMED payment within the last 72h. Catches the most common fraud pattern:
// a forged screenshot replays an old transfer's reference.
//
// Same-merchant reuse is also caught by the partial unique index at the DB
// layer (0013_payment_reference_dedup); this function catches it earlier and
// also catches cross-merchant reuse (which the DB index does not enforce).
export async function checkReference(
  db: Db,
  merchantId: string,
  reference: string,
  excludePaymentId?: string,
): Promise<FraudCheckResult> {
  if (!reference) return { ok: true }

  const cutoff = new Date(Date.now() - REFERENCE_DEDUP_WINDOW_MS)

  const clauses = [
    eq(payments.reference, reference),
    eq(payments.status, 'CONFIRMED'),
    gt(payments.createdAt, cutoff),
  ]
  if (excludePaymentId) clauses.push(ne(payments.id, excludePaymentId))

  const existing = await db.query.payments.findFirst({
    where: and(...clauses),
    columns: { id: true, merchantId: true },
  })

  if (!existing) return { ok: true }

  return {
    ok: false,
    reason: existing.merchantId === merchantId ? 'reference_reused_self' : 'reference_reused_global',
    conflictingPaymentId: existing.id,
    conflictingMerchantId: existing.merchantId,
  }
}
