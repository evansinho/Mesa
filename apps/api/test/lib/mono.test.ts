import { exchangeMonoCode } from '../../src/lib/mono'

describe('exchangeMonoCode', () => {
  const originalFetch = global.fetch

  afterEach(() => {
    global.fetch = originalFetch
  })

  it('extracts the account id from Mono\'s {status, message, data} envelope — real-response regression', async () => {
    global.fetch = jest.fn(async () => new Response(JSON.stringify({
      status: 'successful',
      message: 'Request was succesfully completed',
      timestamp: '2026-08-12T12:57:36.849Z',
      data: { id: '6a7c62c64109eb2355a413bb' },
    }), { status: 200 })) as unknown as typeof fetch

    const accountId = await exchangeMonoCode('a-code')
    expect(accountId).toBe('6a7c62c64109eb2355a413bb')
  })

  it('returns null when the response has no account id', async () => {
    global.fetch = jest.fn(async () => new Response(JSON.stringify({
      status: 'successful',
      data: {},
    }), { status: 200 })) as unknown as typeof fetch

    const accountId = await exchangeMonoCode('a-code')
    expect(accountId).toBeNull()
  })

  it('returns null when Mono rejects the exchange', async () => {
    global.fetch = jest.fn(async () => new Response('bad request', { status: 400 })) as unknown as typeof fetch

    const accountId = await exchangeMonoCode('a-code')
    expect(accountId).toBeNull()
  })
})
