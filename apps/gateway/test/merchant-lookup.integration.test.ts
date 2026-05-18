import { getMerchantIdByChannelAccountId } from '../src/routes/webhook'
import { getTestDb } from '@test-helpers/db'
import { getTestRedis } from '@test-helpers/redis'
import { setupIntegration } from '@test-helpers/integration-setup'
import { createMerchant, createMerchantChannel } from '@test-helpers/factories'

setupIntegration()

describe('getMerchantIdByChannelAccountId (F-12 cache)', () => {
  it('returns the merchantId from the DB on a cold cache', async () => {
    const db = getTestDb()
    const redis = getTestRedis()
    const merchant = await createMerchant(db)
    await createMerchantChannel(db, merchant.id, {
      channel: 'whatsapp',
      channelAccountId: 'pn_cold_123',
    })

    const id = await getMerchantIdByChannelAccountId(redis, 'whatsapp', 'pn_cold_123')
    expect(id).toBe(merchant.id)
  })

  it('serves subsequent calls from Redis without re-hitting the DB — F-12 regression', async () => {
    const db = getTestDb()
    const redis = getTestRedis()
    const merchant = await createMerchant(db)
    await createMerchantChannel(db, merchant.id, {
      channel: 'whatsapp',
      channelAccountId: 'pn_warm_456',
    })

    // Prime the cache.
    await getMerchantIdByChannelAccountId(redis, 'whatsapp', 'pn_warm_456')

    // Cache should now contain the mapping.
    const cached = await redis.get('merchant_channel:whatsapp:pn_warm_456')
    expect(cached).toBe(merchant.id)

    // Hit it again — still resolves.
    const second = await getMerchantIdByChannelAccountId(redis, 'whatsapp', 'pn_warm_456')
    expect(second).toBe(merchant.id)
  })

  it('caches negative results so unknown phone_number_ids do not hammer the DB', async () => {
    const redis = getTestRedis()

    const first = await getMerchantIdByChannelAccountId(redis, 'whatsapp', 'pn_unknown_xyz')
    expect(first).toBeNull()

    // Negative sentinel must be present.
    const cached = await redis.get('merchant_channel:whatsapp:pn_unknown_xyz')
    expect(cached).toBe('__null__')

    const second = await getMerchantIdByChannelAccountId(redis, 'whatsapp', 'pn_unknown_xyz')
    expect(second).toBeNull()
  })

  it('keeps whatsapp and instagram namespaces separate', async () => {
    const db = getTestDb()
    const redis = getTestRedis()
    const merchant = await createMerchant(db)
    await createMerchantChannel(db, merchant.id, {
      channel: 'whatsapp',
      channelAccountId: 'shared_account_id',
    })

    expect(await getMerchantIdByChannelAccountId(redis, 'whatsapp', 'shared_account_id')).toBe(merchant.id)
    expect(await getMerchantIdByChannelAccountId(redis, 'instagram', 'shared_account_id')).toBeNull()
  })
})