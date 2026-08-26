import { and, eq, inArray, isNull, sql } from 'drizzle-orm'
import { commercialRules } from '@mesa/config'
import { staffNotifications, type Db } from '@mesa/db'
import type { LifecycleState } from './lifecycle'

type Kind =
  | 'SIGNUP_UNOWNED'
  | 'NOT_CONNECTED'
  | 'NO_FIRST_ORDER'
  | 'TRIAL_ENDING_NO_VALUE'
  | 'AT_RISK'
  | 'PAST_DUE'
  | 'PROSPECT_STALE'
  | 'ESCALATION'
  | 'FIRST_VALUE'
  | 'ACTIVATED'
  | 'RECOVERED'

/** One notification that *should* be open right now. */
interface DesiredNotification {
  staffId: string
  merchantId: string | null
  prospectId: string | null
  body: string
}

interface Row extends Record<string, unknown> {
  staff_id: string
  merchant_id: string | null
  prospect_id: string | null
  body: string
}

// See sweep.ts — the product tables store naive timestamps that raw SQL reads
// back as local time, so every legacy column is reinterpreted as UTC.
const VALUE_STATUSES = sql`('CONFIRMED', 'AWAITING_PAYMENT', 'PAID', 'FULFILLED')`

/**
 * Recipients for a merchant-targeted notification.
 *
 * The owning rep if the merchant came from a prospect somebody owns; otherwise
 * every manager and admin, because an unowned merchant that notifies nobody is
 * precisely the merchant who never connects.
 */
const RECIPIENTS_FOR_MERCHANT = sql`
  COALESCE(
    (SELECT ARRAY[p.owner_id]
       FROM prospects p
      WHERE p.merchant_id = m.id AND p.owner_id IS NOT NULL
      LIMIT 1),
    (SELECT COALESCE(ARRAY_AGG(s.id), '{}')
       FROM staff s
      WHERE s.active AND s.role IN ('admin', 'manager'))
  )
`

/**
 * The action-tier triggers, each expressed as "who should have this open, and
 * why".
 *
 * Declarative on purpose. Because each trigger states its *desired* set rather
 * than an event, the reconciler below gets auto-resolve for free — a merchant
 * who connects on Wednesday simply stops appearing in NOT_CONNECTED's set, and
 * Tuesday's notification closes without anyone touching it. Writing eight
 * hand-rolled inverse conditions instead is how these systems end up full of
 * stale rows that everyone learns to ignore.
 */
