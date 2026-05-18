-- F-5: Block reuse of bank reference numbers across confirmed payments.
--
-- A merchant must never have two CONFIRMED payments with the same bank reference
-- — that pattern is the signature of a forged-screenshot replay. The partial
-- unique index enforces it at the DB layer; the application also checks across
-- merchants in a 72h window before auto-confirming.

CREATE UNIQUE INDEX IF NOT EXISTS payments_merchant_reference_unique_idx
  ON payments (merchant_id, reference)
  WHERE reference IS NOT NULL AND status = 'CONFIRMED';

-- Supporting index for the cross-merchant 72h dedup lookup.
CREATE INDEX IF NOT EXISTS payments_reference_created_at_idx
  ON payments (reference, created_at)
  WHERE reference IS NOT NULL;