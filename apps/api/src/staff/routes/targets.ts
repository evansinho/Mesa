import type { FastifyInstance } from 'fastify'
import { and, desc, eq } from 'drizzle-orm'
import { commercialTargets, type Db } from '@mesa/db'
import { isStaff, requirePermission } from '../permissions'
import { audit } from '../audit'

const METRIC = 'merchants_on_mesa'

export async function targetRoutes(app: FastifyInstance, db: Db): Promise<void> {
  // GET /staff/targets — the live target plus what it replaced.
  app.get('/', async (req, reply) => {
    if (!isStaff(req.auth)) return reply.status(401).send({ error: 'Unauthorized' })

    const rows = await db
      .select()
      .from(commercialTargets)
      .orderBy(desc(commercialTargets.createdAt))
      .limit(20)

    return reply.send({
      data: rows.map((r) => ({
        id: r.id,
        label: r.label,
        metric: r.metric,
        target: r.target,
        active: r.active,
        createdAt: r.createdAt,
      })),
    })
  })

  // POST /staff/targets — set the milestone.
  //
  // Admin only. The spec puts targets with the CCO: the Head of Sales owns
  // hitting the number, and someone owning a number they can also move is not
  // a target, it is a suggestion.
  app.post<{ Body: { label?: string; target?: number } }>(
    '/',
    { preHandler: requirePermission('rules:write') },
    async (req, reply) => {
      if (!isStaff(req.auth)) return reply.status(401).send({ error: 'Unauthorized' })

      const label = req.body?.label?.trim() || 'Milestone'
      const target = Number(req.body?.target)

      if (!Number.isInteger(target) || target < 1) {
        return reply.status(400).send({ error: 'target must be a whole number above zero' })
      }
      if (target > 1_000_000) {
        return reply.status(400).send({ error: 'target is implausibly large' })
      }

      // Supersede rather than edit: what the company was aiming at last
      // quarter stays on record, so a chart of past performance can still say
      // what "on plan" meant at the time.
      await db
        .update(commercialTargets)
        .set({ active: false })
        .where(and(eq(commercialTargets.metric, METRIC), eq(commercialTargets.active, true)))

      const [created] = await db
        .insert(commercialTargets)
        .values({ label, metric: METRIC, target, createdBy: req.auth.staffId })
        .returning()

      await audit(db, req.auth, 'target:set', { type: 'target', id: created.id }, { target, label })

      return reply.status(201).send({
        data: { id: created.id, label: created.label, target: created.target },
      })
    },
  )
}
