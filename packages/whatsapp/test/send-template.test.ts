import { sendTemplate } from '../src/index'

describe('sendTemplate param sanitization (Meta error 132018)', () => {
  const originalFetch = global.fetch

  afterEach(() => {
    global.fetch = originalFetch
    jest.restoreAllMocks()
  })

  it('strips newlines/tabs from body params so multi-item summaries deliver', async () => {
    const fetchMock = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ messages: [{ id: 'wamid.test' }] }),
    })
    global.fetch = fetchMock as unknown as typeof fetch

    await sendTemplate('2348000000000', 'mesa_new_order_v2', [
      'Customer Name',
      '1x Versace slides — ₦25,000\n1x Linen Senator Shirt — ₦48,000',
      '₦73,000',
    ])

    const body = JSON.parse(fetchMock.mock.calls[0][1].body as string)
    const texts = body.template.components[0].parameters.map((p: { text: string }) => p.text)
    for (const text of texts) {
      expect(text).not.toMatch(/[\n\r\t]/)
      expect(text).not.toMatch(/ {3,}/)
    }
    expect(texts[1]).toContain('Versace slides')
    expect(texts[1]).toContain('Linen Senator Shirt')
  })
})
