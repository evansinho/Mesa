import { eq } from 'drizzle-orm'
import { commercialRules } from '@mesa/config'
import { merchantChannels, merchantLifecycleEvents, orders, payments } from '@mesa/db'
import { runLifecycleSweep, gatherMerchantFacts } from '../../src/commercial/sweep'
import { getTestDb } from '@test-helpers/db'
import { setupIntegration } from '@test-helpers/integration-setup'
import { createMerchant, createConversation } from '@test-helpers/factories'

setupIntegration()

const daysAgo = (n: number) => new Date(Date.now() - n * 24 * 60 * 60 * 1000)

async function addOrder(
  merchantId: string,
  conversationId: string,
  status: 'PENDING' | 'CONFIRMED' | 'PAID' | 'CANCELLED',
  createdAt: Date,
) {
  const db = getTestDb()
  const [row] = await db
    .insert(orders)
    .values({
      merchantId,
      conversationId,
      customerPhone: '+2348030000000',
      status,
      subtotal: '5000.00',
      total: '5000.00',
      createdAt,
    })
    .returning()
  return row
}

async function statesFor(merchantId: string) {
  const rows = await getTestDb()
    .select()
    .from(merchantLifecycleEvents)
    .where(eq(merchantLifecycleEvents.merchantId, merchantId))
  return rows.map((r) => r.toState)
}

