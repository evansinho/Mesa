import { MESA_TEMPLATE_DEFINITIONS, renderTemplateFallback, renderInstagramNotification, provisionMesaTemplates } from '../src/index'

describe('renderTemplateFallback', () => {
  it('substitutes body params into the order tap body', () => {
    const text = renderTemplateFallback('mesa_new_order_v2', ['John Doe', '1x Jogger Pants — ₦25,000', '₦25,000'])
    expect(text).toContain('New order received')
    expect(text).toContain('Customer: John Doe')
    expect(text).toContain('1x Jogger Pants — ₦25,000')
    expect(text).toContain('Estimated total: ₦25,000')
    expect(text).toContain('ACCEPT')
    expect(text).not.toMatch(/\{\{\d+\}\}/)
  })

  it('returns null for unknown templates', () => {
    expect(renderTemplateFallback('not_a_template', [])).toBeNull()
  })

  it('every runtime template with params has a fallback body', () => {
    for (const name of ['mesa_new_order_v2', 'mesa_payment_needs_confirmation_v2', 'mesa_payment_confirmed', 'mesa_mono_nudge', 'mesa_setup_complete']) {
      expect(MESA_TEMPLATE_DEFINITIONS.find(t => t.name === name)?.bodyText).toBeTruthy()
    }
  })
})

describe('renderInstagramNotification', () => {
  it('renders real tappable quick_replies matching the WhatsApp template button set, for each decision template', () => {
    expect(renderInstagramNotification('mesa_new_order_v2', ['John Doe', '1x Jogger Pants — ₦25,000', '₦25,000'], 'https://app.getmesa.co/actions/abc')).toEqual({
      text: expect.stringContaining('👉 Or open: https://app.getmesa.co/actions/abc'),
      quickReplies: [
        { title: 'Accept', payload: 'accept' },
        { title: 'Reject', payload: 'reject' },
      ],
    })

    expect(renderInstagramNotification('mesa_payment_needs_confirmation_v2', ['ORD-1', 'John Doe', '₦5,000', '₦5,000', 'low_confidence'], 'https://app.getmesa.co/actions/def')?.quickReplies).toEqual([
      { title: 'Confirm', payload: 'confirm_payment' },
      { title: 'Not Yet', payload: 'payment_not_yet' },
      { title: 'Dispute', payload: 'payment_dispute' },
    ])

    expect(renderInstagramNotification('mesa_payment_confirmed', ['ORD-1', 'John Doe', '1x rice', '₦5,000'], 'https://app.getmesa.co/dashboard/orders')?.quickReplies).toEqual([
      { title: 'Book Rider', payload: 'book_rider' },
      { title: 'Self Deliver', payload: 'self_deliver' },
      { title: 'Pickup', payload: 'pickup' },
    ])
  })

  it('strips the WhatsApp "Reply or tap: KEYWORD" instructions since Instagram has real buttons instead', () => {
    const rendered = renderInstagramNotification('mesa_new_order_v2', ['John Doe', '1x rice', '₦5,000'], 'https://app.getmesa.co/actions/abc')
    expect(rendered?.text).not.toContain('Reply or tap')
    expect(rendered?.text).not.toContain('ACCEPT - confirm')
  })

  it('has no quick_replies for templates with no merchant decision to make', () => {
    expect(renderInstagramNotification('mesa_setup_complete', ['Chidi Stores'], 'https://app.getmesa.co')?.quickReplies).toBeUndefined()
  })

  it('returns null for unknown templates', () => {
    expect(renderInstagramNotification('not_a_template', [], 'https://app.getmesa.co')).toBeNull()
  })
})

describe('provisionMesaTemplates', () => {
  const originalFetch = global.fetch
  afterEach(() => { global.fetch = originalFetch })

  it('creates all templates and tolerates already-existing ones', async () => {
    const fetchMock = jest.fn().mockImplementation(async (url: string, init: RequestInit) => {
      const body = JSON.parse(init.body as string)
      if (body.name === 'mesa_new_order_v2') {
        return { ok: false, text: async () => '{"error":{"message":"Message template \\"mesa_new_order_v2\\" already exists","error_subcode":2388023}}' }
      }
      return { ok: true, json: async () => ({ id: 't1' }) }
    })
    global.fetch = fetchMock as unknown as typeof fetch

    const result = await provisionMesaTemplates('123456789', 'token')

    expect(result.existing).toEqual(['mesa_new_order_v2'])
    expect(result.failed).toEqual([])
    expect(result.created.length).toBe(MESA_TEMPLATE_DEFINITIONS.length - 1)
    expect(fetchMock).toHaveBeenCalledTimes(MESA_TEMPLATE_DEFINITIONS.length)
  })
})
