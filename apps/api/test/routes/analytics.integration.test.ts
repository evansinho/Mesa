import Fastify, { type FastifyInstance } from 'fastify'
import { sql } from 'drizzle-orm'
import { analyticsRoutes } from '../../src/routes/analytics'
import { registerAuthContext } from '../../src/auth-context'
import { getTestDb } from '@test-helpers/db'
import { setupIntegration } from '@test-helpers/integration-setup'
import { createMerchant, createConversation, createOrder, createPayment } from '@test-helpers/factories'
import { createSessionHeaders } from '@test-helpers/auth'

setupIntegration()

const apps: FastifyInstance[] = []

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()))
})

async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify({ logger: false })
  const db = getTestDb()
  app.decorate('db', db)
  registerAuthContext(app, db)
  await app.register(analyticsRoutes, { prefix: '/analytics' })
  apps.push(app)
  return app
}

describe('GET /analytics/by-source', () => {
  it('buckets a null-source order by its conversation channel, distinct from a real tracked-instagram source', async () => {
    const app = await buildApp()
    const db = getTestDb()
    const merchant = await createMerchant(db)

    // No tracked click at all — an Instagram DM straight to the merchant.
    const igConv = await createConversation(db, merchant.id, { channel: 'instagram' })
    await createOrder(db, merchant.id, {
      conversationId: igConv.id,
      total: '5200000',
      subtotal: '5200000',
      source: null,
    })

    // A genuinely tracked Instagram bio-link click — must stay in its own
    // bucket, not get folded into the same label as the DM above.
    const waConv = await createConversation(db, merchant.id, { channel: 'whatsapp' })
    await createOrder(db, merchant.id, {
      conversationId: waConv.id,
      total: '10000',
      subtotal: '10000',
      source: 'instagram',
      sourceConfidence: 'confirmed',
    })

    const res = await app.inject({
      method: 'GET',
      url: `/analytics/by-source?merchantId=${merchant.id}`,
      headers: await createSessionHeaders(db, merchant.id),
    })

    expect(res.statusCode).toBe(200)
    const { sources } = res.json() as { sources: Array<{ source: string; confidence: string | null; revenue: number }> }
    const instagramDirect = sources.find(s => s.source === 'instagram_direct')
    const trackedInstagram = sources.find(s => s.source === 'instagram')
    expect(instagramDirect?.revenue).toBe(5200000)
    expect(instagramDirect?.confidence).toBeNull()
    expect(trackedInstagram?.revenue).toBe(10000)
    expect(trackedInstagram?.confidence).toBe('confirmed')
  })

  it('buckets a null-source, null-conversation order as plain "direct"', async () => {
    const app = await buildApp()
    const db = getTestDb()
    const merchant = await createMerchant(db)
    await createOrder(db, merchant.id, { total: '3000', subtotal: '3000', source: null, conversationId: null })

    const res = await app.inject({
      method: 'GET',
      url: `/analytics/by-source?merchantId=${merchant.id}`,
      headers: await createSessionHeaders(db, merchant.id),
    })

    expect(res.statusCode).toBe(200)
    const { sources } = res.json() as { sources: Array<{ source: string; revenue: number }> }
    expect(sources.find(s => s.source === 'direct')?.revenue).toBe(3000)
  })
})

