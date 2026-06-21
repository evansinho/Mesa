import type { SalesIntent, RequestedItem, ProductRow } from './types'
import { CatalogResolver } from './catalog-resolver'

function normalize(text: string): string {
  return text.trim().toLowerCase().replace(/[.!?]+$/, '')
}

function extractMoney(text: string): number | undefined {
  const matches = [...text.toLowerCase().matchAll(/(?:₦|ngn|n|#)?\s*(\d+(?:[,.]\d+)?)(?:\s*(k|m))?\b/g)]
  const values = matches
    .map(match => {
      const amount = Number(match[1].replace(/,/g, ''))
      if (!Number.isFinite(amount) || amount <= 0) return undefined
      if (match[2] === 'm') return amount * 1_000_000
      if (match[2] === 'k') return amount * 1_000
      return amount >= 1000 || /[₦#]|ngn|naira/.test(text.toLowerCase()) ? amount : undefined
    })
    .filter((amount): amount is number => typeof amount === 'number')
  return values.at(-1)
}

function quantityFrom(text: string): number | undefined {
  const match = normalize(text).match(/^(?:make (?:it|am)\s+)?(\d{1,3})$/)
  if (!match) return undefined
  const quantity = Number(match[1])
  return Number.isFinite(quantity) && quantity > 0 ? quantity : undefined
}

function stripOrderWords(text: string): string {
  return normalize(text)
    .replace(/\b(i('|’)ll|i will|i want|i need|i go|i wan|please|pls|abeg|kindly|take|buy|order|get|give me|add|also)\b/g, ' ')
    .replace(/\b(one|a|an|the|some|piece|pieces|unit|units|of|for me|available|have|which|what|show me|do you|you)\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function requestedItemsFrom(text: string, catalog: ProductRow[]): RequestedItem[] {
  const resolver = new CatalogResolver()
  const cleaned = stripOrderWords(text)
  const parts = cleaned
    .split(/\s*(?:,|;|\band\b|\+)\s*/i)
    .map(part => part.trim())
    .filter(Boolean)

  const items: RequestedItem[] = []
  for (const part of parts) {
    const qtyMatch = part.match(/^(\d{1,3})\s+(.+)$/)
    const quantity = qtyMatch ? Number(qtyMatch[1]) : 1
    const name = (qtyMatch ? qtyMatch[2] : part).trim()
    if (!name || /^\d+$/.test(name)) continue
    const resolution = resolver.resolve(name, catalog)
    if (resolution.type === 'unknown' && name.split(/\s+/).length > 5) continue
    items.push({ name, quantity: Number.isFinite(quantity) && quantity > 0 ? quantity : 1 })
  }
  return items
}

export class IntentExtractor {
  extract(text: string, catalog: ProductRow[]): SalesIntent {
    const n = normalize(text)
    if (!n) return { type: 'unknown' }
    if (/^(hi|hello|hey|yo|good morning|good afternoon|good evening|gm|ga)$/.test(n)) return { type: 'greeting' }
    if (/^(done|paid|sent|i have paid|i don pay|payment made|transfer sent)$/.test(n)) return { type: 'payment_claim', proofHashOrDone: 'done' }
    if (/\b(refund|complain|complaint|wrong item|bad product|angry|confused|confusion)\b/.test(n)) {
      return { type: 'complaint_or_confusion', reason: 'complaint_or_confusion' }
    }
    if (/\b(aza|account details|acc details|send account|send aza)\b/.test(n) ||
      (/\b(acc|account|bank|payment|pay)\b/.test(n) && /\b(detail|details|number|account|send|give|how|make)\b/.test(n))) {
      return { type: 'payment_request' }
    }
    if (/\b(total for what|how is it|why.*total|what.*total|which.*total|price for what|amount for what)\b/.test(n)) {
      return { type: 'cart_rejection_or_confusion', reason: 'total_explanation' }
    }
    if (/^(confirm|confirmed|yes confirm|go ahead|proceed|ok confirm|okay confirm|yes proceed|confirm it|confirm order|nothing else|no more|that'?s all|that is all|just confirm|please confirm|pls confirm|yes|ok|okay|sure|no)$/.test(n)) {
      return { type: 'cart_confirmation' }
    }
    if (/^(?:(?:ok|okay|yes|sure|fine)[,\s]+)?(?:(?:i('|’)ll|i will|i go|i wan|i want to)\s+)?(?:take|buy|get|order)\s+(?:it|this|that)$/.test(n)) {
      return { type: 'cart_confirmation' }
    }
    if (/\b(remove|delete|cancel)\b/.test(n)) {
      const remove = n.replace(/\b(remove|delete|cancel|the)\b/g, ' ').replace(/\s+/g, ' ').trim()
      return { type: 'cart_correction', remove: remove ? [remove] : undefined }
    }
    if (/\b(last price|final price|best price|last)\b/.test(n)) {
      return { type: 'price_negotiation', offeredTotal: extractMoney(text), asksLastPrice: true }
    }
    const offeredTotal = extractMoney(text)
    if (offeredTotal && /\b(pay|do|make|offer|budget|take|for|reduce|discount|too expensive|high side)\b/.test(n)) {
      return { type: 'price_negotiation', offeredTotal }
    }
    const quantity = quantityFrom(text)
    if (quantity) return { type: 'quantity_update', quantity }

    const resolver = new CatalogResolver()
    const category = resolver.categoryFromText(text, catalog)
    if (category && /\b(which|what|available|have|show|list|options?|sell|price)\b/.test(n)) {
      return { type: 'catalog_question', category }
    }
    if (/\b(what.*have|what.*sell|show.*product|list.*product|price list|available)\b/.test(n)) {
      return { type: 'catalog_question', category }
    }

    const items = requestedItemsFrom(text, catalog)
    if (items.length > 0 && /\b(want|need|take|buy|order|get|add|also|like)\b/.test(n)) {
      return { type: 'product_request', items }
    }
    if (items.length > 0 && items.some(item => resolver.resolve(item.name, catalog).type !== 'unknown')) {
      return { type: 'product_request', items }
    }
    return /\b(thanks|thank you)\b/.test(n) ? { type: 'smalltalk_or_faq', question: text } : { type: 'unknown' }
  }
}
