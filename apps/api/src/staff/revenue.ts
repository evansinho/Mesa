import { sql } from 'drizzle-orm'

// Shared by every staff-facing revenue/milestone query (dashboard.ts,
// merchants.ts). Raw SQL fragments meant to be interpolated into a query
// where the merchants table is aliased `m` — see each call site.

// `merchants.subscription_status = 'active'` alone is not proof of a real
// payment: it's also what an internal support/testing change sets directly,
// with no Paystack event behind it (see apps/api/src/routes/webhooks.ts —
// a real charge.success always upserts a `subscriptions` row with a
// paystack_subscription_code in the same transaction it flips the status).
// A merchant only counts as genuinely paying here when both are true:
// the status says active AND a real Paystack subscription row backs it up.
// Also excludes anything staff have flagged as a test/QA/demo account.
export const VERIFIED_PAYING = sql`(
  m.subscription_status = 'active'
  AND NOT m.is_test_account
  AND EXISTS (
    SELECT 1 FROM subscriptions s
    WHERE s.merchant_id = m.id AND s.paystack_subscription_code IS NOT NULL
  )
)`

// Published pricing (getmesa.co), in naira per month. A raw SQL fragment —
// dashboard.ts also keeps its own plain-object TIER_MRR for summing tier
// counts already fetched into JS; this is the SQL-side equivalent for
// queries that compute MRR in-database.
export const TIER_MRR_SQL = sql`
  CASE m.subscription_tier
    WHEN 'starter'  THEN 12000
    WHEN 'growth'   THEN 35000
    WHEN 'business' THEN 90000
    ELSE 0
  END
`
