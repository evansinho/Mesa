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

import { analyseMessage } from '../src/nlp'

function mockNlpResponse(fields: Record<string, unknown>) {
  return {
    content: [
      {
        type: 'tool_use',
        name: 'classify_message',
        input: fields,
      },
    ],
  }
}

beforeEach(() => {
  messagesCreate.mockReset()
})

describe('analyseMessage', () => {
  it('maps extracted facts and signals from the classify tool', async () => {
    messagesCreate.mockResolvedValueOnce(
      mockNlpResponse({
        intent: 'PAYMENT_INTENT',
        items: [{ productName: 'Body Cream', quantity: 1 }],
        agreementSignalDetected: true,
        signals: {
          asksForAccount: true,
          asksDelivery: true,
          paymentIntent: true,
          complaint: false,
        },
        facts: {
          customerName: 'Ada',
          deliveryAddress: '12 Allen Avenue Ikeja',
          paymentReference: 'TRF12345',
        },
        confidence: 0.92,
      }),
    )

    const result = await analyseMessage('send account, deliver to 12 Allen Avenue Ikeja')

    expect(result).toMatchObject({
      intent: 'PAYMENT_INTENT',
      agreementSignalDetected: true,
      signals: {
        asksForAccount: true,
        asksDelivery: true,
        paymentIntent: true,
        complaint: false,
      },
      facts: {
        customerName: 'Ada',
        deliveryAddress: '12 Allen Avenue Ikeja',
        paymentReference: 'TRF12345',
      },
      confidence: 0.92,
    })
  })

  it('exposes facts and signals in the Anthropic tool schema', async () => {
    messagesCreate.mockResolvedValueOnce(
      mockNlpResponse({
        intent: 'NONE',
        items: [],
        agreementSignalDetected: false,
        confidence: 0.8,
      }),
    )

    await analyseMessage('hello')

    const call = messagesCreate.mock.calls[0][0]
    const properties = call.tools[0].input_schema.properties
    expect(properties.signals.properties).toHaveProperty('asksDelivery')
    expect(properties.signals.properties).toHaveProperty('complaint')
    expect(properties.signals.properties).toHaveProperty('correction')
    expect(properties.facts.properties).toHaveProperty('deliveryAddress')
    expect(properties.facts.properties).toHaveProperty('paymentReference')
  })
})
