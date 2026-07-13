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

PRICE INQUIRIES / CATALOG BROWSING:
- "How much for rice?" → inquiry
- "Wetin be the price?" → inquiry
- "What's your rate for garri?" → inquiry
- "What do you have?" → inquiry (items=[])
- "What do you sell?" → inquiry (items=[])
- "Show me your products" → inquiry (items=[])
- "Wetin you get?" → inquiry (items=[])
- "Wetin una sell?" → inquiry (items=[])
- "What's available?" → inquiry (items=[])
- "Do you have any shirts?" → inquiry, items=[shirt]
- "What types do you have?" → inquiry (items=[])

COUNTER OFFERS / NEGOTIATION:
- "Abeg do ₦40,000 na" → counter offer
- "Can you do ₦35k?" → counter offer
- "Let me give you 35k" / "I go give you 35k" / "I'll pay 35k" → counter offer, counterOfferPrice=35000 (the customer is naming THEIR price — this is NOT an agreement)
- "Reduce am small" → request to lower price

AGREEMENT SIGNALS (the deal is done):
- "Okay deal", "OK deal" → agreement
- "Okay 👍", "Ok 👍", "okay", "ok" (when there is an active negotiation in history) → agreement
- "👍" alone or "👍🏽" or any thumbs-up emoji as the ENTIRE message → ALWAYS agreement, even with no history. A customer sends a lone thumbs-up only to confirm something.
- "e don do", "E don do" → agreement (Pidgin: "it is done")
- "Oya send", "oya send" → agreement + requesting payment details
- "I go pay now", "I'm paying now" → agreement + payment intent
- "Done", "agreed", "sorted" → agreement
- "Send your account" → agreement + requesting bank details
- "Alright, fine" → agreement
- "Na deal" → agreement (Pidgin)
- "Oya na, I go take am" → agreement (Pidgin: "Okay, I'll take it")
- "No wahala, I go take am" → agreement (Pidgin: "no problem, I'll take it" — the leading "No" is NOT a rejection)
- "Oya na, I go take am 12k" → agreement, lastMentionedPrice=12000
- "I go take am" → agreement (Pidgin: "I'll take it")
- "oya I go manage am", "I go manage am" → agreement (Pidgin: "okay I'll make do with it / I'll take it")
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
- "I don pay" → payment sent (Pidgin: "I have paid")
- "transfer don go" → payment sent (Pidgin: "transfer has gone")
- "I just send am" → payment sent (Pidgin: "I just sent it")
- "check ur acct", "check your account" → payment sent (customer is telling vendor to check because they paid)
- "payment made" → payment sent

DELIVERY / CUSTOMER FACTS:
- "My name is Ada" → customerName=Ada
- "Deliver to 12 Allen Avenue Ikeja" → deliveryAddress=12 Allen Avenue Ikeja
- "Can you deliver to Lekki?" → asksDelivery=true, but deliveryAddress only if a usable address/location is provided
- "Ref is TRF12345" → paymentReference=TRF12345

CORRECTIONS:
- "Not rice, garri" → correction=true, items=[garri]
- "Actually make it black soap" → correction=true, items=[black soap]
- "Remove the oil" → correction=true, items=[oil]

COMPLAINTS / ESCALATION SIGNALS:
- "I want refund", "wrong item", "bad product", "I am angry" → complaint=true
- A complaint is about a PRODUCT or ORDER problem. Price-talk pressure during
  negotiation is NOT a complaint:
  - "Be like you no won sell for me abi" → negotiation banter, complaint=false
  - "Why your price high na" / "You too cost" → counter-offer pressure, complaint=false
  - "You dey chase customer away" → negotiation banter, complaint=false

Extract the intent and any relevant items, prices, facts, or signals. Do not decide irreversible business actions; only extract structure for guarded workflow code.

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
        '\nWhen the customer\'s wording matches a product name or one of its listed aliases (case-insensitive), use the canonical product name (the first name listed above).\n' +
        'If the customer\'s term does not match any listed name or alias, keep the customer\'s exact wording as productName — NEVER substitute a similar-looking catalog product. Example: if the customer says "sweater" and the catalog only lists "Hooded Sweatshirt" (aliases: hoodie, sweatshirt), productName must be "sweater". The merchant will resolve it.\n' +
        'If the customer\'s term could match MORE THAN ONE product (e.g. "polo" when the catalog has a white polo and a black polo), do NOT pick one — keep the customer\'s exact wording ("polo") and let the merchant clarify.\n' +
        'For AGREEMENT messages ("I\'ll take it", "okay deal"): items must come from THIS message\'s words only. If the message names no product, return items=[] — never re-list products from the history or catalog.\n'
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
            signals: {
              type: 'object',
              description: 'Boolean commerce signals present in the message',
              properties: {
                asksForAccount: { type: 'boolean', description: 'Customer is asking for bank/account/payment details' },
                asksDelivery: { type: 'boolean', description: 'Customer asks about delivery/logistics' },
                paymentIntent: { type: 'boolean', description: 'Customer says they are paying, have paid, or sent transfer proof/reference' },
                complaint: { type: 'boolean', description: 'Customer is complaining, requesting refund, reporting wrong item, or upset' },
                correction: { type: 'boolean', description: 'Customer corrects, replaces, removes, or changes an order fact' },
              },
            },
            facts: {
              type: 'object',
              description: 'Concrete facts explicitly stated by the customer',
              properties: {
                customerName: { type: 'string' },
                deliveryAddress: { type: 'string' },
                paymentReference: { type: 'string' },
              },
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
    signals?: NLPResult['signals']
    facts?: NLPResult['facts']
    confidence: number
  }

  return {
    intent: result.intent,
    items: result.items ?? [],
    agreementSignalDetected: result.agreementSignalDetected,
    lastMentionedPrice: result.lastMentionedPrice,
    counterOfferPrice: result.counterOfferPrice,
    signals: result.signals,
    facts: result.facts,
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
