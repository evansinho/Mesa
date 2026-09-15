import type { FastifyInstance } from 'fastify'
import { and, eq, gte, isNull, sql, inArray } from 'drizzle-orm'
import { commercialTargets, merchants, prospects, prospectActivities, type Db } from '@mesa/db'
import { isStaff, can } from '../permissions'
import { prospectScope } from '../scope'
import { VERIFIED_PAYING, TIER_MRR_SQL } from '../revenue'

// Stages that are still live work. DISQUALIFIED and DORMANT are deliberate
// endings, not neglect, so they never appear in the attention list.
const OPEN_STAGES = ['SOURCED', 'CONTACTED', 'DEMOED'] as const

// Display order for the derived lifecycle. The two exits sit at the end
// rather than in ladder position — they are outcomes, not further progress.
const LIFECYCLE_ORDER = [
  'SIGNED_UP',
  'CONNECTED',
  'FIRST_VALUE',
  'FIRST_PAYMENT',
  'ACTIVATED',
  'PAYING',
  'AT_RISK',
  'CHURNED',
] as const

// Published pricing (getmesa.co), in naira per month. MRR is derived from the
// tier a merchant is actually on rather than stored, so it cannot drift from
// the subscription record.
const TIER_MRR: Record<string, number> = {
  starter: 12_000,
  growth: 35_000,
  business: 90_000,
}

// Fallback only, for a database with no target row yet. The real value lives
// in commercial_targets so the CCO can change it without a deploy.
const DEFAULT_MILESTONE_TARGET = 50

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

    // Post-signup lifecycle, read from the derived transition log rather than
    // recomputed here — so the funnel and the work queue can never disagree
    // about who is at risk. Only managers and admins see it: it spans every
    // merchant, not just the caller's own.
    const lifecycle = can(req.auth.role, 'merchant:read:all')
      ? (
          await db.execute<{ to_state: string; count: number } & Record<string, unknown>>(sql`
            SELECT latest.to_state::text AS to_state, count(*)::int AS count
            FROM (
              SELECT DISTINCT ON (merchant_id) merchant_id, to_state
              FROM merchant_lifecycle_events
              ORDER BY merchant_id, occurred_at DESC, created_at DESC
            ) latest
            GROUP BY latest.to_state
          `)
        ).rows ?? []
      : null

    // Revenue and the team table span every merchant, so they are manager-only
    // for the same reason the lifecycle section is.
    const wide = can(req.auth.role, 'merchant:read:all')

    const [revenue, trend, leaderboard] = wide
      ? await Promise.all([
          db.execute<{ tier: string; count: number } & Record<string, unknown>>(sql`
            SELECT subscription_tier::text AS tier, count(*)::int AS count
            FROM merchants m
            WHERE ${VERIFIED_PAYING}
            GROUP BY subscription_tier
          `),

          // Cumulative merchants on Mesa by month. Read from merchants rather
          // than the lifecycle log so the series still exists before the first
          // sweep has run. Excludes test accounts — a QA/reviewer signup
          // shouldn't inflate a growth trend any more than the milestone.
          db.execute<{ month: string; cumulative: number } & Record<string, unknown>>(sql`
            WITH months AS (
              SELECT generate_series(
                date_trunc('month', now()) - interval '5 months',
                date_trunc('month', now()),
                interval '1 month'
              ) AS m
            )
            SELECT to_char(months.m, 'Mon') AS month,
                   (SELECT count(*)::int FROM merchants
                     WHERE NOT is_test_account
                       AND (created_at AT TIME ZONE 'UTC') < months.m + interval '1 month') AS cumulative
            FROM months
            ORDER BY months.m
          `),

          // Attributed through the prospect that produced each merchant, which
          // is the only honest link between a rep and a signup.
          db.execute<{
            staff_id: string
            name: string
            role: string
            on_mesa: number
            pipeline: number
            mrr: number
          } & Record<string, unknown>>(sql`
            SELECT s.id AS staff_id, s.name, s.role::text AS role,
                   count(p.merchant_id)::int AS on_mesa,
                   count(*) FILTER (
                     WHERE p.merchant_id IS NULL
                       AND p.stage IN ('SOURCED', 'CONTACTED', 'DEMOED')
                   )::int AS pipeline,
                   COALESCE(SUM(CASE WHEN ${VERIFIED_PAYING} THEN ${TIER_MRR_SQL} ELSE 0 END), 0)::int AS mrr
            FROM staff s
            LEFT JOIN prospects p ON p.owner_id = s.id
            LEFT JOIN merchants m ON m.id = p.merchant_id
            WHERE s.active
            GROUP BY s.id, s.name, s.role
            ORDER BY mrr DESC, on_mesa DESC
          `),
        ])
      : [null, null, null]

    // The milestone is a COMPANY target, so its progress is deliberately NOT
    // scoped to the caller. A rep being shown "8% of the Q4 milestone" off
    // their own four accounts, while their manager sees 16% off the company's
    // eight, is not a smaller view of the same number — it is a different and
    // wrong claim about where the company stands.
    const [targetRow, companyOnMesa] = await Promise.all([
      db
        .select({ label: commercialTargets.label, target: commercialTargets.target })
        .from(commercialTargets)
        .where(
          and(
            eq(commercialTargets.metric, 'merchants_on_mesa'),
            eq(commercialTargets.active, true),
          ),
        )
        .limit(1),
      db.select({ count: sql<number>`count(*)::int` })
        .from(merchants)
        .where(eq(merchants.isTestAccount, false)),
    ])

    const milestone = {
      label: targetRow[0]?.label ?? 'Milestone',
      target: targetRow[0]?.target ?? DEFAULT_MILESTONE_TARGET,
      actual: companyOnMesa[0]?.count ?? 0,
    }

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
        milestone,
        mrr: revenue
          ? (revenue.rows ?? []).reduce(
              (total, r) => total + (TIER_MRR[r.tier] ?? 0) * Number(r.count),
              0,
            )
          : null,
        // Actual against a straight-line ramp to the milestone. "Plan" here is
        // the target spread evenly, not a forecast — labelled as such in the
        // chart legend so nobody reads it as a projection.
        trend: trend
          ? {
              months: (trend.rows ?? []).map((r) => r.month.trim()),
              actual: (trend.rows ?? []).map((r) => Number(r.cumulative)),
              plan: (trend.rows ?? []).map((_, i, arr) =>
                Math.round((milestone.target / arr.length) * (i + 1)),
              ),
            }
          : null,
        leaderboard: leaderboard
          ? (leaderboard.rows ?? []).map((r) => ({
              staffId: r.staff_id,
              name: r.name,
              role: r.role,
              onMesa: Number(r.on_mesa),
              pipeline: Number(r.pipeline),
              mrr: Number(r.mrr),
            }))
          : null,
        // The derived half. Null for reps, who only see their own records.
        lifecycle: lifecycle
          ? LIFECYCLE_ORDER.map((state) => ({
              state,
              count: Number(lifecycle.find((r) => r.to_state === state)?.count ?? 0),
            }))
          : null,
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
