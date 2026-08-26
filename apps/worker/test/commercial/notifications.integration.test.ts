import { and, eq, isNull } from 'drizzle-orm'
import { commercialRules } from '@mesa/config'
import {
  merchantChannels,
  merchants,
  orders,
  prospectActivities,
  staffNotifications,
} from '@mesa/db'
import { normalizePhone } from '@mesa/types'
import {
  reconcileNotifications,
  emitFeedNotifications,
  escalateStaleNotifications,
} from '../../src/commercial/notifications'
import { runLifecycleSweep } from '../../src/commercial/sweep'
import { getTestDb } from '@test-helpers/db'
import { setupIntegration } from '@test-helpers/integration-setup'
import {
  createMerchant,
  createConversation,
  createStaff,
  createProspect,
} from '@test-helpers/factories'

setupIntegration()

const hoursAgo = (n: number) => new Date(Date.now() - n * 60 * 60 * 1000)
const daysAgo = (n: number) => new Date(Date.now() - n * 24 * 60 * 60 * 1000)

async function openNotifications(kind?: string) {
  const db = getTestDb()
  const where = kind
    ? and(eq(staffNotifications.kind, kind as 'NOT_CONNECTED'), isNull(staffNotifications.resolvedAt))
    : isNull(staffNotifications.resolvedAt)
  return db.select().from(staffNotifications).where(where)
}

/** A merchant that signed up long enough ago to trip the connection trigger. */
async function staleUnconnectedMerchant() {
  const db = getTestDb()
  return createMerchant(db, {
    createdAt: hoursAgo(commercialRules.queue.unconnectedAfterHours + 6),
  })
}

describe('Notification reconciliation — opening', () => {
  it('opens NOT_CONNECTED for a merchant who signed up and never connected', async () => {
    const db = getTestDb()
    const owner = await createStaff(db, { role: 'member' })
    const merchant = await staleUnconnectedMerchant()
    await createProspect(db, {
      merchantId: merchant.id,
      ownerId: owner.id,
      phone: merchant.phone,
      phoneNormalized: normalizePhone(merchant.phone),
    })

    const result = await reconcileNotifications(db)

    expect(result.opened).toBeGreaterThan(0)
    const open = await openNotifications('NOT_CONNECTED')
    expect(open).toHaveLength(1)
    // Routed to the owning rep, not broadcast.
    expect(open[0].staffId).toBe(owner.id)
    expect(open[0].tier).toBe('action')
  })

  it('routes an unowned merchant to every manager and admin instead of nobody', async () => {
    const db = getTestDb()
    const admin = await createStaff(db, { role: 'admin' })
    const manager = await createStaff(db, { role: 'manager' })
    await createStaff(db, { role: 'member' }) // must NOT be notified
    await staleUnconnectedMerchant()

    await reconcileNotifications(db)

    const open = await openNotifications('NOT_CONNECTED')
    // An unowned merchant that notifies nobody is precisely the merchant who
    // never connects.
    expect(open.map((n) => n.staffId).sort()).toEqual([admin.id, manager.id].sort())
  })

  it('does not open NOT_CONNECTED before the threshold', async () => {
    const db = getTestDb()
    await createStaff(db, { role: 'admin' })
    await createMerchant(db, { createdAt: hoursAgo(1) })

    await reconcileNotifications(db)
    expect(await openNotifications('NOT_CONNECTED')).toHaveLength(0)
  })

  it('is idempotent — running twice does not duplicate an open notification', async () => {
    const db = getTestDb()
    await createStaff(db, { role: 'admin' })
    await staleUnconnectedMerchant()

    await reconcileNotifications(db)
    await reconcileNotifications(db)

    // Without this the 15-minute sweep would open the same row 96 times a day.
    expect(await openNotifications('NOT_CONNECTED')).toHaveLength(1)
  })

  it('opens NO_FIRST_ORDER once connected long enough with nothing sold', async () => {
    const db = getTestDb()
    await createStaff(db, { role: 'admin' })
    const merchant = await createMerchant(db)
    await db.insert(merchantChannels).values({
      merchantId: merchant.id,
      channel: 'whatsapp',
      channelAccountId: 'wa-1',
      status: 'connected',
      connectedAt: daysAgo(commercialRules.queue.noFirstOrderAfterDays + 2),
    })

    await reconcileNotifications(db)
    expect(await openNotifications('NO_FIRST_ORDER')).toHaveLength(1)
  })

  it('opens TRIAL_ENDING_NO_VALUE for a trial about to lapse with no orders', async () => {
    const db = getTestDb()
    await createStaff(db, { role: 'admin' })
    await createMerchant(db, {
      subscriptionStatus: 'trialing',
      trialEndsAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
    })

    await reconcileNotifications(db)
    expect(await openNotifications('TRIAL_ENDING_NO_VALUE')).toHaveLength(1)
  })

  it('opens PAST_DUE on a billing failure', async () => {
    const db = getTestDb()
    await createStaff(db, { role: 'admin' })
    await createMerchant(db, { subscriptionStatus: 'past_due' })

    await reconcileNotifications(db)
    expect(await openNotifications('PAST_DUE')).toHaveLength(1)
  })

  it('opens PROSPECT_STALE against the owner when nothing has been logged', async () => {
    const db = getTestDb()
    const owner = await createStaff(db, { role: 'member' })
    await createProspect(db, {
      ownerId: owner.id,
      stage: 'CONTACTED',
      createdAt: daysAgo(commercialRules.queue.escalateAfterDaysOfInaction + 2),
    })

    await reconcileNotifications(db)
    const open = await openNotifications('PROSPECT_STALE')
    expect(open).toHaveLength(1)
    expect(open[0].staffId).toBe(owner.id)
  })
})