function actionTriggers(): { kind: Kind; desired: (db: Db) => Promise<DesiredNotification[]> }[] {
  const { queue, risk } = commercialRules

  const run = async (db: Db, query: ReturnType<typeof sql>) => {
    const res = await db.execute<Row>(query)
    return (res.rows ?? []).map((r) => ({
      staffId: r.staff_id,
      merchantId: r.merchant_id,
      prospectId: r.prospect_id,
      body: r.body,
    }))
  }

  return [
    {
      // Signed up, nobody owns them. Push, never poll — this is what makes the
      // unowned pool safe rather than a synonym for "dropped".
      kind: 'SIGNUP_UNOWNED',
      desired: (db) =>
        run(db, sql`
          SELECT s.id AS staff_id, m.id AS merchant_id, NULL::uuid AS prospect_id,
                 m.name || ' signed up and has no owner' AS body
          FROM merchants m
          CROSS JOIN staff s
          WHERE s.active AND s.role IN ('admin', 'manager')
            AND m.subscription_status NOT IN ('expired', 'cancelled')
            AND NOT EXISTS (
              SELECT 1 FROM prospects p
              WHERE p.merchant_id = m.id AND p.owner_id IS NOT NULL
            )
        `),
    },

    {
      // The single highest-value list in the company: signed up, never
      // connected. Worth nothing until they do.
      kind: 'NOT_CONNECTED',
      desired: (db) =>
        run(db, sql`
          SELECT recipient AS staff_id, m.id AS merchant_id, NULL::uuid AS prospect_id,
                 m.name || ' signed up but has not connected WhatsApp' AS body
          FROM merchants m
          CROSS JOIN LATERAL unnest(${RECIPIENTS_FOR_MERCHANT}) AS recipient
          WHERE m.subscription_status NOT IN ('expired', 'cancelled')
            AND (m.created_at AT TIME ZONE 'UTC')
                < now() - make_interval(hours => ${queue.unconnectedAfterHours})
            AND NOT EXISTS (
              SELECT 1 FROM merchant_channels c
              WHERE c.merchant_id = m.id AND c.status = 'connected'
            )
        `),
    },

    {
      kind: 'NO_FIRST_ORDER',
      desired: (db) =>
        run(db, sql`
          SELECT recipient AS staff_id, m.id AS merchant_id, NULL::uuid AS prospect_id,
                 m.name || ' connected but has no orders yet' AS body
          FROM merchants m
          JOIN (
            SELECT merchant_id, MIN(connected_at AT TIME ZONE 'UTC') AS connected_at
            FROM merchant_channels WHERE status = 'connected' GROUP BY merchant_id
          ) ch ON ch.merchant_id = m.id
          CROSS JOIN LATERAL unnest(${RECIPIENTS_FOR_MERCHANT}) AS recipient
          WHERE m.subscription_status NOT IN ('expired', 'cancelled')
            AND ch.connected_at < now() - make_interval(days => ${queue.noFirstOrderAfterDays})
            AND NOT EXISTS (
              SELECT 1 FROM orders o
              WHERE o.merchant_id = m.id AND o.status IN ${VALUE_STATUSES}
            )
        `),
    },

    {
      // Trial about to end with nothing to show for it. The most time-boxed
      // item on the list, so it earns its own trigger rather than folding into
      // NO_FIRST_ORDER.
      kind: 'TRIAL_ENDING_NO_VALUE',
      desired: (db) =>
        run(db, sql`
          SELECT recipient AS staff_id, m.id AS merchant_id, NULL::uuid AS prospect_id,
                 m.name || '''s trial ends soon with no orders yet' AS body
          FROM merchants m
          CROSS JOIN LATERAL unnest(${RECIPIENTS_FOR_MERCHANT}) AS recipient
          WHERE m.subscription_status = 'trialing'
            AND m.trial_ends_at IS NOT NULL
            AND m.trial_ends_at <= now() + make_interval(days => ${queue.trialWarningDays})
            AND m.trial_ends_at > now()
            AND NOT EXISTS (
              SELECT 1 FROM orders o
              WHERE o.merchant_id = m.id AND o.status IN ${VALUE_STATUSES}
            )
        `),
    },

    {
      // Read off the derived lifecycle rather than recomputed, so the queue and
      // the funnel can never disagree about who is at risk.
      kind: 'AT_RISK',
      desired: (db) =>
        run(db, sql`
          SELECT recipient AS staff_id, m.id AS merchant_id, NULL::uuid AS prospect_id,
                 m.name || ' has gone quiet — no orders in '
                   || ${risk.silentDays}::text || ' days' AS body
          FROM merchants m
          JOIN (
            SELECT DISTINCT ON (merchant_id) merchant_id, to_state
            FROM merchant_lifecycle_events
            ORDER BY merchant_id, occurred_at DESC, created_at DESC
          ) l ON l.merchant_id = m.id AND l.to_state = 'AT_RISK'
          CROSS JOIN LATERAL unnest(${RECIPIENTS_FOR_MERCHANT}) AS recipient
        `),
    },

    {
      kind: 'PAST_DUE',
      desired: (db) =>
        run(db, sql`
          SELECT recipient AS staff_id, m.id AS merchant_id, NULL::uuid AS prospect_id,
                 m.name || ' is past due on billing' AS body
          FROM merchants m
          CROSS JOIN LATERAL unnest(${RECIPIENTS_FOR_MERCHANT}) AS recipient
          WHERE m.subscription_status = 'past_due'
        `),
    },

    {
      // Pre-signup neglect. Measured from the last logged touch, falling back
      // to creation — a prospect nobody ever contacted is stale from day one.
      kind: 'PROSPECT_STALE',
      desired: (db) =>
        run(db, sql`
          SELECT p.owner_id AS staff_id, NULL::uuid AS merchant_id, p.id AS prospect_id,
                 p.business_name || ' has had no activity logged' AS body
          FROM prospects p
          LEFT JOIN (
            SELECT prospect_id, MAX(occurred_at) AS last_at
            FROM prospect_activities GROUP BY prospect_id
          ) a ON a.prospect_id = p.id
          WHERE p.owner_id IS NOT NULL
            AND p.merchant_id IS NULL
            AND p.stage IN ('SOURCED', 'CONTACTED', 'DEMOED')
            AND COALESCE(a.last_at, p.created_at)
                < now() - make_interval(days => ${queue.escalateAfterDaysOfInaction})
        `),
    },
  ]
}

