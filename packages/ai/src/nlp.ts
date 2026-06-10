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
- "Okay 👍", "Ok 👍", "okay", "ok" (when there is an active negotiation in history) → agreement
- "👍" alone or "👍🏽" or any thumbs-up emoji as the entire message → agreement
- "e don do", "E don do" → agreement (Pidgin: "it is done")
- "Oya send", "oya send" → agreement + requesting payment details
- "I go pay now", "I'm paying now" → agreement + payment intent
- "Done", "agreed", "sorted" → agreement
- "Send your account" → agreement + requesting bank details
- "Alright, fine" → agreement
- "Na deal" → agreement (Pidgin)
- "Oya na, I go take am" → agreement (Pidgin: "Okay, I'll take it")
- "Oya na, I go take am 12k" → agreement, lastMentionedPrice=12000
- "I go take am" → agreement (Pidgin: "I'll take it")
- "Make e be 12k, I go take am" → agreement, lastMentionedPrice=12000
- "Ok, 12k deal" → agreement, lastMentionedPrice=12000
- "Fine, I agree, send account" → agreement
- "Cool", "bet", "fine" (after a price has been mentioned in the conversation) → agreement
NOTE: "okay" / "ok" in isolation with NO prior commerce context → NONE. Only treat as agreement when the conversation history contains a price negotiation or product discussion.

PRICE FORMATS (always convert to Naira number):
- "12k" → 12000
- "₦12k" → 12000
- "12,000" → 12000
- "12.5k" → 12500
- "1.2m" → 1200000

PAYMENT INTENT:
- "I'm sending now" → payment intent
- "Done transfer" → payment sent
- "I've paid" → payment sent

Extract the intent and any relevant items, prices, or signals.

MERCHANT SETUP / SELF-SERVICE:
- "add product", "add new product" → merchant setup
- "update price", "change price" → merchant setup
- "check stock", "stock level", "inventory" → merchant setup`

export type KnownProduct = {
  name: string
  aliases: string[]
  unit: string
  price?: number
}

export async function analyseMessage(
  message: string,
  conversationHistory: Array<{ role: 'vendor' | 'customer'; text: string }> = [],
  knownProducts: KnownProduct[] = []
): Promise<NLPResult> {
  const historyContext =
    conversationHistory.length > 0
      ? `\nConversation history (last ${conversationHistory.length} messages):\n` +
        conversationHistory
          .slice(-6)
          .map(m => `[${m.role}]: ${m.text}`)
          .join('\n') +
        '\n'
      : ''

  const productContext =
    knownProducts.length > 0
      ? `\nKnown products for this merchant (use these to normalize item names):\n` +
        knownProducts
          .map(p => {
            const aliasStr = p.aliases.length > 0 ? ` (also called: ${p.aliases.join(', ')})` : ''
            const priceStr = p.price ? ` — ₦${p.price.toLocaleString()} per ${p.unit}` : ` — unit: ${p.unit}`
            return `- ${p.name}${aliasStr}${priceStr}`
          })
          .join('\n') +
        '\nWhen extracting items, always use the canonical product name (the first name listed above), not the alias.\n'
      : ''

  const response = await client.messages.create({
    model: 'claude-haiku-4-5-20251001',
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
              enum: ['ORDER', 'INQUIRY', 'COUNTER_OFFER', 'AGREEMENT', 'PAYMENT_INTENT', 'MERCHANT_SETUP', 'NONE'],
              description: 'The primary intent of the message',
            },
            items: {
              type: 'array',
              description: 'Items mentioned in the message — extract whenever a product is named, regardless of intent',
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
        content: `${productContext}${historyContext}Analyse this message:\n"${message}"`,
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
