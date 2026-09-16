import { quote, createOrder, getStatus, cancelOrder } from '../../src/delivery/fez'
import { getTestRedis, flushTestRedis, closeTestRedis } from '@test-helpers/redis'

describe('FEZ delivery adapter', () => {
  const originalUserId = process.env.FEZ_USER_ID
  const originalPassword = process.env.FEZ_PASSWORD
  const originalSecretKey = process.env.FEZ_SECRET_KEY
  let redis: ReturnType<typeof getTestRedis>

  const quoteInput = {
    pickupAddress: '1 Admiralty Way, Lekki',
    pickupState: 'Lagos',
    dropoffAddress: '10 Wuse Zone 2',
    dropoffState: 'FCT',
  }

  beforeEach(async () => {
    redis = getTestRedis()
    await flushTestRedis()
    process.env.FEZ_USER_ID = 'G-0000-0000'
    process.env.FEZ_PASSWORD = 'test-password'
    process.env.FEZ_SECRET_KEY = 'test-secret'
  })

  afterAll(async () => {
    process.env.FEZ_USER_ID = originalUserId
    process.env.FEZ_PASSWORD = originalPassword
    process.env.FEZ_SECRET_KEY = originalSecretKey
    // Needs Redis but not the database, so it doesn't call setupIntegration()
    // — same reasoning as kwik.integration.test.ts: without closing this
    // explicitly, the open ioredis connection keeps the event loop alive
    // and jest hangs after every test has already passed.
    await closeTestRedis()
  })

  function mockFetch(handlers: { login?: () => Response; target?: (url: string, init: RequestInit) => Response }) {
    return jest.fn(async (url: string, init: RequestInit) => {
      if (url.includes('/user/authenticate')) {
        return handlers.login ? handlers.login() : fezLoginResponse('tok-1')
      }
      return handlers.target ? handlers.target(url, init) : new Response('{}', { status: 200 })
    }) as unknown as typeof fetch
  }

  // Matches a real confirmed login response (2026-09-16): the token is
  // nested under authDetails, and expireToken is a literal "YYYY-MM-DD
  // HH:mm:ss" string in Africa/Lagos time, not epoch anything.
  function fezLoginResponse(authToken: string, minutesFromNow = 60): Response {
    const targetUtcMs = Date.now() + minutesFromNow * 60 * 1000
    // The wall-clock Lagos-local reading of that UTC instant (Lagos = UTC+1)
    // — this is the string format FEZ actually sends.
    const lagosWallClockMs = targetUtcMs + 60 * 60 * 1000
    const expireToken = new Date(lagosWallClockMs).toISOString().slice(0, 19).replace('T', ' ')
    return new Response(JSON.stringify({
      status: 'Success', description: 'Login Successful',
      authDetails: { authToken, expireToken, timezone: 'Africa/Lagos' },
    }), { status: 200 })
  }

  describe('quote', () => {
    it('logs in and returns a quoted fee', async () => {
      global.fetch = mockFetch({
        target: () => new Response(JSON.stringify({ totalCost: 3500 }), { status: 200 }),
      })
      const result = await quote(redis, quoteInput)
      expect(result).toEqual({ status: 'quoted', feeKobo: 350000 })
    })

    it('sends the state-to-state fields FEZ actually expects, with both auth headers', async () => {
      let capturedInit: RequestInit | undefined
      global.fetch = mockFetch({
        target: (_url, init) => { capturedInit = init; return new Response(JSON.stringify({ totalCost: 1000 }), { status: 200 }) },
      })
      await quote(redis, quoteInput)
      expect(JSON.parse(capturedInit!.body as string)).toEqual({ state: 'FCT', pickUpState: 'Lagos' })
      const headers = capturedInit!.headers as Record<string, string>
      expect(headers.Authorization).toBe('Bearer tok-1')
      expect(headers['secret-key']).toBe('test-secret')
    })

    it('returns unavailable when login credentials are not configured — no network call', async () => {
      delete process.env.FEZ_USER_ID
      const fetchMock = jest.fn()
      global.fetch = fetchMock as unknown as typeof fetch
      const result = await quote(redis, quoteInput)
      expect(result).toEqual({ status: 'unavailable' })
      expect(fetchMock).not.toHaveBeenCalled()
    })

    it('returns unavailable when the secret key is not configured, even with login credentials present', async () => {
      delete process.env.FEZ_SECRET_KEY
      const fetchMock = jest.fn()
      global.fetch = fetchMock as unknown as typeof fetch
      const result = await quote(redis, quoteInput)
      expect(result).toEqual({ status: 'unavailable' })
      expect(fetchMock).not.toHaveBeenCalled()
    })

    it('caches the access token across calls — only logs in once', async () => {
      const loginMock = jest.fn(() => fezLoginResponse('tok-1'))
      global.fetch = mockFetch({ login: loginMock, target: () => new Response(JSON.stringify({ totalCost: 1000 }), { status: 200 }) })
      await quote(redis, quoteInput)
      await quote(redis, quoteInput)
      expect(loginMock).toHaveBeenCalledTimes(1)
    })

    it('caches the token for roughly the real remaining lifetime, reading expireToken as Africa/Lagos time — not the process\'s own timezone', async () => {
      // A naive `new Date(expireToken)`/`Date.parse` reads this space-separated
      // string in whatever timezone the process happens to run in. If that
      // silently shifted by Lagos's +1h offset, the cached TTL here would be
      // ~2h or ~4h instead of ~3h.
      global.fetch = mockFetch({
        login: () => fezLoginResponse('tok-1', 180), // expires 3h from now
        target: () => new Response(JSON.stringify({ totalCost: 1000 }), { status: 200 }),
      })
      await quote(redis, quoteInput)
      const ttl = await redis.ttl('fez:access_token')
      expect(ttl).toBeGreaterThan(3 * 60 * 60 - 120)
      expect(ttl).toBeLessThan(3 * 60 * 60 + 60)
    })

    it('re-logs-in and retries once when the cached token has expired (401)', async () => {
      await redis.set('fez:access_token', 'stale-token', 'EX', 60)
      const loginMock = jest.fn(() => fezLoginResponse('fresh-token'))
      let targetCalls = 0
      global.fetch = mockFetch({
        login: loginMock,
        target: () => {
          targetCalls++
          if (targetCalls === 1) return new Response('unauthorized', { status: 401 })
          return new Response(JSON.stringify({ totalCost: 1000 }), { status: 200 })
        },
      })
      const result = await quote(redis, quoteInput)
      expect(result.status).toBe('quoted')
      expect(loginMock).toHaveBeenCalledTimes(1)
      expect(targetCalls).toBe(2)
    })

    it('returns unavailable on a 5xx response', async () => {
      global.fetch = mockFetch({ target: () => new Response('server error', { status: 502 }) })
      const result = await quote(redis, quoteInput)
      expect(result.status).toBe('unavailable')
    })

    it('returns error on a 4xx response', async () => {
      global.fetch = mockFetch({ target: () => new Response(JSON.stringify({ message: 'bad request' }), { status: 400 }) })
      const result = await quote(redis, quoteInput)
      expect(result.status).toBe('error')
    })

    it('returns error when the response is missing totalCost', async () => {
      global.fetch = mockFetch({ target: () => new Response(JSON.stringify({ cost: { cost: 3200 } }), { status: 200 }) })
      const result = await quote(redis, quoteInput)
      expect(result.status).toBe('error')
    })
  })

  describe('createOrder', () => {
    const orderInput = { ...quoteInput, fulfilmentId: 'fulfilment-1', providerQuoteId: '', customerPhone: '+2348012345678', customerName: 'Jane' }

    it('returns booked with the provider order id looked up from orderNos by our fulfilmentId', async () => {
      global.fetch = mockFetch({ target: () => new Response(JSON.stringify({ orderNos: { 'fulfilment-1': 'FEZ-123' } }), { status: 200 }) })
      const result = await createOrder(redis, orderInput)
      expect(result).toEqual({ status: 'booked', providerOrderId: 'FEZ-123' })
    })

    it('sends fulfilmentId as uniqueID and the flat field names FEZ expects', async () => {
      let capturedInit: RequestInit | undefined
      global.fetch = mockFetch({
        target: (_url, init) => { capturedInit = init; return new Response(JSON.stringify({ orderNos: { 'fulfilment-1': 'FEZ-123' } }), { status: 200 }) },
      })
      await createOrder(redis, orderInput)
      const body = JSON.parse(capturedInit!.body as string)
      expect(body).toEqual({
        uniqueID: 'fulfilment-1',
        pickUpAddress: '1 Admiralty Way, Lekki',
        pickUpState: 'Lagos',
        recipientAddress: '10 Wuse Zone 2',
        recipientState: 'FCT',
        recipientName: 'Jane',
        recipientPhone: '+2348012345678',
        itemDescription: undefined,
        valueOfItem: undefined,
      })
    })

    it('returns retryable on a 5xx response — must not drop the merchant\'s confirmation', async () => {
      global.fetch = mockFetch({ target: () => new Response('down', { status: 503 }) })
      const result = await createOrder(redis, orderInput)
      expect(result.status).toBe('retryable')
    })

    it('returns error (not retryable) on a 4xx response', async () => {
      global.fetch = mockFetch({ target: () => new Response(JSON.stringify({ message: 'bad request' }), { status: 422 }) })
      const result = await createOrder(redis, orderInput)
      expect(result.status).toBe('error')
    })

    it('returns error when orderNos has no entry for our fulfilmentId', async () => {
      global.fetch = mockFetch({ target: () => new Response(JSON.stringify({ orderNos: {} }), { status: 200 }) })
      const result = await createOrder(redis, orderInput)
      expect(result.status).toBe('error')
    })

    it('returns retryable when login itself is unavailable (never drops the confirmation silently)', async () => {
      delete process.env.FEZ_USER_ID
      const result = await createOrder(redis, orderInput)
      expect(result.status).toBe('retryable')
    })
  })

  describe('getStatus', () => {
    it('reads orderStatus out of the orderDetails array', async () => {
      global.fetch = mockFetch({ target: () => new Response(JSON.stringify({ orderDetails: [{ orderStatus: 'in_transit' }] }), { status: 200 }) })
      const result = await getStatus(redis, 'FEZ-123')
      expect(result).toEqual({ status: 'in_transit', raw: 'in_transit' })
    })

    it('maps "Delivered" (confirmed verbatim from FEZ\'s own webhook example)', async () => {
      global.fetch = mockFetch({ target: () => new Response(JSON.stringify({ orderDetails: [{ orderStatus: 'Delivered' }] }), { status: 200 }) })
      const result = await getStatus(redis, 'FEZ-123')
      expect(result.status).toBe('delivered')
    })

    it('falls back to pending for an unrecognized raw status', async () => {
      global.fetch = mockFetch({ target: () => new Response(JSON.stringify({ orderDetails: [{ orderStatus: 'something_new' }] }), { status: 200 }) })
      const result = await getStatus(redis, 'FEZ-123')
      expect(result.status).toBe('pending')
    })
  })

  describe('cancelOrder', () => {
    it('posts orderNo + reason to /order/cancel and returns cancelled on success', async () => {
      let capturedUrl = ''
      let capturedInit: RequestInit | undefined
      global.fetch = mockFetch({
        target: (url, init) => { capturedUrl = url; capturedInit = init; return new Response(JSON.stringify({ status: 'Success' }), { status: 200 }) },
      })
      const result = await cancelOrder(redis, 'FEZ-123', 'Customer changed their mind')
      expect(result.status).toBe('cancelled')
      expect(capturedUrl).toBe('https://apisandbox.fezdelivery.co/v1/order/cancel')
      expect(JSON.parse(capturedInit!.body as string)).toEqual({ orderNo: 'FEZ-123', reason: 'Customer changed their mind' })
    })

    it('returns retryable on a 5xx response', async () => {
      global.fetch = mockFetch({ target: () => new Response('down', { status: 500 }) })
      const result = await cancelOrder(redis, 'FEZ-123')
      expect(result.status).toBe('retryable')
    })
  })
})
