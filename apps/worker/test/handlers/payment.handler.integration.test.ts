// Mock the AI module — we don't want to call Anthropic in tests.
const extractMock = jest.fn()
jest.mock('@mesa/ai', () => ({
  extractPaymentDetails: (...args: unknown[]) => extractMock(...args),
  OCR_CONFIDENCE_THRESHOLD: 0.75,
  HAIKU_ESCALATION_THRESHOLD: 0.85,
}))

// Mock Mono.
const monoValidateMock = jest.fn()
jest.mock('../../src/payments/mono', () => ({
  validate: (...args: unknown[]) => monoValidateMock(...args),
}))

import { eq } from 'drizzle-orm'
import { payments, agentTasks } from '@mesa/db'
import { PaymentHandler } from '../../src/handlers/payment.handler'
import { PendingDecisions } from '../../src/handlers/pending-decisions'
import { AiQuota, lagosDateKey } from '../../src/ai/quota'
import { getTestDb } from '@test-helpers/db'
import { getTestRedis } from '@test-helpers/redis'
import { setupIntegration } from '@test-helpers/integration-setup'
import { createMerchant, createOrder, createPayment } from '@test-helpers/factories'

setupIntegration()

beforeEach(() => {
  extractMock.mockReset()
  monoValidateMock.mockReset()
})

function buildHandler() {
  const db = getTestDb()
  const redis = getTestRedis()
  const natsPublish = jest.fn().mockResolvedValue(undefined)
  const nats = { publish: natsPublish } as never
  const pending = new PendingDecisions(db, redis)
  const aiQuota = new AiQuota(db, redis)
  const handler = new PaymentHandler(db, nats, console, undefined, redis, pending, aiQuota)
  return { handler, natsPublish, db, redis }
}

