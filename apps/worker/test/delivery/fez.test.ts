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
    it('returns a quoted fee when FEZ responds with a totalCost — no quote id, FEZ has none', async () => {
      global.fetch = jest.fn(async () => new Response(JSON.stringify({
        cost: { cost: 3200, state: 'FCT' }, vat: { vatAmount: 300, vatPercent: 7.5 }, totalCost: 3500,
      }), { status: 200 })) as unknown as typeof fetch

      const result = await quote(quoteInput)
      expect(result).toEqual({ status: 'quoted', feeKobo: 350000 })
    })

    it('sends the state-to-state fields FEZ actually expects, not addresses', async () => {
      const fetchMock = jest.fn(async () => new Response(JSON.stringify({ totalCost: 1000 }), { status: 200 }))
      global.fetch = fetchMock as unknown as typeof fetch

      await quote(quoteInput)

      const [url, init] = fetchMock.mock.calls[0]
      expect(url).toBe('https://apisandbox.fezdelivery.co/v1/order/cost')
      expect(JSON.parse(init.body as string)).toEqual({ state: 'FCT', pickUpState: 'Lagos' })
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

    it('returns error when the response is missing totalCost', async () => {
      global.fetch = jest.fn(async () => new Response(JSON.stringify({ cost: { cost: 3200 } }), { status: 200 })) as unknown as typeof fetch
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
    const orderInput = { ...quoteInput, fulfilmentId: 'fulfilment-1', providerQuoteId: '', customerPhone: '+2348012345678', customerName: 'Jane' }

    it('returns booked with the provider order id looked up from orderNos by our fulfilmentId', async () => {
      global.fetch = jest.fn(async () => new Response(JSON.stringify({
        orderNos: { 'fulfilment-1': 'FEZ-123' },
      }), { status: 200 })) as unknown as typeof fetch

      const result = await createOrder(orderInput)
      expect(result).toEqual({ status: 'booked', providerOrderId: 'FEZ-123' })
    })

    it('sends fulfilmentId as uniqueID and the flat field names FEZ expects, not nested pickup/dropoff objects', async () => {
      const fetchMock = jest.fn(async () => new Response(JSON.stringify({ orderNos: { 'fulfilment-1': 'FEZ-123' } }), { status: 200 }))
      global.fetch = fetchMock as unknown as typeof fetch

      await createOrder(orderInput)

      const [url, init] = fetchMock.mock.calls[0]
      expect(url).toBe('https://apisandbox.fezdelivery.co/v1/order')
      const body = JSON.parse(init.body as string)
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
      global.fetch = jest.fn(async () => new Response('down', { status: 503 })) as unknown as typeof fetch
      const result = await createOrder(orderInput)
      expect(result.status).toBe('retryable')
    })

    it('returns error (not retryable) on a 4xx response', async () => {
      global.fetch = jest.fn(async () => new Response(JSON.stringify({ message: 'bad request' }), { status: 422 })) as unknown as typeof fetch
      const result = await createOrder(orderInput)
      expect(result.status).toBe('error')
    })

    it('returns error when orderNos has no entry for our fulfilmentId', async () => {
      global.fetch = jest.fn(async () => new Response(JSON.stringify({ orderNos: {} }), { status: 200 })) as unknown as typeof fetch
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
    it('reads orderStatus out of the orderDetails array, not a top-level field', async () => {
      global.fetch = jest.fn(async () => new Response(JSON.stringify({
        orderDetails: [{ orderStatus: 'in_transit' }],
      }), { status: 200 })) as unknown as typeof fetch
      const result = await getStatus('FEZ-123')
      expect(result).toEqual({ status: 'in_transit', raw: 'in_transit' })
    })

    it('maps "Delivered" (confirmed verbatim from FEZ\'s own webhook example)', async () => {
      global.fetch = jest.fn(async () => new Response(JSON.stringify({
        orderDetails: [{ orderStatus: 'Delivered' }],
      }), { status: 200 })) as unknown as typeof fetch
      const result = await getStatus('FEZ-123')
      expect(result.status).toBe('delivered')
    })

    it('falls back to pending for an unrecognized raw status rather than guessing', async () => {
      global.fetch = jest.fn(async () => new Response(JSON.stringify({
        orderDetails: [{ orderStatus: 'something_new_fez_added' }],
      }), { status: 200 })) as unknown as typeof fetch
      const result = await getStatus('FEZ-123')
      expect(result.status).toBe('pending')
    })

    it('falls back to pending when orderDetails is empty', async () => {
      global.fetch = jest.fn(async () => new Response(JSON.stringify({ orderDetails: [] }), { status: 200 })) as unknown as typeof fetch
      const result = await getStatus('FEZ-123')
      expect(result.status).toBe('pending')
    })
  })

  describe('cancelOrder', () => {
    it('posts orderNo + reason to /order/cancel and returns cancelled on success', async () => {
      const fetchMock = jest.fn(async () => new Response(JSON.stringify({ status: 'Success' }), { status: 200 }))
      global.fetch = fetchMock as unknown as typeof fetch

      const result = await cancelOrder('FEZ-123', 'Customer changed their mind')

      expect(result.status).toBe('cancelled')
      const [url, init] = fetchMock.mock.calls[0]
      expect(url).toBe('https://apisandbox.fezdelivery.co/v1/order/cancel')
      expect(JSON.parse(init.body as string)).toEqual({ orderNo: 'FEZ-123', reason: 'Customer changed their mind' })
    })

    it('returns retryable on a 5xx response', async () => {
      global.fetch = jest.fn(async () => new Response('down', { status: 500 })) as unknown as typeof fetch
      const result = await cancelOrder('FEZ-123')
      expect(result.status).toBe('retryable')
    })
  })
})
