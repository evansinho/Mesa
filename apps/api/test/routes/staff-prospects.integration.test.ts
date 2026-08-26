import Fastify, { type FastifyInstance } from 'fastify'
import { eq } from 'drizzle-orm'
import { prospects, staffAuditLog } from '@mesa/db'
import { registerAuthContext } from '../../src/auth-context'
import { registerStaffRoutes } from '../../src/staff'
import { getTestDb } from '@test-helpers/db'
import { setupIntegration } from '@test-helpers/integration-setup'
import { createStaff, createStaffSession, createProspect, createMerchant } from '@test-helpers/factories'

setupIntegration()

async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify({ logger: false })
  const db = getTestDb()
  app.decorate('db', db)
  registerAuthContext(app, db)
  await registerStaffRoutes(app, db)
  return app
}

async function actor(role: 'admin' | 'manager' | 'member') {
  const db = getTestDb()
  const member = await createStaff(db, { role })
  const token = await createStaffSession(db, member.id)
  return { member, headers: { authorization: `Bearer ${token}` } }
}

describe('Prospect scoping', () => {
  it("hides another rep's prospect from a member as 404, not 403", async () => {
    const app = await buildApp()
    const db = getTestDb()
    const mine = await actor('member')
    const theirs = await actor('member')
    const hidden = await createProspect(db, { ownerId: theirs.member.id })

    const res = await app.inject({
      method: 'GET',
      url: `/staff/prospects/${hidden.id}`,
      headers: mine.headers,
    })

    // 404 rather than 403: an out-of-scope record must be indistinguishable
    // from one that doesn't exist, or the endpoint becomes an enumeration
    // oracle over the whole prospect list.
    expect(res.statusCode).toBe(404)
  })

  it('lets a manager see every prospect', async () => {
    const app = await buildApp()
    const db = getTestDb()
    const rep = await actor('member')
    const boss = await actor('manager')
    await createProspect(db, { ownerId: rep.member.id })

    const res = await app.inject({ method: 'GET', url: '/staff/prospects', headers: boss.headers })

    expect(res.statusCode).toBe(200)
    expect(res.json().meta.total).toBe(1)
  })

  it('scopes the list for a member to their own plus the unowned pool', async () => {
    const app = await buildApp()
    const db = getTestDb()
    const mine = await actor('member')
    const theirs = await actor('member')

    await createProspect(db, { ownerId: mine.member.id, businessName: 'Mine' })
    await createProspect(db, { ownerId: theirs.member.id, businessName: 'Theirs' })
    await createProspect(db, { ownerId: null, businessName: 'Unclaimed' })

    const res = await app.inject({ method: 'GET', url: '/staff/prospects', headers: mine.headers })

    const names = res.json().data.map((p: { businessName: string }) => p.businessName).sort()
    // Unowned is visible on purpose — it is claimable, and hiding it would
    // make the Claim notification lead to a 404.
    expect(names).toEqual(['Mine', 'Unclaimed'])
  })
})

describe('Prospect permissions', () => {
  it('refuses to let a member disqualify', async () => {
    const app = await buildApp()
    const db = getTestDb()
    const rep = await actor('member')
    const target = await createProspect(db, { ownerId: rep.member.id })

    const res = await app.inject({
      method: 'POST',
      url: `/staff/prospects/${target.id}/disqualify`,
      headers: rep.headers,
      payload: { reason: 'PRICE' },
    })

    expect(res.statusCode).toBe(403)
    expect(res.json().required).toBe('prospect:disqualify')
  })

  it('lets a manager disqualify and records it in the audit log', async () => {
    const app = await buildApp()
    const db = getTestDb()
    const boss = await actor('manager')
    const target = await createProspect(db)

    const res = await app.inject({
      method: 'POST',
      url: `/staff/prospects/${target.id}/disqualify`,
      headers: boss.headers,
      payload: { reason: 'TOO_LARGE' },
    })

    expect(res.statusCode).toBe(200)
    expect(res.json().data.stage).toBe('DISQUALIFIED')

    const logged = await db
      .select()
      .from(staffAuditLog)
      .where(eq(staffAuditLog.action, 'prospect:disqualify'))
    expect(logged).toHaveLength(1)
    expect(logged[0].staffId).toBe(boss.member.id)
  })

  it('requires a note when the reason is OTHER', async () => {
    const app = await buildApp()
    const db = getTestDb()
    const boss = await actor('manager')
    const target = await createProspect(db)

    const res = await app.inject({
      method: 'POST',
      url: `/staff/prospects/${target.id}/disqualify`,
      headers: boss.headers,
      payload: { reason: 'OTHER' },
    })

    // Without this, a fixed reason list rots back into free text nobody can
    // analyse — which is the whole point of having the list.
    expect(res.statusCode).toBe(400)
  })
})

