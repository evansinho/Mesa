import type { FastifyInstance } from 'fastify'
import { sql } from 'drizzle-orm'
import type { Db } from '@mesa/db'
import { isStaff, can } from '../permissions'
import { audit } from '../audit'

// Published pricing, in naira per month.
const TIER_MRR = sql`
  CASE m.subscription_tier
    WHEN 'starter'  THEN 12000
    WHEN 'growth'   THEN 35000
    WHEN 'business' THEN 90000
    ELSE 0
  END
`

const VALUE_STATUSES = sql`('CONFIRMED', 'AWAITING_PAYMENT', 'PAID', 'FULFILLED')`

/**
 * The handoff draws five columns; the lifecycle model derives eight states.
 * They are the same funnel at two resolutions, so the mapping lives here and
 * the client never re-derives it.
 *
 * AT_RISK is deliberately NOT a column. The handoff treats risk as a flag on a
 * card, which is the better model: a merchant at risk is still paying (or still
 * activated), and moving them to a "risk" column would lose where they actually
 * sit in the funnel. So it maps back to the stage they would otherwise occupy
 * and sets the risk signal instead.
 */
const DISPLAY_STAGE = sql`
  CASE
    WHEN l.to_state = 'CHURNED' THEN 'churned'
    WHEN l.to_state = 'PAYING'  THEN 'paying'
    WHEN l.to_state = 'AT_RISK' THEN
      CASE WHEN m.subscription_status = 'active' THEN 'paying' ELSE 'activated' END
    WHEN l.to_state IN ('FIRST_VALUE', 'FIRST_PAYMENT', 'ACTIVATED') THEN 'activated'
    WHEN l.to_state IN ('SIGNED_UP', 'CONNECTED') THEN 'onboarding'
    ELSE 'onboarding'
  END
`

interface Row extends Record<string, unknown> {
  id: string
  name: string
  phone: string
  display_stage: string
  lifecycle_state: string | null
  tier: string
  subscription_status: string
  mrr: number
  orders_30d: number
  activation_days: number | null
  connected_at: Date | null
  last_activity_at: Date | null
  owner_id: string | null
  owner_name: string | null
  prospect_id: string | null
  source: string | null
  source_detail: string | null
  risk: string | null
  created_at: Date
}

function shape(r: Row) {
  return {
    id: r.id,
    name: r.name,
    phone: r.phone,
    displayStage: r.display_stage,
    lifecycleState: r.lifecycle_state,
    tier: r.tier,
    subscriptionStatus: r.subscription_status,
    mrr: Number(r.mrr),
    orders30d: Number(r.orders_30d),
    activationDays: r.activation_days === null ? null : Number(r.activation_days),
    connectedAt: r.connected_at,
    lastActivityAt: r.last_activity_at,
    owner: r.owner_id ? { id: r.owner_id, name: r.owner_name } : null,
    prospectId: r.prospect_id,
    source: r.source,
    sourceDetail: r.source_detail,
    risk: r.risk,
    createdAt: r.created_at,
  }
}

