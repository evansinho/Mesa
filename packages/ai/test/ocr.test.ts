// Mock the Anthropic SDK before importing the module under test. The factory
// runs at import time (before the test file's const declarations), so we
// reference messagesCreate lazily through a closure to avoid TDZ.
const messagesCreate = jest.fn()
jest.mock('@anthropic-ai/sdk', () => {
  return {
    __esModule: true,
    default: jest.fn().mockImplementation(() => ({
      messages: {
        create: (...args: unknown[]) => messagesCreate(...args),
      },
    })),
  }
})

// Mock global fetch so the screenshot-download step doesn't hit the network.
global.fetch = jest.fn(async () => ({
  ok: true,
  headers: { get: () => 'image/png' },
  arrayBuffer: async () => new ArrayBuffer(8),
})) as unknown as typeof fetch

import { extractPaymentDetails, HAIKU_ESCALATION_THRESHOLD } from '../src/ocr'

function mockOcrResponse(fields: Record<string, unknown>) {
  return {
    content: [
      {
        type: 'tool_use',
        name: 'extract_payment',
        input: fields,
      },
    ],
  }
}

beforeEach(() => {
  messagesCreate.mockReset()
})

describe('extractPaymentDetails — two-tier OCR (F-10b)', () => {
  it('returns Haiku result without escalation when confidence >= threshold', async () => {
    messagesCreate.mockResolvedValueOnce(
      mockOcrResponse({
        amount: 5000,
        reference: 'REF123',
        confidence: HAIKU_ESCALATION_THRESHOLD,
      }),
    )

    const result = await extractPaymentDetails('https://example/screenshot.png')

    expect(messagesCreate).toHaveBeenCalledTimes(1)
    expect(result.modelUsed).toBe('haiku')
    expect(result.escalated).toBe(false)
    expect(result.amount).toBe(5000)
    expect(result.reference).toBe('REF123')
  })

  it('escalates to Sonnet when Haiku confidence is below threshold', async () => {
    messagesCreate
      .mockResolvedValueOnce(mockOcrResponse({ confidence: 0.7, amount: 4000 })) // Haiku — uncertain
      .mockResolvedValueOnce(
        mockOcrResponse({
          amount: 5000,
          reference: 'REF456',
          confidence: 0.92,
        }),
      ) // Sonnet — authoritative

    const result = await extractPaymentDetails('https://example/screenshot.png')

    expect(messagesCreate).toHaveBeenCalledTimes(2)
    expect(result.modelUsed).toBe('sonnet')
    expect(result.escalated).toBe(true)
    expect(result.amount).toBe(5000)
    expect(result.reference).toBe('REF456')
    expect(result.confidence).toBe(0.92)
  })

  it('treats undefined Haiku confidence as low and escalates', async () => {
    messagesCreate
      .mockResolvedValueOnce(mockOcrResponse({ amount: 4000 })) // Haiku — no confidence field
      .mockResolvedValueOnce(mockOcrResponse({ amount: 4000, confidence: 0.9 }))

    const result = await extractPaymentDetails('https://example/screenshot.png')

    expect(messagesCreate).toHaveBeenCalledTimes(2)
    expect(result.escalated).toBe(true)
  })

  it('uses Haiku model name first, Sonnet on escalation', async () => {
    messagesCreate
      .mockResolvedValueOnce(mockOcrResponse({ confidence: 0.5 }))
      .mockResolvedValueOnce(mockOcrResponse({ confidence: 0.9 }))

    await extractPaymentDetails('https://example/screenshot.png')

    const firstCall = messagesCreate.mock.calls[0][0]
    const secondCall = messagesCreate.mock.calls[1][0]
    expect(firstCall.model).toMatch(/haiku/)
    expect(secondCall.model).toMatch(/sonnet/)
  })

  it('returns a low-confidence result when both models fail to return tool_use', async () => {
    messagesCreate
      .mockResolvedValueOnce({ content: [] }) // Haiku — no tool_use
      .mockResolvedValueOnce({ content: [] }) // Sonnet — no tool_use

    const result = await extractPaymentDetails('https://example/screenshot.png')

    expect(result.confidence).toBe(0)
    expect(result.escalated).toBe(true)
  })
})