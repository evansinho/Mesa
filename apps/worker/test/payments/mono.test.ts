import { validate } from '../../src/payments/mono'

describe('validate', () => {
  const originalFetch = global.fetch
  const originalSecretKey = process.env.MONO_SECRET_KEY

  beforeEach(() => {
    process.env.MONO_SECRET_KEY = 'test-mono-secret'
  })

  afterEach(() => {
    global.fetch = originalFetch
    process.env.MONO_SECRET_KEY = originalSecretKey
  })

  it('confirms when a credit transaction matches the reference and amount — real-transfer regression', async () => {
    global.fetch = jest.fn(async () => new Response(JSON.stringify({
      data: [
        { narration: 'TRF/09026726081215580611702811041/FROM JOHN DOE', amount: 500000, type: 'credit' },
      ],
    }), { status: 200 })) as unknown as typeof fetch

    const result = await validate('09026726081215580611702811041', 'acc-1', 5000)
    expect(result.status).toBe('confirmed')
  })

  it('returns reference_not_found when no transaction matches yet — allows retry rather than permanent failure', async () => {
    global.fetch = jest.fn(async () => new Response(JSON.stringify({ data: [] }), { status: 200 })) as unknown as typeof fetch

    const result = await validate('some-reference', 'acc-1', 5000)
    expect(result.status).toBe('reference_not_found')
  })

  it('does not confirm on a narration match with the wrong amount', async () => {
    global.fetch = jest.fn(async () => new Response(JSON.stringify({
      data: [
        { narration: 'TRF/some-reference/FROM JOHN DOE', amount: 10000, type: 'credit' },
      ],
    }), { status: 200 })) as unknown as typeof fetch

    const result = await validate('some-reference', 'acc-1', 5000)
    expect(result.status).toBe('reference_not_found')
  })

  it('returns failed when Mono\'s API errors', async () => {
    global.fetch = jest.fn(async () => new Response('server error', { status: 500 })) as unknown as typeof fetch

    const result = await validate('some-reference', 'acc-1', 5000)
    expect(result.status).toBe('failed')
  })
})
