import { quote, createTask, getStatus, cancelTask } from '../../src/delivery/kwik'
import { getTestRedis, flushTestRedis } from '@test-helpers/redis'

describe('Kwik delivery adapter', () => {
  const originalEmail = process.env.KWIK_VENDOR_EMAIL
  const originalPassword = process.env.KWIK_VENDOR_PASSWORD
  let redis: ReturnType<typeof getTestRedis>

  const quoteInput = { pickupAddress: '1 Admiralty Way, Lekki', pickupState: 'Lagos', dropoffAddress: '5 Adeola Odeku', dropoffState: 'Lagos' }

  beforeEach(async () => {
    redis = getTestRedis()
    await flushTestRedis()
    process.env.KWIK_VENDOR_EMAIL = 'vendor@mesa.test'
    process.env.KWIK_VENDOR_PASSWORD = 'test-password'
  })

  afterAll(async () => {
    process.env.KWIK_VENDOR_EMAIL = originalEmail
    process.env.KWIK_VENDOR_PASSWORD = originalPassword
  })

  function mockFetch(handlers: { login?: () => Response; target?: (url: string, init: RequestInit) => Response }) {
    return jest.fn(async (url: string, init: RequestInit) => {
      if (url.includes('/vendor_login')) {
        return handlers.login ? handlers.login() : new Response(JSON.stringify({ access_token: 'tok-1' }), { status: 200 })
      }
      return handlers.target ? handlers.target(url, init) : new Response('{}', { status: 200 })
    }) as unknown as typeof fetch
  }

  describe('quote', () => {
    it('logs in and returns a quoted fee', async () => {
      global.fetch = mockFetch({
        target: () => new Response(JSON.stringify({ total: 1200, task_id: 'kwik-q-1' }), { status: 200 }),
      })
      const result = await quote(redis, quoteInput)
      expect(result.status).toBe('quoted')
      expect(result.feeKobo).toBe(120000)
      expect(result.providerQuoteId).toBe('kwik-q-1')
    })

    it('returns unavailable when vendor credentials are not configured', async () => {
      delete process.env.KWIK_VENDOR_EMAIL
      const fetchMock = jest.fn()
      global.fetch = fetchMock as unknown as typeof fetch
      const result = await quote(redis, quoteInput)
      expect(result.status).toBe('unavailable')
      expect(fetchMock).not.toHaveBeenCalled()
    })

    it('caches the access token across calls — only logs in once', async () => {
      const loginMock = jest.fn(() => new Response(JSON.stringify({ access_token: 'tok-1' }), { status: 200 }))
      global.fetch = mockFetch({
        login: loginMock,
        target: () => new Response(JSON.stringify({ total: 1000 }), { status: 200 }),
      })
      await quote(redis, quoteInput)
      await quote(redis, quoteInput)
      expect(loginMock).toHaveBeenCalledTimes(1)
    })

    it('re-logs-in and retries once when the cached token has expired (401)', async () => {
      await redis.set('kwik:access_token', 'stale-token', 'EX', 60)
      const loginMock = jest.fn(() => new Response(JSON.stringify({ access_token: 'fresh-token' }), { status: 200 }))
      let targetCalls = 0
      global.fetch = mockFetch({
        login: loginMock,
        target: () => {
          targetCalls++
          if (targetCalls === 1) return new Response('unauthorized', { status: 401 })
          return new Response(JSON.stringify({ total: 1000 }), { status: 200 })
        },
      })
      const result = await quote(redis, quoteInput)
      expect(result.status).toBe('quoted')
      expect(loginMock).toHaveBeenCalledTimes(1)
      expect(targetCalls).toBe(2)
    })

    it('returns unavailable on a 5xx quote response', async () => {
      global.fetch = mockFetch({ target: () => new Response('down', { status: 502 }) })
      const result = await quote(redis, quoteInput)
      expect(result.status).toBe('unavailable')
    })

    it('returns error on a 4xx quote response', async () => {
      global.fetch = mockFetch({ target: () => new Response('bad request', { status: 400 }) })
      const result = await quote(redis, quoteInput)
      expect(result.status).toBe('error')
    })
  })

  describe('createTask', () => {
    const orderInput = { ...quoteInput, providerQuoteId: 'kwik-q-1', customerPhone: '+2348012345678' }

    it('returns booked with the provider task id on success', async () => {
      global.fetch = mockFetch({
        target: () => new Response(JSON.stringify({ task_id: 'kwik-task-1', tracking_url: 'https://kwik.delivery/track/1' }), { status: 200 }),
      })
      const result = await createTask(redis, orderInput)
      expect(result).toEqual({ status: 'booked', providerOrderId: 'kwik-task-1', trackingUrl: 'https://kwik.delivery/track/1' })
    })

    it('returns retryable on a 5xx response', async () => {
      global.fetch = mockFetch({ target: () => new Response('down', { status: 503 }) })
      const result = await createTask(redis, orderInput)
      expect(result.status).toBe('retryable')
    })

    it('returns retryable when login itself is unavailable (never drops the confirmation silently)', async () => {
      delete process.env.KWIK_VENDOR_EMAIL
      const result = await createTask(redis, orderInput)
      expect(result.status).toBe('retryable')
    })
  })

  describe('getStatus', () => {
    it('maps a known raw status', async () => {
      global.fetch = mockFetch({ target: () => new Response(JSON.stringify({ status: 'in-progress' }), { status: 200 }) })
      const result = await getStatus(redis, 'kwik-task-1')
      expect(result.status).toBe('in_transit')
    })

    it('falls back to pending on an unrecognized status', async () => {
      global.fetch = mockFetch({ target: () => new Response(JSON.stringify({ status: 'kwik_added_this_later' }), { status: 200 }) })
      const result = await getStatus(redis, 'kwik-task-1')
      expect(result.status).toBe('pending')
    })
  })

  describe('cancelTask', () => {
    it('returns cancelled on success', async () => {
      global.fetch = mockFetch({ target: () => new Response(JSON.stringify({ ok: true }), { status: 200 }) })
      const result = await cancelTask(redis, 'kwik-task-1')
      expect(result.status).toBe('cancelled')
    })
  })
})
