import { quote, createOrder, getStatus, cancelOrder } from '../../src/delivery/fez'

describe('FEZ delivery adapter', () => {
  const originalFetch = global.fetch
  const originalAuthToken = process.env.FEZ_AUTH_TOKEN
  const originalSecretKey = process.env.FEZ_SECRET_KEY

  beforeEach(() => {
    process.env.FEZ_AUTH_TOKEN = 'test-token'
    process.env.FEZ_SECRET_KEY = 'test-secret'
  })

  afterEach(() => {
    global.fetch = originalFetch
    process.env.FEZ_AUTH_TOKEN = originalAuthToken
    process.env.FEZ_SECRET_KEY = originalSecretKey
  })

  const quoteInput = {
    pickupAddress: '1 Admiralty Way, Lekki',
    pickupState: 'Lagos',
    dropoffAddress: '10 Wuse Zone 2',
    dropoffState: 'FCT',
  }

  describe('quote', () => {
    it('returns a quoted fee when FEZ responds with a total', async () => {
      global.fetch = jest.fn(async () => new Response(JSON.stringify({
        total: 3500, quoteId: 'q-1', expiresAt: '2026-08-24T00:00:00Z',
      }), { status: 200 })) as unknown as typeof fetch

      const result = await quote(quoteInput)
      expect(result).toEqual({ status: 'quoted', feeKobo: 350000, providerQuoteId: 'q-1', expiresAt: '2026-08-24T00:00:00Z' })
    })

    it('returns unavailable when credentials are not configured — no network call', async () => {
      delete process.env.FEZ_AUTH_TOKEN
      const fetchMock = jest.fn()
      global.fetch = fetchMock as unknown as typeof fetch

      const result = await quote(quoteInput)
      expect(result).toEqual({ status: 'unavailable' })
      expect(fetchMock).not.toHaveBeenCalled()
    })

    it('returns unavailable (not a hard error) on a 5xx response — retry-worthy', async () => {
      global.fetch = jest.fn(async () => new Response('server error', { status: 502 })) as unknown as typeof fetch
      const result = await quote(quoteInput)
      expect(result.status).toBe('unavailable')
    })

    it('returns error on a 4xx response', async () => {
      global.fetch = jest.fn(async () => new Response(JSON.stringify({ message: 'bad request' }), { status: 400 })) as unknown as typeof fetch
      const result = await quote(quoteInput)
      expect(result.status).toBe('error')
    })

    it('returns unavailable when the fetch itself throws (network failure)', async () => {
      global.fetch = jest.fn(async () => { throw new Error('ECONNRESET') }) as unknown as typeof fetch
      const result = await quote(quoteInput)
      expect(result.status).toBe('unavailable')
    })
  })

  describe('createOrder', () => {
    const orderInput = { ...quoteInput, providerQuoteId: 'q-1', customerPhone: '+2348012345678' }

    it('returns booked with the provider order id on success', async () => {
      global.fetch = jest.fn(async () => new Response(JSON.stringify({
        orderNumber: 'FEZ-123', trackingUrl: 'https://fezdelivery.co/track/FEZ-123',
      }), { status: 200 })) as unknown as typeof fetch

      const result = await createOrder(orderInput)
      expect(result).toEqual({ status: 'booked', providerOrderId: 'FEZ-123', trackingUrl: 'https://fezdelivery.co/track/FEZ-123' })
    })

    it('returns retryable on a 5xx response — must not drop the merchant\'s confirmation', async () => {
      global.fetch = jest.fn(async () => new Response('down', { status: 503 })) as unknown as typeof fetch
      const result = await createOrder(orderInput)
      expect(result.status).toBe('retryable')
    })

    it('returns error (not retryable) on a 4xx response — e.g. an expired quote', async () => {
      global.fetch = jest.fn(async () => new Response(JSON.stringify({ message: 'quote expired' }), { status: 422 })) as unknown as typeof fetch
      const result = await createOrder(orderInput)
      expect(result.status).toBe('error')
    })

    it('returns retryable when the request throws', async () => {
      global.fetch = jest.fn(async () => { throw new Error('timeout') }) as unknown as typeof fetch
      const result = await createOrder(orderInput)
      expect(result.status).toBe('retryable')
    })
  })

  describe('getStatus', () => {
    it('maps a known raw status to the shared status enum', async () => {
      global.fetch = jest.fn(async () => new Response(JSON.stringify({ orderStatus: 'in_transit' }), { status: 200 })) as unknown as typeof fetch
      const result = await getStatus('FEZ-123')
      expect(result).toEqual({ status: 'in_transit', raw: 'in_transit' })
    })

    it('maps delivered', async () => {
      global.fetch = jest.fn(async () => new Response(JSON.stringify({ orderStatus: 'delivered' }), { status: 200 })) as unknown as typeof fetch
      const result = await getStatus('FEZ-123')
      expect(result.status).toBe('delivered')
    })

    it('falls back to pending for an unrecognized raw status rather than guessing', async () => {
      global.fetch = jest.fn(async () => new Response(JSON.stringify({ orderStatus: 'something_new_fez_added' }), { status: 200 })) as unknown as typeof fetch
      const result = await getStatus('FEZ-123')
      expect(result.status).toBe('pending')
    })
  })

  describe('cancelOrder', () => {
    it('returns cancelled on success', async () => {
      global.fetch = jest.fn(async () => new Response(null, { status: 204 })) as unknown as typeof fetch
      const result = await cancelOrder('FEZ-123')
      expect(result.status).toBe('cancelled')
    })

    it('returns retryable on a 5xx response', async () => {
      global.fetch = jest.fn(async () => new Response('down', { status: 500 })) as unknown as typeof fetch
      const result = await cancelOrder('FEZ-123')
      expect(result.status).toBe('retryable')
    })
  })
})
