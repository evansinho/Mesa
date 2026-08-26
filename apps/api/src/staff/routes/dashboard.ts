import type { FastifyInstance } from 'fastify'
import { and, eq, gte, isNull, sql, inArray } from 'drizzle-orm'
import { prospects, prospectActivities, type Db } from '@mesa/db'
import { isStaff } from '../permissions'
import { prospectScope } from '../scope'

// Stages that are still live work. DISQUALIFIED and DORMANT are deliberate
// endings, not neglect, so they never appear in the attention list.
const OPEN_STAGES = ['SOURCED', 'CONTACTED', 'DEMOED'] as const

const WARNING_DAYS = 3
const CRITICAL_DAYS = 7

export async function dashboardRoutes(app: FastifyInstance, db: Db): Promise<void> {
  // GET /staff/dashboard
  app.get('/', async (req, reply) => {
    if (!isStaff(req.auth)) return reply.status(401).send({ error: 'Unauthorized' })

    const scope = prospectScope(req.auth)
    const weekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000)
    const twoWeeksAgo = new Date(Date.now() - 14 * 24 * 60 * 60 * 1000)

    // Last touch per prospect: the most recent logged activity, falling back to
    // when the record was created. A prospect nobody has ever contacted is as
    // stale as one nobody has contacted lately — arguably more.
    const lastTouch = db
      .select({
        prospectId: prospectActivities.prospectId,
        lastAt: sql<string>`max(${prospectActivities.occurredAt})`.as('last_at'),
      })
      .from(prospectActivities)
      .groupBy(prospectActivities.prospectId)
      .as('last_touch')

    const [byStage, onMesa, newThisWeek, activityCount, bySource, stale, prevWeek] =
      await Promise.all([
      // Funnel — human-owned stages only.
      db
        .select({ stage: prospects.stage, count: sql<number>`count(*)::int` })
        .from(prospects)
        .where(and(scope, isNull(prospects.merchantId)))
        .groupBy(prospects.stage),

      // Signed up. Counted separately because it is not a stage — it is the
      // point where Mesa takes over from the sales team.
      db
        .select({ count: sql<number>`count(*)::int` })
        .from(prospects)
        .where(and(scope, sql`${prospects.merchantId} is not null`)),

      db
        .select({ count: sql<number>`count(*)::int` })
        .from(prospects)
        .where(and(scope, gte(prospects.createdAt, weekAgo))),

      db
        .select({ count: sql<number>`count(*)::int` })
        .from(prospectActivities)
        .innerJoin(prospects, eq(prospects.id, prospectActivities.prospectId))
        .where(and(scope, gte(prospectActivities.occurredAt, weekAgo))),

      // Source performance measured in signups, not leads. "Which channel
      // produces merchants" is the question the CCO actually has; "which
      // produces leads" is the one that flatters everybody.
      db
        .select({
          source: prospects.source,
          total: sql<number>`count(*)::int`,
          signedUp: sql<number>`count(${prospects.merchantId})::int`,
        })
        .from(prospects)
        .where(scope)
        .groupBy(prospects.source)
        .orderBy(sql`count(*) desc`),

      // The work queue, as far as it can honestly be built before the lifecycle
      // sweep exists: open prospects ordered by how long they have been quiet.
      // Post-signup signals ("connected but no first order") need the sweep.
      db
        .select({
          id: prospects.id,
          businessName: prospects.businessName,
          stage: prospects.stage,
          source: prospects.source,
          ownerId: prospects.ownerId,
          lastTouchAt: sql<string>`coalesce(${lastTouch.lastAt}, ${prospects.createdAt})`,
          daysQuiet: sql<number>`
            floor(
              extract(epoch from (now() - coalesce(${lastTouch.lastAt}, ${prospects.createdAt})))
              / 86400
            )::int
          `,
        })
        .from(prospects)
        .leftJoin(lastTouch, eq(lastTouch.prospectId, prospects.id))
        .where(
          and(
            scope,
            isNull(prospects.merchantId),
            inArray(prospects.stage, [...OPEN_STAGES]),
            sql`coalesce(${lastTouch.lastAt}, ${prospects.createdAt}) < now() - make_interval(days => ${WARNING_DAYS})`,
          ),
        )
        .orderBy(sql`coalesce(${lastTouch.lastAt}, ${prospects.createdAt}) asc`)
        .limit(20),

      // The previous seven days, so a delta is a real comparison rather than a
      // decorative arrow. Reported as an absolute count, never a percentage —
      // "+40% week on week" on a base of five is two prospects and a holiday.
      db
        .select({
          created: sql<number>`count(*) filter (
            where ${prospects.createdAt} >= ${twoWeeksAgo} and ${prospects.createdAt} < ${weekAgo}
          )::int`,
        })
        .from(prospects)
        .where(scope),
    ])

    const stageCount = (stage: string) => byStage.find((r) => r.stage === stage)?.count ?? 0
    const signedUp = onMesa[0]?.count ?? 0

    const funnel = [
      { key: 'SOURCED', label: 'Sourced', count: stageCount('SOURCED') },
      { key: 'CONTACTED', label: 'Contacted', count: stageCount('CONTACTED') },
      { key: 'DEMOED', label: 'Demoed', count: stageCount('DEMOED') },
      { key: 'ON_MESA', label: 'On Mesa', count: signedUp },
    ]

    return reply.send({
      data: {
        kpis: {
          open: stageCount('SOURCED') + stageCount('CONTACTED') + stageCount('DEMOED'),
          signedUp,
          newThisWeek: newThisWeek[0]?.count ?? 0,
          newLastWeek: prevWeek[0]?.created ?? 0,
          activitiesThisWeek: activityCount[0]?.count ?? 0,
          needsAttention: stale.length,
        },
        funnel,
        // Raw counts only — never a bare percentage. At this volume a "22%
        // drop" is two merchants and a public holiday, so the UI renders
        // fractions and the denominator is always visible (spec §8).
        bySource,
        needsAttention: stale.map((p) => ({
          ...p,
          severity: p.daysQuiet >= CRITICAL_DAYS ? 'critical' : 'warning',
        })),
        thresholds: { warningDays: WARNING_DAYS, criticalDays: CRITICAL_DAYS },
      },
    })
  })
}
