import { eq } from 'drizzle-orm'
import { merchantChannels } from '@mesa/db'
import { isInstagramTokenRefreshDue, refreshInstagramToken } from '../../src/instagram/token-refresh'
import { getTestDb } from '@test-helpers/db'
import { setupIntegration } from '@test-helpers/integration-setup'
import { createMerchant, createMerchantChannel } from '@test-helpers/factories'

setupIntegration()

describe('isInstagramTokenRefreshDue', () => {
  const now = new Date('2026-07-01T00:00:00Z')

  it('is due when never refreshed', () => {
    expect(isInstagramTokenRefreshDue(null, now)).toBe(true)
  })

  it('is not due when refreshed 10 days ago', () => {
    const tenDaysAgo = new Date(now.getTime() - 10 * 24 * 60 * 60 * 1000)
    expect(isInstagramTokenRefreshDue(tenDaysAgo, now)).toBe(false)
  })

  it('is due once older than 50 days', () => {
    const fiftyOneDaysAgo = new Date(now.getTime() - 51 * 24 * 60 * 60 * 1000)
    expect(isInstagramTokenRefreshDue(fiftyOneDaysAgo, now)).toBe(true)
  })
})

describe('refreshInstagramToken', () => {
  const originalFetch = global.fetch
  afterEach(() => { global.fetch = originalFetch })

  it('updates accessToken and tokenRefreshedAt on success', async () => {
    const db = getTestDb()
    const merchant = await createMerchant(db)
    const channel = await createMerchantChannel(db, merchant.id, {
      channel: 'instagram',
      channelAccountId: 'ig_user_1',
      accessToken: 'stale_token',
    })

    global.fetch = jest.fn(async (url: RequestInfo | URL) => {
      expect(url.toString()).toContain('graph.instagram.com/refresh_access_token')
      expect(url.toString()).toContain('access_token=stale_token')
      return new Response(JSON.stringify({ access_token: 'refreshed_token', expires_in: 5183944 }), { status: 200 })
    }) as jest.MockedFunction<typeof fetch>

    const now = new Date()
    await refreshInstagramToken(db, { id: channel.id, accessToken: 'stale_token' }, now)

    const refreshed = await db.query.merchantChannels.findFirst({ where: eq(merchantChannels.id, channel.id) })
    expect(refreshed?.accessToken).toBe('refreshed_token')
    expect(refreshed?.tokenRefreshedAt?.getTime()).toBe(now.getTime())
  })

  it('throws and does not update the row when Meta rejects the refresh', async () => {
    const db = getTestDb()
    const merchant = await createMerchant(db)
    const channel = await createMerchantChannel(db, merchant.id, {
      channel: 'instagram',
      channelAccountId: 'ig_user_2',
      accessToken: 'revoked_token',
    })

    global.fetch = jest.fn(async () => new Response('invalid token', { status: 400 })) as jest.MockedFunction<typeof fetch>

    await expect(refreshInstagramToken(db, { id: channel.id, accessToken: 'revoked_token' }, new Date()))
      .rejects.toThrow('Instagram token refresh failed')

    const unchanged = await db.query.merchantChannels.findFirst({ where: eq(merchantChannels.id, channel.id) })
    expect(unchanged?.accessToken).toBe('revoked_token')
    expect(unchanged?.tokenRefreshedAt).toBeNull()
  })
})