describe('GET /analytics/summary — calendar-aligned windows', () => {
  // Queries Postgres for the exact same boundaries the route computes,
  // rather than hardcoding offsets — a fixed "40 days ago" guess for
  // "last month" would be wrong depending on which day of the month the
  // test happens to run on.
  async function calendarBoundaries(db: ReturnType<typeof getTestDb>) {
    const result = await db.execute(sql`
      SELECT
        (date_trunc('week', now() AT TIME ZONE 'Africa/Lagos') AT TIME ZONE 'Africa/Lagos') AS "thisWeekStart",
        (date_trunc('month', now() AT TIME ZONE 'Africa/Lagos') AT TIME ZONE 'Africa/Lagos') AS "thisMonthStart",
        (date_trunc('month', (now() AT TIME ZONE 'Africa/Lagos') - interval '1 month') AT TIME ZONE 'Africa/Lagos') AS "lastMonthStart"
    `)
    const row = (result as unknown as { rows: Array<{ thisWeekStart: string; thisMonthStart: string; lastMonthStart: string }> }).rows[0]
    return {
      thisWeekStart: new Date(row.thisWeekStart),
      thisMonthStart: new Date(row.thisMonthStart),
      lastMonthStart: new Date(row.lastMonthStart),
    }
  }

  it('counts an order from earlier this week in thisWeek', async () => {
    const app = await buildApp()
    const db = getTestDb()
    const merchant = await createMerchant(db)
    const { thisWeekStart } = await calendarBoundaries(db)

    const order = await createOrder(db, merchant.id, {
      total: '4000', subtotal: '4000',
      createdAt: new Date(thisWeekStart.getTime() + 60 * 60 * 1000), // 1h into this week
    })
    await createPayment(db, order.id, merchant.id, { status: 'CONFIRMED', amount: '4000', confirmedAt: new Date() })

    const res = await app.inject({
      method: 'GET',
      url: `/analytics/summary?merchantId=${merchant.id}`,
      headers: await createSessionHeaders(db, merchant.id),
    })

    expect(res.statusCode).toBe(200)
    const { revenue } = res.json() as { revenue: { thisWeek: { totalRevenue: number } } }
    expect(revenue.thisWeek.totalRevenue).toBe(4000)
  })

  it('counts an order from just after this month started in thisMonth', async () => {
    const app = await buildApp()
    const db = getTestDb()
    const merchant = await createMerchant(db)
    const { thisMonthStart } = await calendarBoundaries(db)

    const order = await createOrder(db, merchant.id, {
      total: '6000', subtotal: '6000',
      createdAt: new Date(thisMonthStart.getTime() + 1000),
    })
    await createPayment(db, order.id, merchant.id, { status: 'CONFIRMED', amount: '6000', confirmedAt: new Date() })

    const res = await app.inject({
      method: 'GET',
      url: `/analytics/summary?merchantId=${merchant.id}`,
      headers: await createSessionHeaders(db, merchant.id),
    })

    expect(res.statusCode).toBe(200)
    const { revenue } = res.json() as { revenue: { thisMonth: { totalRevenue: number } } }
    expect(revenue.thisMonth.totalRevenue).toBe(6000)
  })

  it('counts an order from the middle of last calendar month in lastMonth, but excludes one right at the start of this month', async () => {
    const app = await buildApp()
    const db = getTestDb()
    const merchant = await createMerchant(db)
    const { lastMonthStart, thisMonthStart } = await calendarBoundaries(db)

    // Squarely inside last calendar month.
    const midLastMonth = new Date((lastMonthStart.getTime() + thisMonthStart.getTime()) / 2)
    const lastMonthOrder = await createOrder(db, merchant.id, {
      total: '9000', subtotal: '9000',
      createdAt: midLastMonth,
    })
    await createPayment(db, lastMonthOrder.id, merchant.id, { status: 'CONFIRMED', amount: '9000', confirmedAt: new Date() })

    // Right at the start of this month — must NOT count as last month
    // (lastMonth's upper bound is exclusive).
    const thisMonthOrder = await createOrder(db, merchant.id, {
      total: '500', subtotal: '500',
      createdAt: new Date(thisMonthStart.getTime() + 1000),
    })
    await createPayment(db, thisMonthOrder.id, merchant.id, { status: 'CONFIRMED', amount: '500', confirmedAt: new Date() })

    const res = await app.inject({
      method: 'GET',
      url: `/analytics/summary?merchantId=${merchant.id}`,
      headers: await createSessionHeaders(db, merchant.id),
    })

    expect(res.statusCode).toBe(200)
    const { revenue } = res.json() as { revenue: { lastMonth: { totalRevenue: number } } }
    expect(revenue.lastMonth.totalRevenue).toBe(9000)
  })
})

