import { sql } from 'drizzle-orm'
import { commercialRules } from '@mesa/config'
import { merchantLifecycleEvents, type Db } from '@mesa/db'
import {
  deriveLifecycleState,
  transitionTimestamp,
  type LifecycleState,
  type MerchantFacts,
} from './lifecycle'

// Order statuses that count as the merchant actually getting value.
//
// PENDING is excluded because a PENDING order is Mesa *detecting* something,
// not the merchant receiving it — orders default to PENDING. CANCELLED is
// excluded for the obvious reason. Getting this list wrong inflates every
// conversion number downstream, so it lives in one place.
const VALUE_STATUSES = sql`('CONFIRMED', 'AWAITING_PAYMENT', 'PAID', 'FULFILLED')`

// The product tables predate this one and store `timestamp` WITHOUT time zone
// (merchants.created_at, merchant_channels.connected_at, orders.created_at,
// payments.confirmed_at). Drizzle writes those as UTC wall-clock, but raw SQL
// reads a naive column back as LOCAL time — so reading one here, or comparing
// it against a tz-aware now(), skews it by the server's UTC offset. On a
// UTC+1 box that silently moved every derived timestamp an hour earlier.
//
// `AT TIME ZONE 'UTC'` reinterprets the stored wall-clock as the UTC instant
// it actually is, which is what drizzle wrote. Every legacy timestamp below
// goes through it; the tables this file writes to are timestamptz and need no
// such treatment.
const utc = (col: string) => sql.raw(`(${col} AT TIME ZONE 'UTC')`)

interface FactsRow extends Record<string, unknown> {
  merchant_id: string
  signed_up_at: Date
  subscription_status: MerchantFacts['subscriptionStatus']
  connected_at: Date | null
  first_value_at: Date | null
  first_payment_at: Date | null
  orders_activation_window: number
  orders_risk_window: number
  ever_activated: boolean
}

/**
 * Gather the derivation inputs for every merchant in one round trip.
 *
 * One query rather than N because the sweep runs every 15 minutes and this is
 * the only expensive thing it does.
 */
export async function gatherMerchantFacts(db: Db): Promise<MerchantFacts[]> {
  const { activation, risk } = commercialRules

  const rows = await db.execute<FactsRow>(sql`
    SELECT
      m.id                                        AS merchant_id,
      ${utc('m.created_at')}                      AS signed_up_at,
      m.subscription_status                       AS subscription_status,
      ch.connected_at                             AS connected_at,
      fv.first_value_at                           AS first_value_at,
      fp.first_payment_at                         AS first_payment_at,
      COALESCE(aw.cnt, 0)::int                    AS orders_activation_window,
      COALESCE(rw.cnt, 0)::int                    AS orders_risk_window,
      COALESCE(ea.ever, false)                    AS ever_activated
    FROM merchants m

    LEFT JOIN (
      SELECT merchant_id, MIN(connected_at AT TIME ZONE 'UTC') AS connected_at
      FROM merchant_channels
      WHERE status = 'connected'
      GROUP BY merchant_id
    ) ch ON ch.merchant_id = m.id

    -- First value uses the order's OWN created_at, not when its status flipped.
    -- "When did they get their first real order" is a question about when the
    -- order happened; updated_at moves every time anything touches the row.
    LEFT JOIN (
      SELECT merchant_id, MIN(created_at AT TIME ZONE 'UTC') AS first_value_at
      FROM orders
      WHERE status IN ${VALUE_STATUSES}
      GROUP BY merchant_id
    ) fv ON fv.merchant_id = m.id

    LEFT JOIN (
      SELECT merchant_id, MIN(confirmed_at AT TIME ZONE 'UTC') AS first_payment_at
      FROM payments
      WHERE status = 'CONFIRMED' AND confirmed_at IS NOT NULL
      GROUP BY merchant_id
    ) fp ON fp.merchant_id = m.id

    LEFT JOIN (
      SELECT merchant_id, COUNT(*) AS cnt
      FROM orders
      WHERE status IN ${VALUE_STATUSES}
        AND (created_at AT TIME ZONE 'UTC') >= now() - make_interval(days => ${activation.windowDays})
      GROUP BY merchant_id
    ) aw ON aw.merchant_id = m.id

    LEFT JOIN (
      SELECT merchant_id, COUNT(*) AS cnt
      FROM orders
      WHERE status IN ${VALUE_STATUSES}
        AND (created_at AT TIME ZONE 'UTC') >= now() - make_interval(days => ${risk.silentDays})
      GROUP BY merchant_id
    ) rw ON rw.merchant_id = m.id

    -- Has this merchant EVER satisfied the activation rule? A sliding-window
    -- check over their own order history rather than "do they have an ACTIVATED
    -- event", so the very first sweep still recognises merchants who were
    -- already habitual before this system existed.
    --
    -- Recomputed against the CURRENT rule on purpose: if the CCO changes the
    -- threshold, who counts as having-been-activated changes with it, which is
    -- what makes rule-versioned cohorts coherent.
    LEFT JOIN (
      SELECT o1.merchant_id, true AS ever
      FROM orders o1
      WHERE o1.status IN ${VALUE_STATUSES}
        AND (
          SELECT COUNT(*)
          FROM orders o2
          WHERE o2.merchant_id = o1.merchant_id
            AND o2.status IN ${VALUE_STATUSES}
            AND o2.created_at >= o1.created_at
            AND o2.created_at < o1.created_at + make_interval(days => ${activation.windowDays})
        ) >= ${activation.minOrders}
      GROUP BY o1.merchant_id
    ) ea ON ea.merchant_id = m.id
  `)

  return (rows.rows ?? []).map((r) => ({
    merchantId: r.merchant_id,
    signedUpAt: new Date(r.signed_up_at),
    subscriptionStatus: r.subscription_status,
    connectedAt: r.connected_at ? new Date(r.connected_at) : null,
    firstValueAt: r.first_value_at ? new Date(r.first_value_at) : null,
    firstPaymentAt: r.first_payment_at ? new Date(r.first_payment_at) : null,
    ordersInActivationWindow: Number(r.orders_activation_window),
    ordersInRiskWindow: Number(r.orders_risk_window),
    everActivated: Boolean(r.ever_activated),
  }))
}

