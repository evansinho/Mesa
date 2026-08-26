import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { and, desc, eq, sql } from 'drizzle-orm'
import { normalizePhone } from '@mesa/types'
import { prospects, prospectActivities, staff, type Db } from '@mesa/db'
import { isStaff, requirePermission, can } from '../permissions'
import { prospectScope, canMutateProspect } from '../scope'
import { audit } from '../audit'

const SOURCES = [
  'outbound', 'referral', 'instagram', 'whatsapp',
  'partnership', 'event', 'organic', 'inbound',
] as const
type Source = (typeof SOURCES)[number]

const STAGES = ['SOURCED', 'CONTACTED', 'DEMOED', 'DORMANT'] as const
type Stage = (typeof STAGES)[number]

const DISQUALIFY_REASONS = [
  'NOT_A_SELLER', 'NO_WHATSAPP_ORDERS', 'TOO_LARGE', 'PRICE',
  'NO_RESPONSE', 'DUPLICATE', 'COMPETITOR', 'OTHER',
] as const
type DisqualifyReason = (typeof DISQUALIFY_REASONS)[number]

const ACTIVITY_TYPES = ['note', 'call', 'whatsapp', 'demo', 'meeting'] as const
type ActivityType = (typeof ACTIVITY_TYPES)[number]

