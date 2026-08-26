import Fastify, { type FastifyInstance } from 'fastify'
import { staffNotifications } from '@mesa/db'
import { registerAuthContext } from '../../src/auth-context'
import { registerStaffRoutes } from '../../src/staff'
import { getTestDb } from '@test-helpers/db'
import { setupIntegration } from '@test-helpers/integration-setup'
import { createStaff, createStaffSession, createMerchant, createProspect } from '@test-helpers/factories'

setupIntegration()

async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify({ logger: false })
  const db = getTestDb()
  app.decorate('db', db)
  registerAuthContext(app, db)
  await registerStaffRoutes(app, db)
  return app
}

async function actor(role: 'admin' | 'manager' | 'member' = 'member') {
  const db = getTestDb()
  const member = await createStaff(db, { role })
  const token = await createStaffSession(db, member.id)
  return { member, headers: { authorization: `Bearer ${token}` } }
}

describe('Staff work queue', () => {
  it('returns open action items with a recommended action', async () => {
    const app = await buildApp()
    const db = getTestDb()
    const me = await actor()
    const merchant = await createMerchant(db, { name: 'Adeola Fabrics' })

    await db.insert(staffNotifications).values({
      staffId: me.member.id,
      tier: 'action',
      kind: 'NOT_CONNECTED',
      merchantId: merchant.id,
      body: 'Adeola Fabrics signed up but has not connected WhatsApp',
    })

    const res = await app.inject({ method: 'GET', url: '/staff/queue', headers: me.headers })

    expect(res.statusCode).toBe(200)
    const [item] = res.json().data
    expect(item.kind).toBe('NOT_CONNECTED')
    expect(item.targetName).toBe('Adeola Fabrics')
    // The action label is what makes this a queue rather than a list.
    expect(item.actionLabel).toBe('Help connect')
  })

  it('orders by cost, not recency', async () => {
    const app = await buildApp()
    const db = getTestDb()
    const me = await actor()
    const a = await createMerchant(db)
    const b = await createMerchant(db)

    // The stale one is OLDER, so recency ordering would put it first.
    await db.insert(staffNotifications).values([
      {
        staffId: me.member.id, tier: 'action', kind: 'PROSPECT_STALE',
        prospectId: (await createProspect(db, { ownerId: me.member.id })).id,
        body: 'stale', createdAt: new Date(Date.now() - 10 * 86_400_000),
      },
      {
        staffId: me.member.id, tier: 'action', kind: 'TRIAL_ENDING_NO_VALUE',
        merchantId: a.id, body: 'trial ending', createdAt: new Date(),
      },
      {
        staffId: me.member.id, tier: 'action', kind: 'AT_RISK',
        merchantId: b.id, body: 'at risk', createdAt: new Date(),
      },
    ])

    const res = await app.inject({ method: 'GET', url: '/staff/queue', headers: me.headers })

    // A trial lapsing tomorrow beats a prospect that has been quiet for ten
    // days; a rep opening this at 8am shouldn't have to work that out.
    expect(res.json().data.map((i: { kind: string }) => i.kind))
      .toEqual(['TRIAL_ENDING_NO_VALUE', 'AT_RISK', 'PROSPECT_STALE'])
  })

  it("never shows another staff member's queue", async () => {
    const app = await buildApp()
    const db = getTestDb()
    const me = await actor()
    const other = await actor()
    const merchant = await createMerchant(db)

    await db.insert(staffNotifications).values({
      staffId: other.member.id, tier: 'action', kind: 'AT_RISK',
      merchantId: merchant.id, body: 'theirs',
    })

    const res = await app.inject({ method: 'GET', url: '/staff/queue', headers: me.headers })
    expect(res.json().data).toEqual([])
  })

  it('excludes resolved items', async () => {
    const app = await buildApp()
    const db = getTestDb()
    const me = await actor()
    const merchant = await createMerchant(db)

    await db.insert(staffNotifications).values({
      staffId: me.member.id, tier: 'action', kind: 'NOT_CONNECTED',
      merchantId: merchant.id, body: 'done', resolvedAt: new Date(),
    })

    const res = await app.inject({ method: 'GET', url: '/staff/queue', headers: me.headers })
    expect(res.json().data).toEqual([])
  })

  it('keeps feed items out of the action queue', async () => {
    const app = await buildApp()
    const db = getTestDb()
    const me = await actor()
    const merchant = await createMerchant(db)

    await db.insert(staffNotifications).values({
      staffId: me.member.id, tier: 'feed', kind: 'FIRST_VALUE',
      merchantId: merchant.id, body: 'good news', resolvedAt: new Date(),
    })

    const queue = await app.inject({ method: 'GET', url: '/staff/queue', headers: me.headers })
    expect(queue.json().data).toEqual([])

    const feed = await app.inject({ method: 'GET', url: '/staff/queue/feed', headers: me.headers })
    expect(feed.json().data).toHaveLength(1)
  })

  it('counts only unresolved action items for the badge', async () => {
    const app = await buildApp()
    const db = getTestDb()
    const me = await actor()
    const m1 = await createMerchant(db)
    const m2 = await createMerchant(db)

    await db.insert(staffNotifications).values([
      { staffId: me.member.id, tier: 'action', kind: 'AT_RISK', merchantId: m1.id, body: 'a' },
      { staffId: me.member.id, tier: 'feed', kind: 'ACTIVATED', merchantId: m2.id, body: 'b', resolvedAt: new Date() },
    ])

    const res = await app.inject({ method: 'GET', url: '/staff/queue/count', headers: me.headers })
    // Good news must never badge the bell, or the badge stops meaning
    // "something needs doing".
    expect(res.json().data).toEqual({ open: 1, unread: 1 })
  })

  it('marks items read without resolving them', async () => {
    const app = await buildApp()
    const db = getTestDb()
    const me = await actor()
    const merchant = await createMerchant(db)

    const [row] = await db.insert(staffNotifications).values({
      staffId: me.member.id, tier: 'action', kind: 'NOT_CONNECTED',
      merchantId: merchant.id, body: 'x',
    }).returning()

    await app.inject({
      method: 'POST', url: '/staff/queue/read', headers: me.headers,
      payload: { ids: [row.id] },
    })

    const count = await app.inject({ method: 'GET', url: '/staff/queue/count', headers: me.headers })
    // Read is not resolved: a rep cannot dismiss a merchant who still hasn't
    // connected. Only the sweep closes an item, and only because the condition
    // stopped being true.
    expect(count.json().data).toEqual({ open: 1, unread: 0 })
  })

  it('rejects an unauthenticated caller', async () => {
    const app = await buildApp()
    const res = await app.inject({ method: 'GET', url: '/staff/queue' })
    expect(res.statusCode).toBe(401)
  })
})
