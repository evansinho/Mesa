-- Mono transaction-reuse guard.
--
-- When Mono can't match a payment reference in the transaction narration
-- (e.g. OPay wallet deposits are always narrated literally "Bank Deposit",
-- with no reference embedded at all), mono.ts falls back to matching by
-- amount within a time window. That fallback alone would let two different
-- orders of the same amount both get confirmed against the same real bank
-- transaction. This column + partial unique index makes that impossible:
-- once a real Mono transaction id has confirmed one payment, no other
-- payment row can be confirmed against it again.

ALTER TABLE "payments" ADD COLUMN IF NOT EXISTS "mono_transaction_id" text;

CREATE UNIQUE INDEX IF NOT EXISTS payments_mono_transaction_unique_idx
  ON payments (mono_transaction_id)
  WHERE mono_transaction_id IS NOT NULL;
