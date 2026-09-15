import type { FastifyInstance } from 'fastify'
import { sql } from 'drizzle-orm'
import { merchants, prospects, staff, type Db } from '@mesa/db'
import { and, eq, isNull } from 'drizzle-orm'
import { normalizePhone } from '@mesa/types'
import { isStaff, can, requirePermission } from '../permissions'
import { audit } from '../audit'
import { VERIFIED_PAYING, TIER_MRR_SQL } from '../revenue'

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
      CASE WHEN ${VERIFIED_PAYING} THEN 'paying' ELSE 'activated' END
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
  is_test_account: boolean
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
    isTestAccount: r.is_test_account,
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
        m.is_test_account,
        CASE WHEN ${VERIFIED_PAYING} THEN ${TIER_MRR_SQL} ELSE 0 END AS mrr,
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
      ORDER BY (CASE WHEN ${VERIFIED_PAYING} THEN ${TIER_MRR_SQL} ELSE 0 END) DESC,
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
        m.is_test_account,
        CASE WHEN ${VERIFIED_PAYING} THEN ${TIER_MRR_SQL} ELSE 0 END AS mrr,
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

  // POST /staff/merchants/:id/claim — take ownership of a merchant.
  //
  // Every merchant that signed up self-serve has no prospect row, because a
  // prospect is what a rep creates when they SOURCE someone. That left the
  // SIGNUP_UNOWNED queue item unresolvable: it says "Claim", and there was
  // nothing to claim — ownership lives on prospects.owner_id and there was no
  // prospect. The item would have sat open forever, which is precisely the
  // stale queue the auto-resolve design exists to prevent.
  //
  // So claiming creates the missing prospect. That is not a workaround: the
  // prospect row IS the attribution record, and a self-serve signup genuinely
  // is an unattributed account until someone takes it on.
  app.post<{ Params: { id: string } }>('/:id/claim', async (req, reply) => {
    if (!isStaff(req.auth)) return reply.status(401).send({ error: 'Unauthorized' })
    return assignMerchant(db, req, reply, req.auth.staffId)
  })

  // PATCH /staff/merchants/:id/owner — hand a merchant to someone.
  app.patch<{ Params: { id: string }; Body: { ownerId?: string | null } }>(
    '/:id/owner',
    { preHandler: requirePermission('prospect:assign') },
    async (req, reply) => {
      if (!isStaff(req.auth)) return reply.status(401).send({ error: 'Unauthorized' })

      const hasOwner = Object.prototype.hasOwnProperty.call(req.body ?? {}, 'ownerId')
      if (!hasOwner) return reply.status(400).send({ error: 'ownerId required (null to unassign)' })

      return assignMerchant(db, req, reply, req.body?.ownerId ?? null)
    },
  )

  // PATCH /staff/merchants/:id/test-account — flag a QA/reviewer/demo
  // account so it's excluded from the milestone count and MRR. Admin-only:
  // see merchant:mark-test in permissions.ts.
  app.patch<{ Params: { id: string }; Body: { isTestAccount?: boolean } }>(
    '/:id/test-account',
    { preHandler: requirePermission('merchant:mark-test') },
    async (req, reply) => {
      if (!isStaff(req.auth)) return reply.status(401).send({ error: 'Unauthorized' })

      const hasFlag = Object.prototype.hasOwnProperty.call(req.body ?? {}, 'isTestAccount')
      if (!hasFlag || typeof req.body?.isTestAccount !== 'boolean') {
        return reply.status(400).send({ error: 'isTestAccount (boolean) required' })
      }

      const [updated] = await db
        .update(merchants)
        .set({ isTestAccount: req.body.isTestAccount, updatedAt: new Date() })
        .where(eq(merchants.id, req.params.id))
        .returning()
      if (!updated) return reply.status(404).send({ error: 'Not found' })

      await audit(db, req.auth, 'merchant:mark-test', { type: 'merchant', id: updated.id }, {
        isTestAccount: req.body.isTestAccount,
      })

      return reply.send({ data: { id: updated.id, isTestAccount: updated.isTestAccount } })
    },
  )
}

/**
 * Point a merchant's attribution record at `ownerId`, creating that record if
 * the merchant arrived without one.
 */
async function assignMerchant(
  db: Db,
  req: { auth?: unknown; params: { id: string } },
  reply: { status: (c: number) => { send: (b: unknown) => unknown }; send: (b: unknown) => unknown },
  ownerId: string | null,
) {
  const auth = (req as { auth: Extract<ApiAuthLike, { kind: 'staff' }> }).auth

  if (ownerId !== null) {
    const target = await db.query.staff.findFirst({ where: eq(staff.id, ownerId) })
    if (!target) return reply.status(400).send({ error: 'No such staff member' })
    // Assigning to someone who cannot sign in strands the account: it looks
    // owned so nobody claims it, and the owner never sees the queue item.
    if (!target.active) return reply.status(400).send({ error: 'That staff member is deactivated' })
  }

  const merchant = await db.query.merchants.findFirst({ where: eq(merchants.id, req.params.id) })
  if (!merchant) return reply.status(404).send({ error: 'Not found' })

  const existing = await db.query.prospects.findFirst({
    where: eq(prospects.merchantId, merchant.id),
  })

  if (existing) {
    const [updated] = await db
      .update(prospects)
      .set({ ownerId, updatedAt: new Date() })
      .where(eq(prospects.id, existing.id))
      .returning()
    await audit(db, auth, 'merchant:assign', { type: 'merchant', id: merchant.id }, {
      from: existing.ownerId, to: ownerId, createdProspect: false,
    })
    return reply.send({ data: { merchantId: merchant.id, prospectId: updated.id, ownerId } })
  }

  const [created] = await db
    .insert(prospects)
    .values({
      businessName: merchant.name,
      phone: merchant.phone,
      phoneNormalized: normalizePhone(merchant.phone),
      // Deliberately organic. They arrived without attribution, and claiming an
      // account is not the same as having sourced it — recording this as a
      // rep's outbound win would quietly corrupt every channel report.
      source: 'organic',
      sourceDetail: 'self-serve signup, claimed later',
      ownerId,
      merchantId: merchant.id,
      // A human made this link, not the phone-matching sweep. Keeping that
      // distinction is what makes the auto-match rate meaningful.
      matchStatus: 'manual',
      matchedAt: new Date(),
      // Stage is frozen for a linked prospect anyway; DEMOED is the truthful
      // end of the human-owned ladder for someone who did convert.
      stage: 'DEMOED',
      createdAt: merchant.createdAt,
    })
    .returning()

  await audit(db, auth, 'merchant:assign', { type: 'merchant', id: merchant.id }, {
    from: null, to: ownerId, createdProspect: true,
  })

  return reply.send({ data: { merchantId: merchant.id, prospectId: created.id, ownerId } })
}

type ApiAuthLike = { kind: 'staff'; staffId: string; role: 'admin' | 'manager' | 'member' }