describe('Lifecycle sweep', () => {
  it('records SIGNED_UP for a merchant with nothing else', async () => {
    const db = getTestDb()
    const m = await createMerchant(db)

    const result = await runLifecycleSweep(db)

    expect(result.evaluated).toBe(1)
    expect(result.transitions).toEqual([
      { merchantId: m.id, from: null, to: 'SIGNED_UP' },
    ])
    expect(await statesFor(m.id)).toEqual(['SIGNED_UP'])
  })

  it('is idempotent — a second run with nothing changed writes nothing', async () => {
    const db = getTestDb()
    await createMerchant(db)

    await runLifecycleSweep(db)
    const second = await runLifecycleSweep(db)

    // This is the property that lets it run every 15 minutes forever. Without
    // it the table grows by one row per merchant per tick — 96 a day each.
    expect(second.transitions).toEqual([])
  })

  it('advances to CONNECTED and stamps the channel’s own connected_at', async () => {
    const db = getTestDb()
    const m = await createMerchant(db)
    const connectedAt = daysAgo(3)
    await db.insert(merchantChannels).values({
      merchantId: m.id,
      channel: 'whatsapp',
      channelAccountId: 'wa-1',
      status: 'connected',
      connectedAt,
    })

    await runLifecycleSweep(db)

    const [row] = await db
      .select()
      .from(merchantLifecycleEvents)
      .where(eq(merchantLifecycleEvents.merchantId, m.id))

    expect(row.toState).toBe('CONNECTED')
    // Not the sweep's run time. A sweep that runs late must not claim the
    // merchant connected the moment it noticed, or every "time to connect"
    // figure is wrong.
    expect(row.occurredAt.getTime()).toBeCloseTo(connectedAt.getTime(), -3)
  })

  it('ignores PENDING orders — detection is not value', async () => {
    const db = getTestDb()
    const m = await createMerchant(db)
    const convo = await createConversation(db, m.id)
    await db.insert(merchantChannels).values({
      merchantId: m.id, channel: 'whatsapp', channelAccountId: 'wa-1', status: 'connected',
    })
    await addOrder(m.id, convo.id, 'PENDING', daysAgo(1))

    const facts = (await gatherMerchantFacts(db)).find((f) => f.merchantId === m.id)!
    expect(facts.firstValueAt).toBeNull()
    expect(facts.ordersInActivationWindow).toBe(0)

    await runLifecycleSweep(db)
    expect(await statesFor(m.id)).toEqual(['CONNECTED'])
  })

  it('ignores CANCELLED orders', async () => {
    const db = getTestDb()
    const m = await createMerchant(db)
    const convo = await createConversation(db, m.id)
    await addOrder(m.id, convo.id, 'CANCELLED', daysAgo(1))

    const facts = (await gatherMerchantFacts(db)).find((f) => f.merchantId === m.id)!
    expect(facts.firstValueAt).toBeNull()
  })

  it('advances to FIRST_VALUE on a confirmed order', async () => {
    const db = getTestDb()
    const m = await createMerchant(db)
    const convo = await createConversation(db, m.id)
    await db.insert(merchantChannels).values({
      merchantId: m.id, channel: 'whatsapp', channelAccountId: 'wa-1', status: 'connected',
    })
    await addOrder(m.id, convo.id, 'CONFIRMED', daysAgo(1))

    await runLifecycleSweep(db)
    expect(await statesFor(m.id)).toEqual(['FIRST_VALUE'])
  })

  it('advances to FIRST_PAYMENT on a confirmed payment', async () => {
    const db = getTestDb()
    const m = await createMerchant(db)
    const convo = await createConversation(db, m.id)
    const order = await addOrder(m.id, convo.id, 'PAID', daysAgo(2))
    await db.insert(payments).values({
      orderId: order.id,
      merchantId: m.id,
      amount: '5000.00',
      status: 'CONFIRMED',
      confirmedAt: daysAgo(2),
      screenshotHash: 'hash-first-payment',
    })

    await runLifecycleSweep(db)
    expect(await statesFor(m.id)).toEqual(['FIRST_PAYMENT'])
  })

  it('activates on the configured order count and window', async () => {
    const db = getTestDb()
    const m = await createMerchant(db)
    const convo = await createConversation(db, m.id)
    for (let i = 0; i < commercialRules.activation.minOrders; i++) {
      await addOrder(m.id, convo.id, 'CONFIRMED', daysAgo(1))
    }

    await runLifecycleSweep(db)
    expect(await statesFor(m.id)).toEqual(['ACTIVATED'])
  })

  it('does not activate when the orders fall outside the window', async () => {
    const db = getTestDb()
    const m = await createMerchant(db)
    const convo = await createConversation(db, m.id)
    // Enough orders, but spread wider than the activation window, so no
    // window of `windowDays` ever contains `minOrders` of them.
    const spread = commercialRules.activation.windowDays + 2
    for (let i = 0; i < commercialRules.activation.minOrders; i++) {
      await addOrder(m.id, convo.id, 'CONFIRMED', daysAgo(1 + i * spread))
    }

    const facts = (await gatherMerchantFacts(db)).find((f) => f.merchantId === m.id)!
    expect(facts.everActivated).toBe(false)
    expect(facts.ordersInActivationWindow).toBeLessThan(commercialRules.activation.minOrders)
  })

  it('detects a previously-activated merchant who has gone quiet as AT_RISK', async () => {
    const db = getTestDb()
    const m = await createMerchant(db, { subscriptionStatus: 'active' })
    const convo = await createConversation(db, m.id)
    // A burst old enough to be outside the risk window entirely.
    const longAgo = commercialRules.risk.silentDays + 10
    for (let i = 0; i < commercialRules.activation.minOrders; i++) {
      await addOrder(m.id, convo.id, 'CONFIRMED', daysAgo(longAgo))
    }

    const facts = (await gatherMerchantFacts(db)).find((f) => f.merchantId === m.id)!
    expect(facts.everActivated).toBe(true)
    expect(facts.ordersInRiskWindow).toBe(0)

    await runLifecycleSweep(db)
    expect(await statesFor(m.id)).toEqual(['AT_RISK'])
  })

  it('records the AT_RISK → PAYING → AT_RISK cycle rather than collapsing it', async () => {
    const db = getTestDb()
    const m = await createMerchant(db, { subscriptionStatus: 'active' })
    const convo = await createConversation(db, m.id)
    const longAgo = commercialRules.risk.silentDays + 10
    for (let i = 0; i < commercialRules.activation.minOrders; i++) {
      await addOrder(m.id, convo.id, 'CONFIRMED', daysAgo(longAgo))
    }

    await runLifecycleSweep(db)
    expect(await statesFor(m.id)).toEqual(['AT_RISK'])

    // They come back.
    const recent = await addOrder(m.id, convo.id, 'CONFIRMED', daysAgo(1))
    await runLifecycleSweep(db)
    expect(await statesFor(m.id)).toEqual(['AT_RISK', 'PAYING'])

    // And go quiet again.
    await db.update(orders).set({ createdAt: daysAgo(longAgo) }).where(eq(orders.id, recent.id))
    await runLifecycleSweep(db)

    // Three rows, not two. This is why there is no unique index on
    // (merchant, state, version) — the recovery-rate metric is made of these
    // cycles, and a unique index would have swallowed the second AT_RISK.
    expect(await statesFor(m.id)).toEqual(['AT_RISK', 'PAYING', 'AT_RISK'])
  })

  it('does not flag a merchant who never got going as AT_RISK', async () => {
    const db = getTestDb()
    const m = await createMerchant(db)
    await db.insert(merchantChannels).values({
      merchantId: m.id, channel: 'whatsapp', channelAccountId: 'wa-1', status: 'connected',
    })

    await runLifecycleSweep(db)
    // Failed activation, not churn risk — a different problem with a different
    // fix, and lumping them together buries the merchants who need onboarding.
    expect(await statesFor(m.id)).toEqual(['CONNECTED'])
  })

  it.each(['expired', 'cancelled'] as const)('records CHURNED for %s', async (status) => {
    const db = getTestDb()
    const m = await createMerchant(db, { subscriptionStatus: status })

    await runLifecycleSweep(db)
    expect(await statesFor(m.id)).toEqual(['CHURNED'])
  })

  it('stamps every row with the current rule version', async () => {
    const db = getTestDb()
    const m = await createMerchant(db)

    await runLifecycleSweep(db)

    const [row] = await db
      .select()
      .from(merchantLifecycleEvents)
      .where(eq(merchantLifecycleEvents.merchantId, m.id))
    // Without this, changing a threshold silently rewrites what last quarter
    // looked like.
    expect(row.ruleVersion).toBe(commercialRules.version)
    expect(row.detectedBy).toBe('sweep')
  })

  it('carries fromState so a transition is readable without the previous row', async () => {
    const db = getTestDb()
    const m = await createMerchant(db)
    await runLifecycleSweep(db)

    await db.insert(merchantChannels).values({
      merchantId: m.id, channel: 'whatsapp', channelAccountId: 'wa-1', status: 'connected',
    })
    await runLifecycleSweep(db)

    const rows = await db
      .select()
      .from(merchantLifecycleEvents)
      .where(eq(merchantLifecycleEvents.merchantId, m.id))
      .orderBy(merchantLifecycleEvents.createdAt)

    expect(rows.map((r) => [r.fromState, r.toState])).toEqual([
      [null, 'SIGNED_UP'],
      ['SIGNED_UP', 'CONNECTED'],
    ])
  })
})