describe('Notification reconciliation — auto-resolve', () => {
  it('closes NOT_CONNECTED by itself once the merchant connects', async () => {
    const db = getTestDb()
    await createStaff(db, { role: 'admin' })
    const merchant = await staleUnconnectedMerchant()

    await reconcileNotifications(db)
    expect(await openNotifications('NOT_CONNECTED')).toHaveLength(1)

    // The merchant connects overnight. Nobody touches the notification.
    await db.insert(merchantChannels).values({
      merchantId: merchant.id,
      channel: 'whatsapp',
      channelAccountId: 'wa-1',
      status: 'connected',
    })

    const result = await reconcileNotifications(db)

    // This is the difference between a queue people check and one they mute.
    expect(result.resolved).toBe(1)
    expect(await openNotifications('NOT_CONNECTED')).toHaveLength(0)
  })

  it('closes PAST_DUE when billing recovers', async () => {
    const db = getTestDb()
    await createStaff(db, { role: 'admin' })
    const merchant = await createMerchant(db, { subscriptionStatus: 'past_due' })

    await reconcileNotifications(db)
    expect(await openNotifications('PAST_DUE')).toHaveLength(1)

    await db
      .update(merchants)
      .set({ subscriptionStatus: 'active' })
      .where(eq(merchants.id, merchant.id))

    await reconcileNotifications(db)
    expect(await openNotifications('PAST_DUE')).toHaveLength(0)
  })

  it('closes PROSPECT_STALE as soon as the rep logs a touch', async () => {
    const db = getTestDb()
    const owner = await createStaff(db, { role: 'member' })
    const prospect = await createProspect(db, {
      ownerId: owner.id,
      stage: 'CONTACTED',
      createdAt: daysAgo(commercialRules.queue.escalateAfterDaysOfInaction + 2),
    })

    await reconcileNotifications(db)
    expect(await openNotifications('PROSPECT_STALE')).toHaveLength(1)

    await db.insert(prospectActivities).values({
      prospectId: prospect.id,
      staffId: owner.id,
      type: 'call',
      body: 'Spoke to them, following up Friday',
    })

    await reconcileNotifications(db)
    expect(await openNotifications('PROSPECT_STALE')).toHaveLength(0)
  })

  it('reopens after a resolved condition returns', async () => {
    const db = getTestDb()
    await createStaff(db, { role: 'admin' })
    const merchant = await staleUnconnectedMerchant()

    await reconcileNotifications(db)
    const [channel] = await db
      .insert(merchantChannels)
      .values({
        merchantId: merchant.id,
        channel: 'whatsapp',
        channelAccountId: 'wa-1',
        status: 'connected',
      })
      .returning()
    await reconcileNotifications(db)
    expect(await openNotifications('NOT_CONNECTED')).toHaveLength(0)

    // Channel drops. The partial unique index only covers OPEN rows, so a new
    // one can be opened alongside the resolved one.
    await db
      .update(merchantChannels)
      .set({ status: 'disconnected' })
      .where(eq(merchantChannels.id, channel.id))

    await reconcileNotifications(db)
    expect(await openNotifications('NOT_CONNECTED')).toHaveLength(1)
  })
})

