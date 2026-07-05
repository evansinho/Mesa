import Anthropic from '@anthropic-ai/sdk'

const client = new Anthropic()

export type SalesAgentProduct = {
  name: string
  aliases?: string[]
  unit: string
  price?: number
  stockQuantity?: number | null
}

export type SalesAgentLedgerSummary = {
  items: Array<{
    productName: string
    quantity?: number
    quotedUnitPrice?: number
    agreedUnitPrice?: number
    status: string
  }>
  deliveryAddress?: string
  paymentStatus?: string
  draftStatus?: string
}

export type SalesAgentInput = {
  merchantName?: string
  tone?: string
  language?: string
  customerMessage: string
  conversationHistory?: Array<{ role: 'vendor' | 'customer'; text: string }>
  products?: SalesAgentProduct[]
  ledger?: SalesAgentLedgerSummary
}

export type SalesAgentReply = {
  message: string
  modelUsed: 'haiku'
}

const SYSTEM_PROMPT = `You are the merchant's WhatsApp sales assistant.

You may chat naturally, answer product/catalog questions, explain availability, and ask clarifying questions.
Match the customer's language and energy when possible, including Nigerian English or light Pidgin.
Speak as the merchant business itself. If you introduce yourself, use only the merchant/business name supplied in the prompt.
Never introduce yourself as Mesa, an AI, a bot, an assistant, automation, or software.

Hard safety rules:
- Do not create, confirm, cancel, dispatch, refund, or modify a formal order.
- Do not say payment is verified or received.
- Do not issue receipts.
- Do not share bank/account/payment details.
- Do not promise inventory changes or dispatch.
- If the customer asks for a high-risk action, say the business will confirm it.
- Keep replies concise for WhatsApp.`

const UNSAFE_REPLY_PATTERNS = [
  /\b(account number|acct number|bank details|send (?:payment|money) to|transfer to)\b/i,
  /\b(payment (?:is )?(?:confirmed|verified|received)|we have received your payment|receipt)\b/i,
  /\b(order (?:has been|is) (?:created|confirmed|logged)|i (?:have|'ve) created (?:the|your) order)\b/i,
  /\b(dispatch(?:ed)?|rider (?:has been|is) booked|refund (?:approved|processed))\b/i,
  /\b(i(?:'m| am)\s+(?:mesa|an?\s+ai|an?\s+bot|.*ai assistant)|mesa(?:'s)?\s+(?:ai|assistant|bot)|ai assistant|automated assistant)\b/i,
]

export function isSafeSalesAgentReply(message: string): boolean {
  const trimmed = message.trim()
  if (!trimmed) return false
  if (trimmed.length > 800) return false
  return !UNSAFE_REPLY_PATTERNS.some(pattern => pattern.test(trimmed))
}

function formatProducts(products: SalesAgentProduct[] = []): string {
  if (products.length === 0) return 'No catalog provided.'
  return products.slice(0, 40).map(product => {
    const aliases = product.aliases?.length ? ` aliases: ${product.aliases.join(', ')}` : ''
    const price = product.price ? ` price: ₦${product.price.toLocaleString()} per ${product.unit}` : ` unit: ${product.unit}`
    const stock = product.stockQuantity == null ? '' : ` stock: ${product.stockQuantity}`
    return `- ${product.name};${price};${stock}${aliases}`
  }).join('\n')
}

function formatLedger(ledger?: SalesAgentLedgerSummary): string {
  if (!ledger) return 'No active order facts yet.'
  const items = ledger.items.length
    ? ledger.items.map(item => {
      const quantity = item.quantity ? `${item.quantity}x ` : ''
      const price = item.agreedUnitPrice ?? item.quotedUnitPrice
      return `- ${quantity}${item.productName}${price ? ` at ₦${price.toLocaleString()}` : ''} (${item.status})`
    }).join('\n')
    : 'No active items.'
  return [
    `Items:\n${items}`,
    `Delivery address: ${ledger.deliveryAddress ?? 'unknown'}`,
    `Payment status: ${ledger.paymentStatus ?? 'none'}`,
    `Draft/order status: ${ledger.draftStatus ?? 'none'}`,
  ].join('\n')
}

export async function generateSalesReply(input: SalesAgentInput): Promise<SalesAgentReply | null> {
  const history = input.conversationHistory?.slice(-8).map(message => `[${message.role}]: ${message.text}`).join('\n') || 'No prior messages.'
  const response = await client.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 350,
    temperature: 0.4,
    system: SYSTEM_PROMPT,
    messages: [
      {
        role: 'user',
        content: [
          `Merchant: ${input.merchantName ?? 'Merchant'}`,
          `Tone: ${input.tone ?? 'friendly, concise'}`,
          `Language preference: ${input.language ?? 'auto'}`,
          '',
          'Catalog:',
          formatProducts(input.products),
          '',
          'Current transaction facts:',
          formatLedger(input.ledger),
          '',
          'Conversation history:',
          history,
          '',
          `Customer message: ${input.customerMessage}`,
          '',
          'Reply as the merchant business. Do not mention Mesa, AI, bots, automation, or software. Do not perform guarded actions.',
        ].join('\n'),
      },
    ],
  })

  const text = response.content
    .filter(block => block.type === 'text')
    .map(block => block.text)
    .join('\n')
    .trim()

  if (!isSafeSalesAgentReply(text)) return null
  return { message: text, modelUsed: 'haiku' }
}