export async function merchantRoutes(app: FastifyInstance, db: Db): Promise<void> {
  // GET /staff/merchants
  app.get<{ Querystring: { q?: string; stage?: string; rep?: string } }>('/', async (req, reply) => {
    if (!isStaff(req.auth)) return reply.status(401).send({ error: 'Unauthorized' })

    // A rep sees merchants that came from a prospect they own. Managers and
    // admins see the whole book, which is why this route needs the permission
    // and the dashboard's lifecycle section does too.
    const scope = can(req.auth.role, 'merchant:read:all')
      ? sql`true`
      : sql`p.owner_id = ${req.auth.staffId}`

    const search = req.query.q?.trim()
    const searchClause = search
      ? sql`AND (m.name ILIKE ${'%' + search + '%'} OR p.source_detail ILIKE ${'%' + search + '%'})`
      : sql``

    const rows = await db.execute<Row>(sql`
      SELECT
        m.id, m.name, m.phone,
        ${DISPLAY_STAGE} AS display_stage,
        l.to_state::text AS lifecycle_state,
        m.subscription_tier::text AS tier,
        m.subscription_status::text AS subscription_status,
        CASE WHEN m.subscription_status = 'active' THEN ${TIER_MRR} ELSE 0 END AS mrr,
        COALESCE(o30.cnt, 0)::int AS orders_30d,
        CASE WHEN fv.first_at IS NULL THEN NULL
             ELSE EXTRACT(day FROM fv.first_at - (m.created_at AT TIME ZONE 'UTC'))::int
        END AS activation_days,
        ch.connected_at,
        GREATEST(
          COALESCE(act.last_at, to_timestamp(0)),
          COALESCE(ord.last_at, to_timestamp(0))
        ) AS last_activity_at,
        p.owner_id, s.name AS owner_name,
        p.id AS prospect_id, p.source::text AS source, p.source_detail,
        -- The risk signal shown on a card. Read from the open action queue so
        -- the table, the kanban and the queue can never disagree about who is
        -- in trouble.
        (SELECT n.body FROM staff_notifications n
          WHERE n.merchant_id = m.id AND n.tier = 'action' AND n.resolved_at IS NULL
          ORDER BY n.created_at ASC LIMIT 1) AS risk,
        m.created_at

      FROM merchants m
      LEFT JOIN prospects p ON p.merchant_id = m.id
      LEFT JOIN staff s ON s.id = p.owner_id
      LEFT JOIN (
        SELECT DISTINCT ON (merchant_id) merchant_id, to_state
        FROM merchant_lifecycle_events
        ORDER BY merchant_id, occurred_at DESC, created_at DESC
      ) l ON l.merchant_id = m.id
      LEFT JOIN (
        SELECT merchant_id, MIN(connected_at AT TIME ZONE 'UTC') AS connected_at
        FROM merchant_channels WHERE status = 'connected' GROUP BY merchant_id
      ) ch ON ch.merchant_id = m.id
      LEFT JOIN (
        SELECT merchant_id, MIN(created_at AT TIME ZONE 'UTC') AS first_at
        FROM orders WHERE status IN ${VALUE_STATUSES} GROUP BY merchant_id
      ) fv ON fv.merchant_id = m.id
      LEFT JOIN (
        SELECT merchant_id, COUNT(*) AS cnt FROM orders
        WHERE status IN ${VALUE_STATUSES}
          AND (created_at AT TIME ZONE 'UTC') >= now() - interval '30 days'
        GROUP BY merchant_id
      ) o30 ON o30.merchant_id = m.id
      LEFT JOIN (
        SELECT merchant_id, MAX(created_at AT TIME ZONE 'UTC') AS last_at
        FROM orders GROUP BY merchant_id
      ) ord ON ord.merchant_id = m.id
      LEFT JOIN (
        SELECT pr.merchant_id, MAX(a.occurred_at) AS last_at
        FROM prospect_activities a
        JOIN prospects pr ON pr.id = a.prospect_id
        WHERE pr.merchant_id IS NOT NULL
        GROUP BY pr.merchant_id
      ) act ON act.merchant_id = m.id

      WHERE ${scope} ${searchClause}
      ORDER BY (CASE WHEN m.subscription_status = 'active' THEN ${TIER_MRR} ELSE 0 END) DESC,
               m.created_at DESC
      LIMIT 200
    `)

    return reply.send({ data: (rows.rows ?? []).map(shape) })
  })

  // GET /staff/merchants/:id — the record drawer.
  app.get<{ Params: { id: string } }>('/:id', async (req, reply) => {
    if (!isStaff(req.auth)) return reply.status(401).send({ error: 'Unauthorized' })

    const scope = can(req.auth.role, 'merchant:read:all')
      ? sql`true`
      : sql`p.owner_id = ${req.auth.staffId}`

    const rows = await db.execute<Row>(sql`
      SELECT
        m.id, m.name, m.phone,
        ${DISPLAY_STAGE} AS display_stage,
        l.to_state::text AS lifecycle_state,
        m.subscription_tier::text AS tier,
        m.subscription_status::text AS subscription_status,
        CASE WHEN m.subscription_status = 'active' THEN ${TIER_MRR} ELSE 0 END AS mrr,
        COALESCE(o30.cnt, 0)::int AS orders_30d,
        CASE WHEN fv.first_at IS NULL THEN NULL
             ELSE EXTRACT(day FROM fv.first_at - (m.created_at AT TIME ZONE 'UTC'))::int
        END AS activation_days,
        ch.connected_at,
        NULL::timestamptz AS last_activity_at,
        p.owner_id, s.name AS owner_name,
        p.id AS prospect_id, p.source::text AS source, p.source_detail,
        (SELECT n.body FROM staff_notifications n
          WHERE n.merchant_id = m.id AND n.tier = 'action' AND n.resolved_at IS NULL
          ORDER BY n.created_at ASC LIMIT 1) AS risk,
        m.created_at
      FROM merchants m
      LEFT JOIN prospects p ON p.merchant_id = m.id
      LEFT JOIN staff s ON s.id = p.owner_id
      LEFT JOIN (
        SELECT DISTINCT ON (merchant_id) merchant_id, to_state
        FROM merchant_lifecycle_events
        ORDER BY merchant_id, occurred_at DESC, created_at DESC
      ) l ON l.merchant_id = m.id
      LEFT JOIN (
        SELECT merchant_id, MIN(connected_at AT TIME ZONE 'UTC') AS connected_at
        FROM merchant_channels WHERE status = 'connected' GROUP BY merchant_id
      ) ch ON ch.merchant_id = m.id
      LEFT JOIN (
        SELECT merchant_id, MIN(created_at AT TIME ZONE 'UTC') AS first_at
        FROM orders WHERE status IN ${VALUE_STATUSES} GROUP BY merchant_id
      ) fv ON fv.merchant_id = m.id
      LEFT JOIN (
        SELECT merchant_id, COUNT(*) AS cnt FROM orders
        WHERE status IN ${VALUE_STATUSES}
          AND (created_at AT TIME ZONE 'UTC') >= now() - interval '30 days'
        GROUP BY merchant_id
      ) o30 ON o30.merchant_id = m.id
      WHERE m.id = ${req.params.id} AND ${scope}
      LIMIT 1
    `)

    const row = (rows.rows ?? [])[0]
    // Out of scope must be indistinguishable from nonexistent, or the endpoint
    // becomes an enumeration oracle over the whole merchant book.
    if (!row) return reply.status(404).send({ error: 'Not found' })

    // The lifecycle rail. Real transitions with real timestamps rather than a
    // checklist inferred from current state, so "when did they connect" has an
    // answer instead of a guess.
    const timeline = await db.execute<
      { to_state: string; occurred_at: Date; rule_version: number } & Record<string, unknown>
    >(sql`
      SELECT to_state::text AS to_state, occurred_at, rule_version
      FROM merchant_lifecycle_events
      WHERE merchant_id = ${req.params.id}
      ORDER BY occurred_at ASC, created_at ASC
    `)

    const activities = row.prospect_id
      ? await db.execute<
          { id: string; type: string; body: string; occurred_at: Date; staff_name: string | null } &
            Record<string, unknown>
        >(sql`
          SELECT a.id, a.type::text AS type, a.body, a.occurred_at, s.name AS staff_name
          FROM prospect_activities a
          LEFT JOIN staff s ON s.id = a.staff_id
          WHERE a.prospect_id = ${row.prospect_id}
          ORDER BY a.occurred_at DESC
          LIMIT 50
        `)
      : null

    // Opening a merchant record is a cross-tenant read by design, so it is
    // audited even though nothing was mutated.
    await audit(db, req.auth, 'merchant:read', { type: 'merchant', id: row.id })

    return reply.send({
      data: {
        ...shape(row),
        timeline: (timeline.rows ?? []).map((t) => ({
          state: t.to_state,
          occurredAt: t.occurred_at,
          ruleVersion: Number(t.rule_version),
        })),
        activities: (activities?.rows ?? []).map((a) => ({
          id: a.id,
          type: a.type,
          body: a.body,
          occurredAt: a.occurred_at,
          staffName: a.staff_name,
        })),
      },
    })
  })
}