export async function prospectRoutes(app: FastifyInstance, db: Db): Promise<void> {
  // GET /staff/prospects
  app.get<{ Querystring: { page?: string; limit?: string; stage?: string } }>(
    '/',
    async (req, reply) => {
      if (!isStaff(req.auth)) return reply.status(401).send({ error: 'Unauthorized' })

      const page = Math.max(1, Number(req.query.page) || 1)
      const limit = Math.min(100, Math.max(1, Number(req.query.limit) || 25))
      const stageFilter = STAGES.includes(req.query.stage as Stage)
        ? eq(prospects.stage, req.query.stage as Stage)
        : undefined

      const where = and(prospectScope(req.auth), stageFilter)

      // The owner is joined here, not just on the detail route. Without it the
      // list can only show an ownerId, so every row reads "Unclaimed" whatever
      // the truth is — and who owns a prospect is one of the four things the
      // list exists to show.
      const [rows, [{ count }]] = await Promise.all([
        db
          .select({
            prospect: prospects,
            ownerName: staff.name,
          })
          .from(prospects)
          .leftJoin(staff, eq(prospects.ownerId, staff.id))
          .where(where)
          .orderBy(desc(prospects.updatedAt))
          .limit(limit)
          .offset((page - 1) * limit),
        db.select({ count: sql<number>`count(*)::int` }).from(prospects).where(where),
      ])

      return reply.send({
        data: rows.map((r) => ({
          ...r.prospect,
          owner: r.prospect.ownerId ? { id: r.prospect.ownerId, name: r.ownerName } : null,
        })),
        meta: { page, limit, total: count, pages: Math.ceil(count / limit) },
      })
    },
  )

  // POST /staff/prospects
  app.post<{
    Body: {
      businessName?: string
      phone?: string
      source?: string
      sourceDetail?: string
      instagramHandle?: string
      contactName?: string
      ownerId?: string
    }
  }>('/', { preHandler: requirePermission('prospect:write') }, async (req, reply) => {
    if (!isStaff(req.auth)) return reply.status(401).send({ error: 'Unauthorized' })

    const { businessName, phone, source, sourceDetail, instagramHandle, contactName } =
      req.body ?? {}

    if (!businessName?.trim()) return reply.status(400).send({ error: 'businessName required' })
    if (!phone?.trim()) return reply.status(400).send({ error: 'phone required' })
    if (!source || !SOURCES.includes(source as Source)) {
      return reply.status(400).send({ error: `source must be one of: ${SOURCES.join(', ')}` })
    }

    // Only someone who can assign may create a prospect owned by anyone else.
    const requestedOwner = req.body?.ownerId
    const ownerId =
      requestedOwner && can(req.auth.role, 'prospect:assign')
        ? requestedOwner
        : req.auth.staffId

    const [created] = await db
      .insert(prospects)
      .values({
        businessName: businessName.trim(),
        phone: phone.trim(),
        phoneNormalized: normalizePhone(phone),
        instagramHandle: instagramHandle?.trim() || null,
        contactName: contactName?.trim() || null,
        source: source as Source,
        sourceDetail: sourceDetail?.trim() || null,
        ownerId,
      })
      .returning()

    await audit(db, req.auth, 'prospect:create', { type: 'prospect', id: created.id }, {
      source, ownerId,
    })

    return reply.status(201).send({ data: created })
  })

  // GET /staff/prospects/:id
  app.get<{ Params: { id: string } }>('/:id', async (req, reply) => {
    if (!isStaff(req.auth)) return reply.status(401).send({ error: 'Unauthorized' })

    // Scope is applied in the WHERE clause, not checked after the fetch — an
    // out-of-scope prospect must be indistinguishable from a nonexistent one.
    const [row] = await db
      .select()
      .from(prospects)
      .where(and(eq(prospects.id, req.params.id), prospectScope(req.auth)))
      .limit(1)

    if (!row) return reply.status(404).send({ error: 'Not found' })

    const owner = row.ownerId
      ? await db.query.staff.findFirst({ where: eq(staff.id, row.ownerId) })
      : null

    return reply.send({
      data: {
        ...row,
        owner: owner ? { id: owner.id, name: owner.name } : null,
      },
    })
  })

  // PATCH /staff/prospects/:id — stage and contact details.
  app.patch<{
    Params: { id: string }
    Body: {
      stage?: string
      businessName?: string
      instagramHandle?: string
      contactName?: string
      source?: string
      sourceDetail?: string
    }
  }>('/:id', { preHandler: requirePermission('prospect:write') }, async (req, reply) => {
    if (!isStaff(req.auth)) return reply.status(401).send({ error: 'Unauthorized' })

    // Attribution is immutable. Attribution that can be edited once the
    // outcome is known is not attribution — it is a rep tidying their numbers.
    if (req.body?.source !== undefined || req.body?.sourceDetail !== undefined) {
      return reply.status(400).send({ error: 'source and sourceDetail are immutable' })
    }

    const existing = await requireVisibleProspect(db, req, reply)
    if (!existing) return

    if (existing.merchantId) {
      // Once a merchant exists the sales stage is frozen: everything after
      // signup is derived from product data and must not be hand-edited.
      if (req.body?.stage !== undefined) {
        return reply
          .status(409)
          .send({ error: 'stage is frozen once the prospect is linked to a merchant' })
      }
    }

    if (req.body?.stage !== undefined && !STAGES.includes(req.body.stage as Stage)) {
      return reply
        .status(400)
        .send({ error: `stage must be one of: ${STAGES.join(', ')} (use /disqualify to disqualify)` })
    }

    const [updated] = await db
      .update(prospects)
      .set({
        ...(req.body?.stage !== undefined ? { stage: req.body.stage as Stage } : {}),
        ...(req.body?.businessName !== undefined
          ? { businessName: req.body.businessName.trim() }
          : {}),
        ...(req.body?.instagramHandle !== undefined
          ? { instagramHandle: req.body.instagramHandle?.trim() || null }
          : {}),
        ...(req.body?.contactName !== undefined
          ? { contactName: req.body.contactName?.trim() || null }
          : {}),
        updatedAt: new Date(),
      })
      .where(eq(prospects.id, existing.id))
      .returning()

    await audit(db, req.auth, 'prospect:update', { type: 'prospect', id: existing.id }, {
      stage: req.body?.stage,
    })

    return reply.send({ data: updated })
  })

  // POST /staff/prospects/:id/disqualify — managers and admins only.
  app.post<{ Params: { id: string }; Body: { reason?: string; note?: string } }>(
    '/:id/disqualify',
    { preHandler: requirePermission('prospect:disqualify') },
    async (req, reply) => {
      if (!isStaff(req.auth)) return reply.status(401).send({ error: 'Unauthorized' })

      const reason = req.body?.reason
      if (!reason || !DISQUALIFY_REASONS.includes(reason as DisqualifyReason)) {
        return reply
          .status(400)
          .send({ error: `reason must be one of: ${DISQUALIFY_REASONS.join(', ')}` })
      }
      // OTHER without a note is how a fixed reason list rots back into free
      // text nobody can analyse.
      if (reason === 'OTHER' && !req.body?.note?.trim()) {
        return reply.status(400).send({ error: 'note is required when reason is OTHER' })
      }

      const existing = await requireVisibleProspect(db, req, reply)
      if (!existing) return

      const [updated] = await db
        .update(prospects)
        .set({
          stage: 'DISQUALIFIED',
          disqualifyReason: reason as DisqualifyReason,
          disqualifyNote: req.body?.note?.trim() || null,
          updatedAt: new Date(),
        })
        .where(eq(prospects.id, existing.id))
        .returning()

      await audit(db, req.auth, 'prospect:disqualify', { type: 'prospect', id: existing.id }, {
        reason,
      })

      return reply.send({ data: updated })
    },
  )

  // POST /staff/prospects/:id/claim — take ownership of an unowned prospect.
  app.post<{ Params: { id: string } }>('/:id/claim', async (req, reply) => {
    if (!isStaff(req.auth)) return reply.status(401).send({ error: 'Unauthorized' })

    const existing = await requireVisibleProspect(db, req, reply)
    if (!existing) return

    if (existing.ownerId && existing.ownerId !== req.auth.staffId) {
      // Reassignment is a manager action, not a land-grab.
      if (!can(req.auth.role, 'prospect:assign')) {
        return reply.status(409).send({ error: 'Already owned' })
      }
    }

    const [updated] = await db
      .update(prospects)
      .set({ ownerId: req.auth.staffId, updatedAt: new Date() })
      .where(eq(prospects.id, existing.id))
      .returning()

    await audit(db, req.auth, 'queue:claim', { type: 'prospect', id: existing.id }, {
      previousOwnerId: existing.ownerId,
    })

    return reply.send({ data: updated })
  })

  // PATCH /staff/prospects/:id/owner — hand a prospect to someone.
  //
  // Separate from the generic PATCH because it is a different authority:
  // editing a prospect's details is `prospect:write` (any rep, on their own),
  // whereas deciding WHO works it is `prospect:assign` and belongs to a manager.
  app.patch<{ Params: { id: string }; Body: { ownerId?: string | null } }>(
    '/:id/owner',
    { preHandler: requirePermission('prospect:assign') },
    async (req, reply) => {
      if (!isStaff(req.auth)) return reply.status(401).send({ error: 'Unauthorized' })

      // `null` means unassign, which puts it back in the claimable pool. That
      // is a real action, not a mistake, so it is distinguished from the field
      // being absent.
      const hasOwner = Object.prototype.hasOwnProperty.call(req.body ?? {}, 'ownerId')
      if (!hasOwner) return reply.status(400).send({ error: 'ownerId required (null to unassign)' })

      const ownerId = req.body?.ownerId ?? null

      if (ownerId !== null) {
        const target = await db.query.staff.findFirst({ where: eq(staff.id, ownerId) })
        if (!target) return reply.status(400).send({ error: 'No such staff member' })
        // Assigning work to someone who cannot sign in strands it: the
        // prospect looks owned, so nobody claims it, and the owner never sees
        // the queue item.
        if (!target.active) {
          return reply.status(400).send({ error: 'That staff member is deactivated' })
        }
      }

      const [existing] = await db
        .select()
        .from(prospects)
        .where(and(eq(prospects.id, req.params.id), prospectScope(req.auth)))
        .limit(1)
      if (!existing) return reply.status(404).send({ error: 'Not found' })

      const [updated] = await db
        .update(prospects)
        .set({ ownerId, updatedAt: new Date() })
        .where(eq(prospects.id, existing.id))
        .returning()

      await audit(db, req.auth, 'prospect:assign', { type: 'prospect', id: existing.id }, {
        from: existing.ownerId,
        to: ownerId,
      })

      // Nothing needs to move the work queue by hand. The reconciler recomputes
      // each trigger's desired set from prospects.owner_id every sweep, so on
      // the next tick the new owner gets the item and the old owner's copy
      // resolves itself.
      return reply.send({ data: updated })
    },
  )

  // DELETE /staff/prospects/:id
  //
  // For mistakes and duplicates, not for "this one did not work out" — that is
  // what DISQUALIFY is for, and it keeps the reason on record so the CCO can
  // answer why merchants are lost.
  app.delete<{ Params: { id: string } }>(
    '/:id',
    { preHandler: requirePermission('prospect:disqualify') },
    async (req, reply) => {
      if (!isStaff(req.auth)) return reply.status(401).send({ error: 'Unauthorized' })

      const existing = await requireVisibleProspect(db, req, reply)
      if (!existing) return

      // A linked prospect is a real merchant's attribution record. Deleting it
      // destroys where that customer came from, and silently reopens their
      // SIGNUP_UNOWNED queue item because the merchant becomes unowned again.
      // Neither is what someone tidying up a duplicate expects.
      if (existing.merchantId) {
        return reply.status(409).send({
          error:
            'This prospect is linked to a merchant on Mesa, so it holds their attribution. ' +
            'Unassign the owner instead, or disqualify it if it is not a fit.',
        })
      }

      await audit(db, req.auth, 'prospect:delete', { type: 'prospect', id: existing.id }, {
        businessName: existing.businessName,
        stage: existing.stage,
        source: existing.source,
      })

      // Activities cascade with the row. The audit entry above is what survives,
      // which is the point: the record goes, the fact that someone removed it
      // does not.
      await db.delete(prospects).where(eq(prospects.id, existing.id))

      return reply.status(204).send()
    },
  )

  // GET /staff/prospects/:id/activities
  app.get<{ Params: { id: string } }>('/:id/activities', async (req, reply) => {
    if (!isStaff(req.auth)) return reply.status(401).send({ error: 'Unauthorized' })

    const existing = await requireVisibleProspect(db, req, reply)
    if (!existing) return

    const rows = await db
      .select({
        id: prospectActivities.id,
        type: prospectActivities.type,
        body: prospectActivities.body,
        occurredAt: prospectActivities.occurredAt,
        staffId: prospectActivities.staffId,
        staffName: staff.name,
      })
      .from(prospectActivities)
      .leftJoin(staff, eq(prospectActivities.staffId, staff.id))
      .where(eq(prospectActivities.prospectId, existing.id))
      .orderBy(desc(prospectActivities.occurredAt))
      .limit(200)

    return reply.send({ data: rows })
  })

  // POST /staff/prospects/:id/activities
  app.post<{ Params: { id: string }; Body: { type?: string; body?: string; occurredAt?: string } }>(
    '/:id/activities',
    { preHandler: requirePermission('activity:write') },
    async (req, reply) => {
      if (!isStaff(req.auth)) return reply.status(401).send({ error: 'Unauthorized' })

      const body = req.body?.body?.trim()
      if (!body) return reply.status(400).send({ error: 'body required' })

      const type = req.body?.type ?? 'note'
      if (!ACTIVITY_TYPES.includes(type as ActivityType)) {
        return reply.status(400).send({ error: `type must be one of: ${ACTIVITY_TYPES.join(', ')}` })
      }

      const existing = await requireVisibleProspect(db, req, reply)
      if (!existing) return

      const occurredAt = req.body?.occurredAt ? new Date(req.body.occurredAt) : new Date()
      if (Number.isNaN(occurredAt.getTime())) {
        return reply.status(400).send({ error: 'occurredAt must be a valid ISO date' })
      }

      const [created] = await db
        .insert(prospectActivities)
        .values({
          prospectId: existing.id,
          staffId: req.auth.staffId,
          type: type as ActivityType,
          body,
          occurredAt,
        })
        .returning()

      // Touch the prospect so the queue's "no activity in N days" ordering and
      // the escalation clock both see this.
      await db
        .update(prospects)
        .set({ updatedAt: new Date() })
        .where(eq(prospects.id, existing.id))

      return reply.status(201).send({ data: created })
    },
  )
}

/**
 * Fetch a prospect the caller is allowed to see AND mutate, or send the
 * response and return null.
 *
 * Centralised so no handler can accidentally check the permission and forget
 * the ownership — the classic hole in tools like this.
 */
async function requireVisibleProspect(
  db: Db,
  req: FastifyRequest<{ Params: { id: string } }>,
  reply: FastifyReply,
) {
  const auth = req.auth
  if (!isStaff(auth)) {
    reply.status(401).send({ error: 'Unauthorized' })
    return null
  }

  const [row] = await db
    .select()
    .from(prospects)
    .where(and(eq(prospects.id, req.params.id), prospectScope(auth)))
    .limit(1)

  if (!row) {
    reply.status(404).send({ error: 'Not found' })
    return null
  }
  if (!canMutateProspect(auth, row.ownerId)) {
    reply.status(403).send({ error: 'Forbidden' })
    return null
  }
  return row
}