function keyOf(n: { merchantId: string | null; prospectId: string | null; staffId: string }) {
  return `${n.staffId}:${n.merchantId ?? ''}:${n.prospectId ?? ''}`
}

export interface ReconcileResult {
  opened: number
  resolved: number
}

/**
 * Bring the action-tier notifications in line with reality.
 *
 * Opens what should be open, resolves what should not. Both directions matter:
 * a system that only opens rows becomes a stale to-do list people mute, which
 * is worse than having no queue at all.
 */
export async function reconcileNotifications(db: Db): Promise<ReconcileResult> {
  let opened = 0
  let resolved = 0

  for (const trigger of actionTriggers()) {
    const desired = await trigger.desired(db)
    const desiredKeys = new Set(desired.map(keyOf))

    const open = await db
      .select({
        id: staffNotifications.id,
        staffId: staffNotifications.staffId,
        merchantId: staffNotifications.merchantId,
        prospectId: staffNotifications.prospectId,
      })
      .from(staffNotifications)
      .where(and(eq(staffNotifications.kind, trigger.kind), isNull(staffNotifications.resolvedAt)))

    const openKeys = new Set(open.map(keyOf))

    const toOpen = desired.filter((d) => !openKeys.has(keyOf(d)))
    if (toOpen.length > 0) {
      // onConflictDoNothing covers the partial unique indexes: if two workers
      // race, or a row was opened between the read above and this write, the
      // duplicate is dropped rather than blowing up the whole sweep.
      await db
        .insert(staffNotifications)
        .values(
          toOpen.map((d) => ({
            staffId: d.staffId,
            tier: 'action' as const,
            kind: trigger.kind,
            merchantId: d.merchantId,
            prospectId: d.prospectId,
            body: d.body,
          })),
        )
        .onConflictDoNothing()
      opened += toOpen.length
    }

    const toResolve = open.filter((o) => !desiredKeys.has(keyOf(o))).map((o) => o.id)
    if (toResolve.length > 0) {
      await db
        .update(staffNotifications)
        .set({ resolvedAt: new Date() })
        .where(inArray(staffNotifications.id, toResolve))
      resolved += toResolve.length
    }
  }

  return { opened, resolved }
}

const FEED_KINDS: Partial<Record<LifecycleState, { kind: Kind; body: string }>> = {
  FIRST_VALUE: { kind: 'FIRST_VALUE', body: 'got their first order through Mesa' },
  ACTIVATED: { kind: 'ACTIVATED', body: 'is now activated' },
}

/**
 * Emit feed-tier notifications for lifecycle transitions.
 *
 * Feed items are events, not conditions, so they are NOT reconciled — good news
 * doesn't stop being true. They are written already-resolved so they never
 * badge the bell: if celebrations badged it, the badge would stop meaning
 * "something needs doing" inside a week, and then it means nothing at all.
 *
 * Deduping comes free from the sweep: it only records a transition when the
 * derived state actually changes, so each transition fires here exactly once.
 */