describe('GET /analytics/revenue-range', () => {
  // Lagos-local "today" as YYYY-MM-DD, queried from Postgres rather than
  // computed in JS, so it always matches the same calendar day the route
  // itself resolves the date strings against.
  async function lagosToday(db: ReturnType<typeof getTestDb>): Promise<string> {
    const result = await db.execute(sql`SELECT (now() AT TIME ZONE 'Africa/Lagos')::date AS today`)
    const row = (result as unknown as { rows: Array<{ today: string }> }).rows[0]
    return row.today
  }

  function addDays(dateStr: string, days: number): string {
    const d = new Date(`${dateStr}T00:00:00.000Z`)
    d.setUTCDate(d.getUTCDate() + days)
    return d.toISOString().slice(0, 10)
  }

  it('rejects malformed or missing dates', async () => {
    const app = await buildApp()
    const db = getTestDb()
    const merchant = await createMerchant(db)

    const res = await app.inject({
      method: 'GET',
      url: `/analytics/revenue-range?merchantId=${merchant.id}&from=not-a-date&to=2026-01-01`,
      headers: await createSessionHeaders(db, merchant.id),
    })
    expect(res.statusCode).toBe(400)
  })

  it('rejects a range where from is after to', async () => {
    const app = await buildApp()
    const db = getTestDb()
    const merchant = await createMerchant(db)

    const res = await app.inject({
      method: 'GET',
      url: `/analytics/revenue-range?merchantId=${merchant.id}&from=2026-02-10&to=2026-02-01`,
      headers: await createSessionHeaders(db, merchant.id),
    })
    expect(res.statusCode).toBe(400)
  })

  it('sums confirmed revenue for a single day (from === to)', async () => {
    const app = await buildApp()
    const db = getTestDb()
    const merchant = await createMerchant(db)
    const today = await lagosToday(db)

    const order = await createOrder(db, merchant.id, {
      total: '7500', subtotal: '7500',
      createdAt: new Date(`${today}T12:00:00.000Z`),
    })
    await createPayment(db, order.id, merchant.id, { status: 'CONFIRMED', amount: '7500', confirmedAt: new Date() })

    // Outside the picked day entirely — must not be included.
    const yesterday = addDays(today, -1)
    const outsideOrder = await createOrder(db, merchant.id, {
      total: '999', subtotal: '999',
      createdAt: new Date(`${yesterday}T12:00:00.000Z`),
    })
    await createPayment(db, outsideOrder.id, merchant.id, { status: 'CONFIRMED', amount: '999', confirmedAt: new Date() })

    const res = await app.inject({
      method: 'GET',
      url: `/analytics/revenue-range?merchantId=${merchant.id}&from=${today}&to=${today}`,
      headers: await createSessionHeaders(db, merchant.id),
    })

    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ totalRevenue: 7500, totalOrders: 1 })
  })

  it('sums confirmed revenue across a multi-day range, inclusive of both endpoints', async () => {
    const app = await buildApp()
    const db = getTestDb()
    const merchant = await createMerchant(db)
    const today = await lagosToday(db)
    const twoDaysAgo = addDays(today, -2)
    const threeDaysAgo = addDays(today, -3)

    const inRangeStart = await createOrder(db, merchant.id, {
      total: '1000', subtotal: '1000',
      createdAt: new Date(`${twoDaysAgo}T00:30:00.000Z`), // just after the range's start-of-day
    })
    await createPayment(db, inRangeStart.id, merchant.id, { status: 'CONFIRMED', amount: '1000', confirmedAt: new Date() })

    const inRangeEnd = await createOrder(db, merchant.id, {
      total: '2000', subtotal: '2000',
      // Africa/Lagos is UTC+1 with no DST, so Lagos-midnight of the day
      // after `today` is 23:00 UTC on `today` — 20:00 UTC stays safely
      // inside the Lagos calendar day rather than crossing into the next.
      createdAt: new Date(`${today}T20:00:00.000Z`),
    })
    await createPayment(db, inRangeEnd.id, merchant.id, { status: 'CONFIRMED', amount: '2000', confirmedAt: new Date() })

    const beforeRange = await createOrder(db, merchant.id, {
      total: '3000', subtotal: '3000',
      createdAt: new Date(`${threeDaysAgo}T12:00:00.000Z`),
    })
    await createPayment(db, beforeRange.id, merchant.id, { status: 'CONFIRMED', amount: '3000', confirmedAt: new Date() })

    const res = await app.inject({
      method: 'GET',
      url: `/analytics/revenue-range?merchantId=${merchant.id}&from=${twoDaysAgo}&to=${today}`,
      headers: await createSessionHeaders(db, merchant.id),
    })

    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ totalRevenue: 3000, totalOrders: 2 })
  })
})