/**
 * The latest recorded state per merchant.
 *
 * This is what makes the sweep idempotent — and why there is no unique index on
 * (merchant, state, version). Comparing against the latest state means an
 * unchanged merchant writes nothing, while a merchant genuinely re-entering a
 * state (AT_RISK → PAYING → AT_RISK) appends a new row, which a unique index
 * would have silently swallowed. Those cycles are the recovery-rate metric.
 */
export async function latestRecordedStates(db: Db): Promise<Map<string, LifecycleState>> {
  const rows = await db.execute<
    { merchant_id: string; to_state: LifecycleState } & Record<string, unknown>
  >(sql`
    SELECT DISTINCT ON (merchant_id) merchant_id, to_state
    FROM merchant_lifecycle_events
    ORDER BY merchant_id, occurred_at DESC, created_at DESC
  `)
  return new Map((rows.rows ?? []).map((r) => [r.merchant_id, r.to_state]))
}

export interface SweepResult {
  evaluated: number
  transitions: { merchantId: string; from: LifecycleState | null; to: LifecycleState }[]
}

/**
 * Evaluate every merchant and append any transitions.
 *
 * Safe to run repeatedly: a merchant whose derived state matches their latest
 * recorded state produces no write.
 */
export async function runLifecycleSweep(
  db: Db,
  now: Date = new Date(),
  detectedBy: 'sweep' | 'backfill' = 'sweep',
): Promise<SweepResult> {
  const [facts, latest] = await Promise.all([gatherMerchantFacts(db), latestRecordedStates(db)])

  const transitions: SweepResult['transitions'] = []
  const inserts: (typeof merchantLifecycleEvents.$inferInsert)[] = []

  for (const f of facts) {
    const derived = deriveLifecycleState(f)
    const previous = latest.get(f.merchantId) ?? null
    if (previous === derived) continue

    inserts.push({
      merchantId: f.merchantId,
      fromState: previous,
      toState: derived,
      occurredAt: transitionTimestamp(derived, f, now),
      ruleVersion: commercialRules.version,
      detectedBy,
    })
    transitions.push({ merchantId: f.merchantId, from: previous, to: derived })
  }

  if (inserts.length > 0) {
    await db.insert(merchantLifecycleEvents).values(inserts)
  }

  return { evaluated: facts.length, transitions }
}