export async function emitFeedNotifications(
  db: Db,
  transitions: { merchantId: string; from: LifecycleState | null; to: LifecycleState }[],
): Promise<number> {
  const relevant = transitions.filter((t) => {
    if (t.to === 'PAYING' && t.from === 'AT_RISK') return true
    return t.to in FEED_KINDS
  })
  if (relevant.length === 0) return 0

  const recipients = await db.execute<{ id: string } & Record<string, unknown>>(sql`
    SELECT id FROM staff WHERE active AND role IN ('admin', 'manager')
  `)
  const staffIds = (recipients.rows ?? []).map((r) => r.id)
  if (staffIds.length === 0) return 0

  const names = await db.execute<{ id: string; name: string } & Record<string, unknown>>(sql`
    SELECT id, name FROM merchants
    WHERE id = ANY(${sql`ARRAY[${sql.join(relevant.map((t) => sql`${t.merchantId}::uuid`), sql`, `)}]`})
  `)
  const nameById = new Map((names.rows ?? []).map((r) => [r.id, r.name]))

  const now = new Date()
  const values = relevant.flatMap((t) => {
    const spec =
      t.to === 'PAYING' && t.from === 'AT_RISK'
        ? { kind: 'RECOVERED' as Kind, body: 'is transacting again' }
        : FEED_KINDS[t.to]!
    const name = nameById.get(t.merchantId) ?? 'A merchant'
    return staffIds.map((staffId) => ({
      staffId,
      tier: 'feed' as const,
      kind: spec.kind,
      merchantId: t.merchantId,
      prospectId: null,
      body: `${name} ${spec.body}`,
      // Born resolved: visible in the feed, never badging the bell.
      resolvedAt: now,
    }))
  })

  await db.insert(staffNotifications).values(values).onConflictDoNothing()
  return values.length
}

/**
 * Escalate action items nobody has worked.
 *
 * The clock measures LOGGED ACTIVITY, not merchant outcome. A rep who called
 * twice and logged both calls never escalates even if the merchant still hasn't
 * moved; a rep who ignored the item does. Escalating on lack of outcome
 * punishes people for merchants who won't budge, and that is exactly how this
 * tool would turn into surveillance.
 *
 * Escalation raises a NEW notification addressed to admins. It never re-notifies
 * or nags the original owner.
 */
export async function escalateStaleNotifications(db: Db): Promise<number> {
  const { escalateAfterDaysOfInaction } = commercialRules.queue

  const res = await db.execute<Row & { source_id: string }>(sql`
    WITH stale AS (
      SELECT n.id AS source_id, n.staff_id, n.merchant_id, n.prospect_id, n.kind, n.body
      FROM staff_notifications n
      WHERE n.tier = 'action'
        AND n.resolved_at IS NULL
        AND n.escalated_at IS NULL
        AND n.kind <> 'ESCALATION'
        AND n.created_at < now() - make_interval(days => ${escalateAfterDaysOfInaction})
        -- Has the owner logged ANYTHING on this target in the window? Activity
        -- lives on prospects, so a merchant-targeted item looks through the
        -- prospect it came from.
        AND NOT EXISTS (
          SELECT 1
          FROM prospect_activities a
          JOIN prospects p ON p.id = a.prospect_id
          WHERE a.staff_id = n.staff_id
            AND a.occurred_at > now() - make_interval(days => ${escalateAfterDaysOfInaction})
            AND (
              (n.prospect_id IS NOT NULL AND p.id = n.prospect_id)
              OR (n.merchant_id IS NOT NULL AND p.merchant_id = n.merchant_id)
            )
        )
    )
    INSERT INTO staff_notifications (staff_id, tier, kind, merchant_id, prospect_id, body)
    SELECT admin.id, 'action', 'ESCALATION', stale.merchant_id, stale.prospect_id,
           'Unworked for ' || ${escalateAfterDaysOfInaction}::text || ' days: ' || stale.body
    FROM stale
    CROSS JOIN staff admin
    WHERE admin.active AND admin.role = 'admin' AND admin.id <> stale.staff_id
    ON CONFLICT DO NOTHING
    RETURNING staff_id, merchant_id, prospect_id, body
  `)

  const created = (res.rows ?? []).length

  if (created > 0) {
    // Mark the sources escalated so this fires once rather than every tick.
    await db.execute(sql`
      UPDATE staff_notifications n
      SET escalated_at = now()
      WHERE n.tier = 'action'
        AND n.resolved_at IS NULL
        AND n.escalated_at IS NULL
        AND n.kind <> 'ESCALATION'
        AND n.created_at < now() - make_interval(days => ${escalateAfterDaysOfInaction})
    `)
  }

  return created
}
