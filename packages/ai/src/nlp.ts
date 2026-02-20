import Anthropic from '@anthropic-ai/sdk'
import type { NLPResult, MessageIntent, DetectedOrderItem } from '@mesa/types'

const client = new Anthropic()

const SYSTEM_PROMPT = `You are an AI assistant for Mesa, a WhatsApp commerce automation platform built for Nigerian SMEs.

Your job is to analyse WhatsApp messages from commerce conversations and extract structured information.

Messages may be in Nigerian English, Pidgin English, or a mix. Key patterns to recognise:

ORDERS:
- "I want 3 bags of rice and 2 bottles of oil" → order
- "Abeg send me 5 cartons of Indomie" → order
- "I need one bag flour" → order

PRICE INQUIRIES:
- "How much for rice?" → inquiry
- "Wetin be the price?" → inquiry
- "What's your rate for garri?" → inquiry

COUNTER OFFERS / NEGOTIATION:
- "Abeg do ₦40,000 na" → counter offer
- "Can you do ₦35k?" → counter offer
- "Reduce am small" → request to lower price

AGREEMENT SIGNALS (the deal is done):
- "Okay deal", "OK deal" → agreement
- "e don do", "E don do" → agreement (Pidgin: "it is done")
- "Oya send", "oya send" → agreement + requesting payment details
- "I go pay now", "I'm paying now" → agreement + payment intent
- "Done", "agreed", "sorted" → agreement
- "Send your account" → agreement + requesting bank details
- "Alright, fine" → agreement
- "Na deal" → agreement (Pidgin)

PAYMENT INTENT:
- "I'm sending now" → payment intent
- "Done transfer" → payment sent
- "I've paid" → payment sent

Extract the intent and any relevant items, prices, or signals.`

export async function analyseMessage(
  message: string,
  conversationHistory: Array<{ role: 'vendor' | 'customer'; text: string }> = []
): Promise<NLPResult> {
  const historyContext =
    conversationHistory.length > 0
      ? `\nConversation history (last ${conversationHistory.length} messages):\n` +
        conversationHistory
          .slice(-6) // last 6 messages for context
          .map(m => `[${m.role}]: ${m.text}`)
          .join('\n') +
        '\n'
      : ''

  const response = await client.messages.create({
    model: 'claude-haiku-4-5-20251001', // fast + cheap for classification
    max_tokens: 1024,
    system: SYSTEM_PROMPT,
    tools: [
      {
        name: 'classify_message',
        description: 'Classify a WhatsApp commerce message and extract structured data',
        input_schema: {
          type: 'object' as const,
          properties: {
            intent: {
              type: 'string',
              enum: ['ORDER', 'INQUIRY', 'COUNTER_OFFER', 'AGREEMENT', 'PAYMENT_INTENT', 'NONE'],
              description: 'The primary intent of the message',
            },
            items: {
              type: 'array',
              description: 'Items mentioned in the message (for ORDER intent)',
              items: {
                type: 'object',
                properties: {
                  productName: { type: 'string' },
                  quantity: { type: 'number' },
                  unitPrice: { type: 'number', description: 'Price if explicitly mentioned' },
                },
                required: ['productName', 'quantity'],
              },
            },
            agreementSignalDetected: {
              type: 'boolean',
              description: 'True if the message contains an agreement signal',
            },
            lastMentionedPrice: {
              type: 'number',
              description: 'The last price figure mentioned in the message (in Naira)',
            },
            counterOfferPrice: {
              type: 'number',
              description: 'The counter-offer price if this is a COUNTER_OFFER',
            },
            confidence: {
              type: 'number',
              description: 'Confidence score 0-1',
            },
          },
          required: ['intent', 'items', 'agreementSignalDetected', 'confidence'],
        },
      },
    ],
    tool_choice: { type: 'tool', name: 'classify_message' },
    messages: [
      {
        role: 'user',
        content: `${historyContext}Analyse this message:\n"${message}"`,
      },
    ],
  })

  const toolUse = response.content.find(b => b.type === 'tool_use')
  if (!toolUse || toolUse.type !== 'tool_use') {
    return defaultNLPResult()
  }

  const result = toolUse.input as {
    intent: MessageIntent
    items: DetectedOrderItem[]
    agreementSignalDetected: boolean
    lastMentionedPrice?: number
    counterOfferPrice?: number
    confidence: number
  }

  return {
    intent: result.intent,
    items: result.items ?? [],
    agreementSignalDetected: result.agreementSignalDetected,
    lastMentionedPrice: result.lastMentionedPrice,
    counterOfferPrice: result.counterOfferPrice,
    confidence: result.confidence,
  }
}

function defaultNLPResult(): NLPResult {
  return {
    intent: 'NONE',
    items: [],
    agreementSignalDetected: false,
    confidence: 0,
  }
}