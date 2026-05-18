import { checkReference } from '../../src/payments/fraud-checks'
import { getTestDb } from '@test-helpers/db'
import { setupIntegration } from '@test-helpers/integration-setup'
import { createMerchant, createOrder, createPayment } from '@test-helpers/factories'

setupIntegration()

describe('checkReference (F-5 integration)', () => {
  it('returns ok when reference is empty', async () => {
    const db = getTestDb()
    const merchant = await createMerchant(db)
    const result = await checkReference(db, merchant.id, '')
    expect(result.ok).toBe(true)
  })

  it('returns ok when no prior CONFIRMED payment exists', async () => {
    const db = getTestDb()
    const merchant = await createMerchant(db)
    const result = await checkReference(db, merchant.id, 'NEW-REF-123')
    expect(result.ok).toBe(true)
  })

  it('flags reference_reused_self for same merchant within 72h — F-5 regression', async () => {
    const db = getTestDb()
    const merchant = await createMerchant(db)
    const order = await createOrder(db, merchant.id)
    const prior = await createPayment(db, order.id, merchant.id, {
      reference: 'BANK-REF-A',
      status: 'CONFIRMED',
      confirmedAt: new Date(),
    })

    const result = await checkReference(db, merchant.id, 'BANK-REF-A')
    expect(result.ok).toBe(false)
    expect(result.reason).toBe('reference_reused_self')
    expect(result.conflictingPaymentId).toBe(prior.id)
    expect(result.conflictingMerchantId).toBe(merchant.id)
  })

  it('flags reference_reused_global for a different merchant within 72h — F-5 regression', async () => {
    const db = getTestDb()
    const otherMerchant = await createMerchant(db)
    const otherOrder = await createOrder(db, otherMerchant.id)
    await createPayment(db, otherOrder.id, otherMerchant.id, {
      reference: 'SHARED-REF',
      status: 'CONFIRMED',
      confirmedAt: new Date(),
    })

    const ourMerchant = await createMerchant(db)
    const result = await checkReference(db, ourMerchant.id, 'SHARED-REF')

    expect(result.ok).toBe(false)
    expect(result.reason).toBe('reference_reused_global')
    expect(result.conflictingMerchantId).toBe(otherMerchant.id)
  })

  it('returns ok when prior CONFIRMED payment is older than 72h', async () => {
    const db = getTestDb()
    const merchant = await createMerchant(db)
    const order = await createOrder(db, merchant.id)
    const ancient = new Date(Date.now() - 73 * 60 * 60 * 1000)
    await createPayment(db, order.id, merchant.id, {
      reference: 'OLD-REF',
      status: 'CONFIRMED',
      confirmedAt: ancient,
      createdAt: ancient,
    })

    const result = await checkReference(db, merchant.id, 'OLD-REF')
    expect(result.ok).toBe(true)
  })

  it('does NOT flag against a non-CONFIRMED payment with the same reference', async () => {
    const db = getTestDb()
    const merchant = await createMerchant(db)
    const order = await createOrder(db, merchant.id)
    await createPayment(db, order.id, merchant.id, {
      reference: 'PENDING-REF',
      status: 'PENDING',
    })

    const result = await checkReference(db, merchant.id, 'PENDING-REF')
    expect(result.ok).toBe(true)
  })

  it('excludePaymentId excludes the payment under check (no self-conflict)', async () => {
    const db = getTestDb()
    const merchant = await createMerchant(db)
    const order = await createOrder(db, merchant.id)
    const current = await createPayment(db, order.id, merchant.id, {
      reference: 'SELF-REF',
      status: 'CONFIRMED',
      confirmedAt: new Date(),
    })

    const result = await checkReference(db, merchant.id, 'SELF-REF', current.id)
    expect(result.ok).toBe(true)
  })
})