describe('PaymentHandler.handle (F-5 / F-10 integration)', () => {
  it('skips processing on duplicate screenshot hash (F-5 idempotency)', async () => {
    const { handler, db } = buildHandler()
    const merchant = await createMerchant(db)
    const order = await createOrder(db, merchant.id, { total: '5000', subtotal: '5000' })
    await createPayment(db, order.id, merchant.id, {
      screenshotHash: 'sha-dup',
      status: 'CONFIRMED',
    })

    await handler.handle({
      subject: 'mesa.payment.screenshot_received',
      orderId: order.id,
      merchantId: merchant.id,
      screenshotUrl: 'https://r2/dup.png',
      screenshotHash: 'sha-dup',
    })

    // extractMock should NOT have been called.
    expect(extractMock).not.toHaveBeenCalled()
  })

  it('auto-confirms when high-confidence OCR + Mono validation succeeds', async () => {
    const { handler, natsPublish, db } = buildHandler()
    const merchant = await createMerchant(db, { config: { monoAccountId: 'mono-acct-1' } })
    const order = await createOrder(db, merchant.id, { total: '5000', subtotal: '5000' })

    extractMock.mockResolvedValueOnce({
      amount: 5000,
      reference: 'REF-OK',
      confidence: 0.9,
      rawText: '',
    })
    monoValidateMock.mockResolvedValueOnce({ status: 'confirmed' })

    await handler.handle({
      subject: 'mesa.payment.screenshot_received',
      orderId: order.id,
      merchantId: merchant.id,
      screenshotUrl: 'https://r2/ok.png',
      screenshotHash: 'sha-ok',
    })

    const [pay] = await db.query.payments.findMany({ where: eq(payments.orderId, order.id) })
    expect(pay.status).toBe('CONFIRMED')
    expect(pay.confirmedAt).not.toBeNull()

    const subjects = natsPublish.mock.calls.map(c => (c[0] as { subject: string }).subject)
    expect(subjects).toContain('mesa.payment.confirmed')
  })

  it('routes to manual review when merchant has no Mono account — F-5 regression (Mono required)', async () => {
    const { handler, natsPublish, db } = buildHandler()
    const merchant = await createMerchant(db) // no monoAccountId in config
    const order = await createOrder(db, merchant.id, { total: '5000', subtotal: '5000' })

    extractMock.mockResolvedValueOnce({
      amount: 5000,
      reference: 'REF-MONOLESS',
      confidence: 0.95,
      rawText: '',
    })

    await handler.handle({
      subject: 'mesa.payment.screenshot_received',
      orderId: order.id,
      merchantId: merchant.id,
      screenshotUrl: 'https://r2/x.png',
      screenshotHash: 'sha-monoless',
    })

    // Mono was NEVER called (no monoAccountId).
    expect(monoValidateMock).not.toHaveBeenCalled()

    const [pay] = await db.query.payments.findMany({ where: eq(payments.orderId, order.id) })
    expect(pay.status).toBe('PENDING')

    // A PENDING_PAYMENT_REVIEW task should exist with reason mono_required.
    const tasks = await db.query.agentTasks.findMany({
      where: eq(agentTasks.merchantId, merchant.id),
    })
    expect(tasks).toHaveLength(1)
    expect((tasks[0].payload as { reason: string }).reason).toBe('mono_required')

    // PAYMENT_CONFIRMED should NOT have been published.
    const subjects = natsPublish.mock.calls.map(c => (c[0] as { subject: string }).subject)
    expect(subjects).not.toContain('mesa.payment.confirmed')
  })

  it('blocks auto-confirm when the reference is already in a CONFIRMED payment — F-5 regression', async () => {
    const { handler, natsPublish, db } = buildHandler()

    // Prior CONFIRMED payment with reference REUSED for some other merchant.
    const otherMerchant = await createMerchant(db)
    const otherOrder = await createOrder(db, otherMerchant.id)
    await createPayment(db, otherOrder.id, otherMerchant.id, {
      reference: 'DUPLICATE-REF',
      status: 'CONFIRMED',
      confirmedAt: new Date(),
    })

    const merchant = await createMerchant(db, { config: { monoAccountId: 'mono-acct-2' } })
    const order = await createOrder(db, merchant.id, { total: '5000', subtotal: '5000' })

    extractMock.mockResolvedValueOnce({
      amount: 5000,
      reference: 'DUPLICATE-REF',
      confidence: 0.9,
      rawText: '',
    })

    await handler.handle({
      subject: 'mesa.payment.screenshot_received',
      orderId: order.id,
      merchantId: merchant.id,
      screenshotUrl: 'https://r2/dup-ref.png',
      screenshotHash: 'sha-dup-ref',
    })

    // Mono should NOT have run (fraud guard returned before).
    expect(monoValidateMock).not.toHaveBeenCalled()

    const subjects = natsPublish.mock.calls.map(c => (c[0] as { subject: string }).subject)
    expect(subjects).not.toContain('mesa.payment.confirmed')

    const tasks = await db.query.agentTasks.findMany({
      where: eq(agentTasks.merchantId, merchant.id),
    })
    expect((tasks[0].payload as { reason: string }).reason).toBe('reference_reused')
  })

  it('flags amount mismatch for manual review', async () => {
    const { handler, natsPublish, db } = buildHandler()
    const merchant = await createMerchant(db, { config: { monoAccountId: 'mono' } })
    const order = await createOrder(db, merchant.id, { total: '5000', subtotal: '5000' })

    extractMock.mockResolvedValueOnce({
      amount: 4500, // mismatch
      reference: 'REF-MIS',
      confidence: 0.9,
      rawText: '',
    })

    await handler.handle({
      subject: 'mesa.payment.screenshot_received',
      orderId: order.id,
      merchantId: merchant.id,
      screenshotUrl: 'https://r2/mis.png',
      screenshotHash: 'sha-mis',
    })

    const subjects = natsPublish.mock.calls.map(c => (c[0] as { subject: string }).subject)
    expect(subjects).not.toContain('mesa.payment.confirmed')

    const tasks = await db.query.agentTasks.findMany({
      where: eq(agentTasks.merchantId, merchant.id),
    })
    expect((tasks[0].payload as { reason: string }).reason).toBe('amount_mismatch')
  })

  it('low-confidence OCR routes to manual review', async () => {
    const { handler, db } = buildHandler()
    const merchant = await createMerchant(db, { config: { monoAccountId: 'mono' } })
    const order = await createOrder(db, merchant.id, { total: '5000', subtotal: '5000' })

    extractMock.mockResolvedValueOnce({
      amount: 5000,
      reference: 'REF-LOW',
      confidence: 0.4, // below threshold
      rawText: '',
    })

    await handler.handle({
      subject: 'mesa.payment.screenshot_received',
      orderId: order.id,
      merchantId: merchant.id,
      screenshotUrl: 'https://r2/low.png',
      screenshotHash: 'sha-low',
    })

    const tasks = await db.query.agentTasks.findMany({
      where: eq(agentTasks.merchantId, merchant.id),
    })
    expect((tasks[0].payload as { reason: string }).reason).toBe('low_confidence')
  })

  it('AI quota exhausted creates a PENDING payment row + manual review — F-10 regression', async () => {
    const { handler, db, redis } = buildHandler()
    const merchant = await createMerchant(db, {
      subscriptionTier: 'starter',
      config: { monoAccountId: 'mono' },
    })
    const order = await createOrder(db, merchant.id, { total: '5000', subtotal: '5000' })

    // Pre-fill the daily quota with the starter limit (500) so the next call exhausts it.
    const key = `ai_quota:${merchant.id}:${lagosDateKey()}`
    await redis.set(key, '501') // beyond limit

    await handler.handle({
      subject: 'mesa.payment.screenshot_received',
      orderId: order.id,
      merchantId: merchant.id,
      screenshotUrl: 'https://r2/quota.png',
      screenshotHash: 'sha-quota',
    })

    // OCR must NOT have run.
    expect(extractMock).not.toHaveBeenCalled()

    // A minimal PENDING payment row exists so the merchant's eventual YES has
    // something to flip to CONFIRMED.
    const rows = await db.query.payments.findMany({ where: eq(payments.orderId, order.id) })
    expect(rows).toHaveLength(1)
    expect(rows[0].status).toBe('PENDING')

    // Manual review task is queued.
    const tasks = await db.query.agentTasks.findMany({
      where: eq(agentTasks.merchantId, merchant.id),
    })
    expect((tasks[0].payload as { reason: string }).reason).toBe('low_confidence')
  })
})