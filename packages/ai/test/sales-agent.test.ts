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

import { generateSalesReply, isSafeSalesAgentReply } from '../src/sales-agent'

function mockTextResponse(text: string) {
  return {
    content: [
      {
        type: 'text',
        text,
      },
    ],
  }
}

beforeEach(() => {
  messagesCreate.mockReset()
})

describe('sales agent replies', () => {
  it('generates a concise safe reply using merchant context', async () => {
    messagesCreate.mockResolvedValueOnce(mockTextResponse('Yes, we have Body Cream available. It is ₦5,000 per piece.'))

    const result = await generateSalesReply({
      merchantName: 'Ada Stores',
      botTone: 'friendly',
      botLanguage: 'auto',
      customerMessage: 'do you have cream?',
      products: [
        { name: 'Body Cream', aliases: ['cream'], unit: 'piece', price: 5000, stockQuantity: 10 },
      ],
      ledger: {
        items: [],
        paymentStatus: 'none',
        draftStatus: 'none',
      },
    })

    expect(result).toEqual({
      message: 'Yes, we have Body Cream available. It is ₦5,000 per piece.',
      modelUsed: 'haiku',
    })
    const call = messagesCreate.mock.calls[0][0]
    expect(call.system).toContain('Do not share bank/account/payment details')
    expect(call.system).toContain('Never introduce yourself as Mesa')
    expect(call.messages[0].content).toContain('Ada Stores')
    expect(call.messages[0].content).toContain('Body Cream')
    expect(call.messages[0].content).toContain('Do not mention Mesa, AI, bots, automation, or software')
  })

  it('rejects unsafe replies that perform guarded actions', async () => {
    messagesCreate.mockResolvedValueOnce(mockTextResponse('Payment confirmed. Your receipt is ready.'))

    const result = await generateSalesReply({
      customerMessage: 'I have paid',
    })

    expect(result).toBeNull()
  })

  it('classifies unsafe reply text locally', () => {
    expect(isSafeSalesAgentReply('Please transfer to account number 1234567890.')).toBe(false)
    expect(isSafeSalesAgentReply("I'm Mesa, Ada Stores' AI assistant.")).toBe(false)
    expect(isSafeSalesAgentReply("I'm Sino Shop's AI assistant here on WhatsApp.")).toBe(false)
    expect(isSafeSalesAgentReply('I can check that for you. Which size do you want?')).toBe(true)
    expect(isSafeSalesAgentReply('Welcome to Ada Stores. What would you like today?')).toBe(true)
  })
})