describe('Feed notifications', () => {
  it('emits FIRST_VALUE already resolved so it never badges the bell', async () => {
    const db = getTestDb()
    await createStaff(db, { role: 'admin' })
    const merchant = await createMerchant(db)
    const convo = await createConversation(db, merchant.id)
    await db.insert(orders).values({
      merchantId: merchant.id,
      conversationId: convo.id,
      customerPhone: '+2348030000000',
      status: 'CONFIRMED',
      subtotal: '5000.00',
      total: '5000.00',
    })

    const sweep = await runLifecycleSweep(db)
    const emitted = await emitFeedNotifications(db, sweep.transitions)

    expect(emitted).toBeGreaterThan(0)
    const rows = await db
      .select()
      .from(staffNotifications)
      .where(eq(staffNotifications.kind, 'FIRST_VALUE'))
    expect(rows).toHaveLength(1)
    expect(rows[0].tier).toBe('feed')
    // If celebrations badged the bell, the badge would stop meaning "something
    // needs doing" inside a week.
    expect(rows[0].resolvedAt).not.toBeNull()
  })

  it('emits nothing for transitions that are not celebrations', async () => {
    const db = getTestDb()
    await createStaff(db, { role: 'admin' })
    await createMerchant(db)

    const sweep = await runLifecycleSweep(db)
    expect(sweep.transitions.map((t) => t.to)).toEqual(['SIGNED_UP'])
    expect(await emitFeedNotifications(db, sweep.transitions)).toBe(0)
  })
})

describe('Escalation', () => {
  it('escalates to an admin when nobody has logged anything', async () => {
    const db = getTestDb()
    const admin = await createStaff(db, { role: 'admin' })
    const rep = await createStaff(db, { role: 'member' })
    const prospect = await createProspect(db, {
      ownerId: rep.id,
      stage: 'CONTACTED',
      createdAt: daysAgo(30),
    })

    // An old, unworked action item.
    await db.insert(staffNotifications).values({
      staffId: rep.id,
      tier: 'action',
      kind: 'PROSPECT_STALE',
      prospectId: prospect.id,
      body: 'Something needs doing',
      createdAt: daysAgo(commercialRules.queue.escalateAfterDaysOfInaction + 1),
    })

    const created = await escalateStaleNotifications(db)

    expect(created).toBe(1)
    const esc = await db
      .select()
      .from(staffNotifications)
      .where(eq(staffNotifications.kind, 'ESCALATION'))
    expect(esc).toHaveLength(1)
    // To the admin — never a nag back to the owner.
    expect(esc[0].staffId).toBe(admin.id)
  })

  it('does NOT escalate when the rep has logged activity, even with no outcome', async () => {
    const db = getTestDb()
    await createStaff(db, { role: 'admin' })
    const rep = await createStaff(db, { role: 'member' })
    const prospect = await createProspect(db, {
      ownerId: rep.id,
      stage: 'CONTACTED',
      createdAt: daysAgo(30),
    })

    await db.insert(staffNotifications).values({
      staffId: rep.id,
      tier: 'action',
      kind: 'PROSPECT_STALE',
      prospectId: prospect.id,
      body: 'Something needs doing',
      createdAt: daysAgo(commercialRules.queue.escalateAfterDaysOfInaction + 1),
    })

    await db.insert(prospectActivities).values({
      prospectId: prospect.id,
      staffId: rep.id,
      type: 'call',
      body: 'Called twice, they keep rescheduling',
      occurredAt: new Date(),
    })

    // The merchant hasn't moved, but the rep is working it. Escalating here
    // would punish someone for a prospect who won't budge — which is exactly
    // how this turns into surveillance.
    expect(await escalateStaleNotifications(db)).toBe(0)
  })

  it('escalates once, not every tick', async () => {
    const db = getTestDb()
    await createStaff(db, { role: 'admin' })
    const rep = await createStaff(db, { role: 'member' })
    const prospect = await createProspect(db, { ownerId: rep.id, createdAt: daysAgo(30) })

    await db.insert(staffNotifications).values({
      staffId: rep.id,
      tier: 'action',
      kind: 'PROSPECT_STALE',
      prospectId: prospect.id,
      body: 'Something needs doing',
      createdAt: daysAgo(commercialRules.queue.escalateAfterDaysOfInaction + 1),
    })

    expect(await escalateStaleNotifications(db)).toBe(1)
    expect(await escalateStaleNotifications(db)).toBe(0)
  })
})