describe('Prospect creation and attribution', () => {
  it('normalizes the phone and stamps owner and source', async () => {
    const app = await buildApp()
    const rep = await actor('member')

    const res = await app.inject({
      method: 'POST',
      url: '/staff/prospects',
      headers: rep.headers,
      payload: { businessName: 'Adeola Fabrics', phone: '0803 123 4567', source: 'instagram' },
    })

    expect(res.statusCode).toBe(201)
    const { data } = res.json()
    // The normalized form is the join key for prospect → merchant matching.
    expect(data.phoneNormalized).toBe('+2348031234567')
    expect(data.ownerId).toBe(rep.member.id)
    expect(data.source).toBe('instagram')
  })

  it('ignores an ownerId from a member who cannot assign', async () => {
    const app = await buildApp()
    const rep = await actor('member')
    const other = await actor('member')

    const res = await app.inject({
      method: 'POST',
      url: '/staff/prospects',
      headers: rep.headers,
      payload: {
        businessName: 'Kemi Beauty',
        phone: '08031234567',
        source: 'outbound',
        ownerId: other.member.id,
      },
    })

    expect(res.json().data.ownerId).toBe(rep.member.id)
  })

  it('rejects an unknown source rather than silently defaulting', async () => {
    const app = await buildApp()
    const rep = await actor('member')

    const res = await app.inject({
      method: 'POST',
      url: '/staff/prospects',
      headers: rep.headers,
      payload: { businessName: 'X', phone: '08031234567', source: 'tiktok' },
    })

    expect(res.statusCode).toBe(400)
  })

  it('refuses to edit attribution after creation', async () => {
    const app = await buildApp()
    const db = getTestDb()
    const boss = await actor('manager')
    const target = await createProspect(db, { source: 'outbound' })

    const res = await app.inject({
      method: 'PATCH',
      url: `/staff/prospects/${target.id}`,
      headers: boss.headers,
      payload: { source: 'referral' },
    })

    // Attribution that can be edited once the outcome is known is not
    // attribution.
    expect(res.statusCode).toBe(400)
    const unchanged = await db.query.prospects.findFirst({ where: eq(prospects.id, target.id) })
    expect(unchanged?.source).toBe('outbound')
  })
})

describe('Stage freezing', () => {
  it('refuses to hand-edit the stage once a merchant is linked', async () => {
    const app = await buildApp()
    const db = getTestDb()
    const boss = await actor('manager')
    const merchant = await createMerchant(db)
    const linked = await createProspect(db, {
      merchantId: merchant.id,
      matchStatus: 'auto',
      matchedAt: new Date(),
    })

    const res = await app.inject({
      method: 'PATCH',
      url: `/staff/prospects/${linked.id}`,
      headers: boss.headers,
      payload: { stage: 'DEMOED' },
    })

    // Everything after signup is derived from product data. A rep moving a
    // merchant back to DEMOED would put the funnel out of sync with reality.
    expect(res.statusCode).toBe(409)
  })

  it('rejects DISQUALIFIED through the generic stage update', async () => {
    const app = await buildApp()
    const db = getTestDb()
    const boss = await actor('manager')
    const target = await createProspect(db)

    const res = await app.inject({
      method: 'PATCH',
      url: `/staff/prospects/${target.id}`,
      headers: boss.headers,
      payload: { stage: 'DISQUALIFIED' },
    })

    // Disqualification must go through the dedicated route so a reason is
    // always captured and always audited.
    expect(res.statusCode).toBe(400)
  })
})

describe('Claiming and activity', () => {
  it('lets a member claim an unowned prospect', async () => {
    const app = await buildApp()
    const db = getTestDb()
    const rep = await actor('member')
    const unowned = await createProspect(db, { ownerId: null })

    const res = await app.inject({
      method: 'POST',
      url: `/staff/prospects/${unowned.id}/claim`,
      headers: rep.headers,
    })

    expect(res.statusCode).toBe(200)
    expect(res.json().data.ownerId).toBe(rep.member.id)
  })

  it("refuses to let a member claim another rep's prospect", async () => {
    const app = await buildApp()
    const db = getTestDb()
    const rep = await actor('member')
    const other = await actor('member')
    const theirs = await createProspect(db, { ownerId: other.member.id })

    const res = await app.inject({
      method: 'POST',
      url: `/staff/prospects/${theirs.id}/claim`,
      headers: rep.headers,
    })

    // Out of scope entirely, so 404 for the same reason as the detail route.
    expect(res.statusCode).toBe(404)
  })

  it('logs an activity and returns it in the feed', async () => {
    const app = await buildApp()
    const db = getTestDb()
    const rep = await actor('member')
    const target = await createProspect(db, { ownerId: rep.member.id })

    const created = await app.inject({
      method: 'POST',
      url: `/staff/prospects/${target.id}/activities`,
      headers: rep.headers,
      payload: { type: 'call', body: 'Wants to see the delivery flow first' },
    })
    expect(created.statusCode).toBe(201)

    const feed = await app.inject({
      method: 'GET',
      url: `/staff/prospects/${target.id}/activities`,
      headers: rep.headers,
    })

    const rows = feed.json().data
    expect(rows).toHaveLength(1)
    expect(rows[0].type).toBe('call')
    expect(rows[0].staffName).toBe(rep.member.name)
  })

  it('rejects an empty activity body', async () => {
    const app = await buildApp()
    const db = getTestDb()
    const rep = await actor('member')
    const target = await createProspect(db, { ownerId: rep.member.id })

    const res = await app.inject({
      method: 'POST',
      url: `/staff/prospects/${target.id}/activities`,
      headers: rep.headers,
      payload: { body: '   ' },
    })

    expect(res.statusCode).toBe(400)
  })
})
