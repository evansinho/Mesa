import type { FastifyInstance } from 'fastify'
import { and, eq, isNull, sql } from 'drizzle-orm'
import { staffNotifications, type Db } from '@mesa/db'
import { isStaff } from '../permissions'

// Ordered by how much the item is costing you, not by recency. A merchant
// whose trial lapses tomorrow is worth more than one who went quiet last week,
// and a rep opening this at 8am should not have to work that out themselves.
// sql.raw with the query's own alias: interpolating the drizzle column here
// would render "staff_notifications"."kind", which does not resolve against a
// query that aliases the table as n.
const KIND_PRIORITY = sql.raw(`
  CASE n.kind
    WHEN 'ESCALATION'            THEN 0
    WHEN 'TRIAL_ENDING_NO_VALUE' THEN 1
    WHEN 'NOT_CONNECTED'         THEN 2
    WHEN 'PAST_DUE'              THEN 3
    WHEN 'AT_RISK'               THEN 4
    WHEN 'NO_FIRST_ORDER'        THEN 5
    WHEN 'SIGNUP_UNOWNED'        THEN 6
    WHEN 'PROSPECT_STALE'        THEN 7
    ELSE 8
  END
`)

// What a rep should actually do about each one. Kept server-side so the queue
// and the notification body can never drift apart, and so it stays one edit
// rather than one per client.
const ACTION_LABELS: Record<string, string> = {
  SIGNUP_UNOWNED: 'Claim',
  NOT_CONNECTED: 'Help connect',
  NO_FIRST_ORDER: 'Help get first order',
  TRIAL_ENDING_NO_VALUE: 'Rescue trial',
  AT_RISK: 'Re-engage',
  PAST_DUE: 'Billing follow-up',
  PROSPECT_STALE: 'Follow up',
  ESCALATION: 'Review',
}

interface QueueRow extends Record<string, unknown> {
  id: string
  kind: string
  tier: string
  body: string
  merchant_id: string | null
  prospect_id: string | null
  created_at: Date
  read_at: Date | null
  escalated_at: Date | null
  target_name: string | null
  days_open: number
}

export async function queueRoutes(app: FastifyInstance, db: Db): Promise<void> {
  // GET /staff/queue — everything open and assigned to me.
  app.get('/', async (req, reply) => {
    if (!isStaff(req.auth)) return reply.status(401).send({ error: 'Unauthorized' })

    const rows = await db.execute<QueueRow>(sql`
      SELECT
        n.id, n.kind::text AS kind, n.tier::text AS tier, n.body,
        n.merchant_id, n.prospect_id, n.created_at, n.read_at, n.escalated_at,
        COALESCE(m.name, p.business_name) AS target_name,
        floor(extract(epoch from (now() - n.created_at)) / 86400)::int AS days_open
      FROM staff_notifications n
      LEFT JOIN merchants m ON m.id = n.merchant_id
      LEFT JOIN prospects p ON p.id = n.prospect_id
      WHERE n.staff_id = ${req.auth.staffId}
        AND n.tier = 'action'
        AND n.resolved_at IS NULL
      ORDER BY ${KIND_PRIORITY}, n.created_at ASC
      LIMIT 100
    `)

    return reply.send({
      data: (rows.rows ?? []).map((r) => ({
        id: r.id,
        kind: r.kind,
        body: r.body,
        merchantId: r.merchant_id,
        prospectId: r.prospect_id,
        targetName: r.target_name,
        actionLabel: ACTION_LABELS[r.kind] ?? 'Review',
        daysOpen: Number(r.days_open),
        createdAt: r.created_at,
        readAt: r.read_at,
        escalated: r.escalated_at !== null,
      })),
    })
  })

  // GET /staff/queue/feed — the good news, deliberately separate.
  app.get('/feed', async (req, reply) => {
    if (!isStaff(req.auth)) return reply.status(401).send({ error: 'Unauthorized' })

    const rows = await db.execute<QueueRow>(sql`
      SELECT n.id, n.kind::text AS kind, n.body, n.merchant_id, n.created_at,
             m.name AS target_name
      FROM staff_notifications n
      LEFT JOIN merchants m ON m.id = n.merchant_id
      WHERE n.staff_id = ${req.auth.staffId} AND n.tier = 'feed'
      ORDER BY n.created_at DESC
      LIMIT 50
    `)

    return reply.send({
      data: (rows.rows ?? []).map((r) => ({
        id: r.id,
        kind: r.kind,
        body: r.body,
        merchantId: r.merchant_id,
        createdAt: r.created_at,
      })),
    })
  })

  // GET /staff/queue/count — the bell badge.
  app.get('/count', async (req, reply) => {
    if (!isStaff(req.auth)) return reply.status(401).send({ error: 'Unauthorized' })

    const [row] = await db
      .select({
        open: sql<number>`count(*)::int`,
        unread: sql<number>`count(*) filter (where ${staffNotifications.readAt} is null)::int`,
      })
      .from(staffNotifications)
      .where(
        and(
          eq(staffNotifications.staffId, req.auth.staffId),
          eq(staffNotifications.tier, 'action'),
          isNull(staffNotifications.resolvedAt),
        ),
      )

    return reply.send({ data: { open: row?.open ?? 0, unread: row?.unread ?? 0 } })
  })

  // POST /staff/queue/read — mark items seen.
  //
  // Read is not resolved. Only the sweep resolves an action item, and only
  // because the underlying condition stopped being true — a rep cannot dismiss
  // a merchant who still hasn't connected, which is the point.
  app.post<{ Body: { ids?: string[] } }>('/read', async (req, reply) => {
    if (!isStaff(req.auth)) return reply.status(401).send({ error: 'Unauthorized' })

    const ids = req.body?.ids
    if (!Array.isArray(ids) || ids.length === 0) {
      return reply.status(400).send({ error: 'ids required' })
    }

    await db.execute(sql`
      UPDATE staff_notifications
      SET read_at = now()
      WHERE staff_id = ${req.auth.staffId}
        AND read_at IS NULL
        AND id = ANY(${sql`ARRAY[${sql.join(ids.map((i) => sql`${i}::uuid`), sql`, `)}]`})
    `)

    return reply.send({ data: { ok: true } })
  })
}
