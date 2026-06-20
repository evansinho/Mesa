import type {
  CommerceCheckpoint,
  CommerceLedger,
  CommerceLedgerItem,
  ConversationContext,
  ConversationState,
  DetectedOrderItem,
  DraftBlockingReason,
  MessageIntent,
} from '@mesa/types'

export type CatalogProduct = {
  id: string
  name: string
  aliases?: string[] | null
  unit: string
  price: string | number
  lastPrice?: string | number | null
  stockQuantity?: number | null
  active?: boolean | null
}

export type LedgerPatch = {
  items?: Array<{
    operation: 'add' | 'update' | 'remove'
    productName?: string
    rawMention?: string
    quantity?: number
    agreedUnitPrice?: number
    quotedUnitPrice?: number
  }>
  signals?: Partial<CommerceLedger['signals']>
  customer?: Partial<CommerceLedger['customer']>
  payment?: Partial<CommerceLedger['payment']>
}

export type NlpLedgerInput = {
  intent: MessageIntent | string
  items?: DetectedOrderItem[]
  agreementSignalDetected?: boolean
  counterOfferPrice?: number
  lastMentionedPrice?: number
  signals?: Partial<CommerceLedger['signals']>
  facts?: {
    customerName?: string
    deliveryAddress?: string
    paymentReference?: string
  }
}

export type DraftOrder = {
  items: CommerceLedgerItem[]
  total: number
}

export type DraftReadiness =
  | { ready: true; draft: DraftOrder }
  | { ready: false; blockingReason: DraftBlockingReason; missingFields: string[] }

export type NextAction =
  | { type: 'REPLY_WITH_PRICE'; items: CommerceLedgerItem[]; total: number }
  | { type: 'REPLY_WITH_LAST_PRICE'; total: number }
  | { type: 'ASK_QUANTITY'; productName: string }
  | { type: 'ASK_PRODUCT_CLARIFICATION'; rawName: string; candidates: string[] }
  | { type: 'ASK_DELIVERY_ADDRESS' }
  | { type: 'ACKNOWLEDGE_DELIVERY_ADDRESS'; address: string }
  | { type: 'ACKNOWLEDGE_CORRECTION' }
  | { type: 'ASK_COUNTER_OFFER' }
  | { type: 'NEGOTIATE'; quotedTotal: number; floorTotal: number; customerOffer?: number }
  | { type: 'SEND_ORDER_SUMMARY'; draft: DraftOrder }
  | { type: 'REQUEST_PAYMENT'; draft: DraftOrder }
  | { type: 'VERIFY_PAYMENT'; proofUrl: string; orderId?: string }
  | { type: 'ESCALATE_TO_MERCHANT'; reason: DraftBlockingReason | string }
  | { type: 'NOOP' }

export type MessageRoute = 'NO_AI' | 'CHEAP_RULES' | 'CATALOG_RULES' | 'HAIKU_ANALYSIS' | 'HAIKU_REPLY' | 'SONNET_ESCALATION'

const DEFAULT_SIGNALS: CommerceLedger['signals'] = {
  purchaseIntent: false,
  agreement: false,
  negotiation: false,
  asksForAccount: false,
  asksDelivery: false,
  asksLastPrice: false,
  paymentIntent: false,
  complaint: false,
  correction: false,
}

export function emptyLedger(customerPhone?: string): CommerceLedger {
  return {
    version: 1,
    items: [],
    customer: { phone: customerPhone },
    payment: { status: 'none' },
    signals: { ...DEFAULT_SIGNALS },
    draftOrder: { status: 'none' },
    lastMessageAt: new Date().toISOString(),
  }
}

export function itemKey(productName: string): string {
  return productName.trim().toLowerCase().replace(/\s+/g, ' ')
}

function toNumber(value: string | number | null | undefined): number | undefined {
  if (value == null) return undefined
  const parsed = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined
}

function normalizeProductName(name: string): string {
  return name.trim().toLowerCase()
}

function findCatalogProduct(name: string, catalog: CatalogProduct[]): CatalogProduct | undefined {
  const target = normalizeProductName(name)
  return catalog.find(product => {
    if (product.active === false) return false
    if (normalizeProductName(product.name) === target) return true
    return (product.aliases ?? []).some(alias => normalizeProductName(alias) === target)
  })
}

function isQuantityOnlyPatch(patch: LedgerPatch): boolean {
  const items = patch.items ?? []
  return items.length === 1 &&
    items[0].operation !== 'remove' &&
    !items[0].productName &&
    !items[0].rawMention &&
    typeof items[0].quantity === 'number'
}

export function normalizeLedger(context: Partial<ConversationContext> | undefined, customerPhone?: string): CommerceLedger {
  const now = context?.lastMessageAt ?? new Date().toISOString()
  const existing = context?.ledger
  if (existing?.version === 1) {
    const currentItems = Array.isArray(context?.currentItems) ? context.currentItems : undefined
    const items = currentItems
      ? currentItems.map(item => {
        const catalogItem = item as DetectedOrderItem & {
          productId?: string
          floorUnitPrice?: number
          unit?: string
        }
        const key = itemKey(item.productName)
        const previous = existing.items.find(existingItem => existingItem.key === key)
        return {
          ...previous,
          key,
          productId: catalogItem.productId ?? previous?.productId,
          productName: item.productName,
          quantity: item.quantity,
          unit: catalogItem.unit ?? previous?.unit,
          quotedUnitPrice: item.unitPrice ?? previous?.quotedUnitPrice,
          floorUnitPrice: catalogItem.floorUnitPrice ?? previous?.floorUnitPrice,
          agreedUnitPrice: item.agreedPrice && item.quantity > 0 ? item.agreedPrice / item.quantity : previous?.agreedUnitPrice,
          status: (context?.agreedPrice ? 'agreed' : context?.lastQuotedPrice ? 'quoted' : previous?.status ?? 'mentioned'),
        } satisfies CommerceLedgerItem
      })
      : Array.isArray(existing.items) ? existing.items : []
    const activeItemKey = existing.activeItemKey && items.some(item => item.key === existing.activeItemKey && item.status !== 'removed')
      ? existing.activeItemKey
      : items.filter(item => item.status !== 'removed').at(-1)?.key

    return {
      ...emptyLedger(customerPhone),
      ...existing,
      customer: { phone: customerPhone, ...existing.customer },
      payment: existing.payment ?? { status: 'none' },
      signals: { ...DEFAULT_SIGNALS, ...existing.signals },
      items,
      activeItemKey,
      lastMessageAt: now,
    }
  }

  const ledger = emptyLedger(customerPhone)
  ledger.lastMessageAt = now

  const currentItems = Array.isArray(context?.currentItems) ? context.currentItems : []
  ledger.items = currentItems.map(item => {
    const catalogItem = item as DetectedOrderItem & {
      productId?: string
      floorUnitPrice?: number
      unit?: string
    }
    // unitPrice in CatalogItem is already per-unit — do not divide by quantity.
    // agreedPrice in DetectedOrderItem is a per-item total, so divide by quantity to get per-unit.
    return {
      key: itemKey(item.productName),
      productId: catalogItem.productId,
      productName: item.productName,
      quantity: item.quantity,
      unit: catalogItem.unit,
      quotedUnitPrice: item.unitPrice,
      floorUnitPrice: catalogItem.floorUnitPrice,
      agreedUnitPrice: item.agreedPrice && item.quantity > 0 ? item.agreedPrice / item.quantity : undefined,
      status: context?.agreedPrice ? 'agreed' : context?.lastQuotedPrice ? 'quoted' : 'mentioned',
    } satisfies CommerceLedgerItem
  })
  ledger.activeItemKey = ledger.items[ledger.items.length - 1]?.key

  if (context?.orderId) {
    ledger.draftOrder = {
      status: 'merchant_confirmed',
      orderId: context.orderId,
      total: context.agreedPrice ?? context.lastQuotedPrice,
    }
  } else if (context?.awaitingOrderConfirmation) {
    ledger.draftOrder = {
      status: 'sent_to_customer',
      total: context.agreedPrice ?? context.lastQuotedPrice,
    }
  } else if (context?.agreedPrice) {
    ledger.draftOrder = {
      status: 'ready',
      total: context.agreedPrice,
    }
  }

  if (context?.agreedPrice) ledger.signals.agreement = true
  if (ledger.items.length > 0) ledger.signals.purchaseIntent = true
  return ledger
}

export function contextWithLedger(context: ConversationContext, ledger: CommerceLedger): ConversationContext {
  const activeItems = ledger.items
    .filter(item => item.status !== 'removed')
    .map(item => ({
      productId: item.productId,
      productName: item.productName,
      quantity: item.quantity ?? 1,
      unit: item.unit,
      unitPrice: item.quotedUnitPrice,  // per-unit — no multiplication
      floorUnitPrice: item.floorUnitPrice,
      agreedPrice: item.agreedUnitPrice ? item.agreedUnitPrice * (item.quantity ?? 1) : undefined,
    }))

  const draftTotal = ledger.draftOrder?.total
  const ledgerTotal = ledger.items.reduce((sum, item) => sum + ((item.agreedUnitPrice ?? item.quotedUnitPrice ?? 0) * (item.quantity ?? 0)), 0)
  const lastQuotedPrice = draftTotal ?? (ledgerTotal || context.lastQuotedPrice)

  return {
    ...context,
    currentItems: activeItems,
    lastQuotedPrice,
    agreedPrice: ledger.draftOrder?.status === 'customer_confirmed' || ledger.draftOrder?.status === 'merchant_confirmed'
      ? draftTotal
      : context.agreedPrice,
    awaitingOrderConfirmation: ledger.draftOrder?.status === 'sent_to_customer' || context.awaitingOrderConfirmation,
    orderId: ledger.draftOrder?.orderId ?? context.orderId,
    ledger,
    lastMessageAt: ledger.lastMessageAt,
  }
}

export function deriveCheckpointState(ledger: CommerceLedger): CommerceCheckpoint {
  if (ledger.signals.complaint) return 'ESCALATED'
  if (ledger.payment.status === 'verified') return 'PAYMENT_VERIFIED'
  if (ledger.payment.status === 'proof_received') return 'PAYMENT_PROOF_RECEIVED'
  if (ledger.payment.status === 'requested') return 'PAYMENT_REQUESTED'
  if (ledger.draftOrder?.orderId) return 'ORDER_LOGGED'
  if (ledger.draftOrder?.status === 'customer_confirmed' || ledger.draftOrder?.status === 'merchant_confirmed') return 'ORDER_CONFIRMED'
  if (ledger.draftOrder?.status === 'ready' || ledger.draftOrder?.status === 'sent_to_customer') return 'ORDER_SUMMARY_READY'
  if (ledger.items.some(item => item.status !== 'removed')) return 'INTENT_DETECTED'
  return 'IDLE'
}

export function deriveConversationState(ledger: CommerceLedger): ConversationState {
  if (ledger.payment.status === 'verified') return 'PAYMENT_RECEIVED'
  if (ledger.payment.status === 'proof_received') return 'AWAITING_PAYMENT'
  if (ledger.payment.status === 'requested') return 'AWAITING_PAYMENT'
  if (ledger.draftOrder?.orderId) return 'ORDER_CREATED'
  if (ledger.draftOrder?.status === 'customer_confirmed' || ledger.draftOrder?.status === 'merchant_confirmed') return 'AGREED'
  if (ledger.draftOrder?.status === 'ready' || ledger.draftOrder?.status === 'sent_to_customer') return 'AGREED'
  if (ledger.items.some(item => item.status === 'negotiating' || item.status === 'quoted' || item.status === 'agreed')) return 'NEGOTIATING'
  if (ledger.items.some(item => item.status === 'mentioned')) return 'BROWSING'
  return 'IDLE'
}

export function applyValidatedLedgerPatch(
  ledger: CommerceLedger,
  patch: LedgerPatch,
  catalog: CatalogProduct[] = [],
  now = new Date().toISOString(),
): CommerceLedger {
  const next: CommerceLedger = {
    ...ledger,
    customer: { ...ledger.customer, ...patch.customer },
    payment: { ...ledger.payment, ...patch.payment },
    signals: { ...ledger.signals, ...patch.signals },
    items: ledger.items.map(item => ({ ...item })),
    lastMessageAt: now,
  }

  if (isQuantityOnlyPatch(patch)) {
    const active = next.activeItemKey ? next.items.find(item => item.key === next.activeItemKey && item.status !== 'removed') : undefined
    if (!active) {
      next.draftOrder = { status: 'none', blockingReason: 'ambiguous_item_reference' }
      return next
    }
    active.quantity = patch.items![0].quantity
    active.status = active.quotedUnitPrice ? 'quoted' : 'mentioned'
    next.signals.purchaseIntent = true
    return next
  }

  for (const incoming of patch.items ?? []) {
    const rawName = incoming.productName ?? incoming.rawMention
    if (incoming.operation === 'remove') {
      const removeKey = rawName ? itemKey(rawName) : next.activeItemKey
      const item = removeKey
        ? next.items.find(i =>
          i.key === removeKey ||
          i.productName.toLowerCase() === removeKey ||
          i.rawMention?.toLowerCase() === removeKey
        )
        : undefined
      if (item) item.status = 'removed'
      if (next.activeItemKey === removeKey) next.activeItemKey = undefined
      continue
    }

    if (!rawName) continue
    const catalogProduct = findCatalogProduct(rawName, catalog)
    const productName = catalogProduct?.name ?? rawName.trim()
    const key = itemKey(productName)
    let item = next.items.find(existing => existing.key === key)
    if (!item) {
      item = {
        key,
        productId: catalogProduct?.id,
        productName,
        rawMention: incoming.rawMention,
        unit: catalogProduct?.unit,
        quotedUnitPrice: toNumber(catalogProduct?.price) ?? incoming.quotedUnitPrice,
        floorUnitPrice: toNumber(catalogProduct?.lastPrice) ?? toNumber(catalogProduct?.price),
        status: 'mentioned',
      }
      next.items.push(item)
    }

    item.productId = catalogProduct?.id ?? item.productId
    item.productName = productName
    item.rawMention = incoming.rawMention ?? item.rawMention
    item.unit = catalogProduct?.unit ?? item.unit
    item.quantity = incoming.quantity ?? item.quantity
    item.quotedUnitPrice = incoming.quotedUnitPrice ?? item.quotedUnitPrice ?? toNumber(catalogProduct?.price)
    item.floorUnitPrice = item.floorUnitPrice ?? toNumber(catalogProduct?.lastPrice) ?? toNumber(catalogProduct?.price)
    item.agreedUnitPrice = incoming.agreedUnitPrice ?? item.agreedUnitPrice
    item.status = incoming.agreedUnitPrice ? 'agreed' : item.quotedUnitPrice ? 'quoted' : 'mentioned'
    next.activeItemKey = key
  }

  for (const item of next.items) {
    if (item.status === 'removed') continue
    const catalogProduct = findCatalogProduct(item.productName, catalog)
    if (!catalogProduct) continue
    item.productId = item.productId ?? catalogProduct.id
    item.productName = catalogProduct.name
    item.unit = item.unit ?? catalogProduct.unit
    item.quotedUnitPrice = item.quotedUnitPrice ?? toNumber(catalogProduct.price)
    item.floorUnitPrice = item.floorUnitPrice ?? toNumber(catalogProduct.lastPrice) ?? toNumber(catalogProduct.price)
  }

  if (!next.activeItemKey || !next.items.some(item => item.key === next.activeItemKey && item.status !== 'removed')) {
    next.activeItemKey = next.items.filter(item => item.status !== 'removed').at(-1)?.key
  }

  return next
}

export function applyNlpToLedger(
  ledger: CommerceLedger,
  nlp: NlpLedgerInput,
  catalog: CatalogProduct[] = [],
  now = new Date().toISOString(),
): CommerceLedger {
  const signals: Partial<CommerceLedger['signals']> = {
    ...nlp.signals,
  }

  if (nlp.intent === 'ORDER') signals.purchaseIntent = true
  if (nlp.intent === 'INQUIRY') signals.purchaseIntent = signals.purchaseIntent ?? false
  if (nlp.intent === 'COUNTER_OFFER') signals.negotiation = true
  if (nlp.intent === 'AGREEMENT' || nlp.agreementSignalDetected) signals.agreement = true
  if (nlp.intent === 'PAYMENT_INTENT') signals.paymentIntent = true

  const facts: LedgerPatch['customer'] = {}
  if (nlp.facts?.customerName) facts.name = nlp.facts.customerName
  if (nlp.facts?.deliveryAddress) facts.deliveryAddress = nlp.facts.deliveryAddress

  const payment: LedgerPatch['payment'] = {}
  if (nlp.facts?.paymentReference) payment.reference = nlp.facts.paymentReference
  // 'requested' means the merchant has sent bank details — set it only when that action fires,
  // not when the customer signals intent to pay.

  const items = (nlp.items ?? []).map(item => {
    const quantity = item.quantity > 0 ? item.quantity : undefined
    const perUnitAgreed = item.agreedPrice && quantity ? item.agreedPrice / quantity : undefined
    const perUnitQuoted = item.unitPrice && quantity ? item.unitPrice / quantity : item.unitPrice
    return {
      operation: 'add' as const,
      productName: item.productName,
      quantity,
      agreedUnitPrice: perUnitAgreed,
      quotedUnitPrice: perUnitQuoted,
    }
  })

  if (nlp.intent === 'ORDER' || nlp.intent === 'INQUIRY') {
    signals.negotiation = false
    signals.asksLastPrice = false
  }

  let next = applyValidatedLedgerPatch(ledger, {
    items,
    signals,
    customer: facts,
    payment,
  }, catalog, now)

  const offer = nlp.counterOfferPrice ?? (nlp.intent === 'COUNTER_OFFER' ? nlp.lastMentionedPrice : undefined)
  if (offer && offer > 0 && next.activeItemKey) {
    const active = next.items.find(item => item.key === next.activeItemKey)
    if (active) {
      const quantity = active.quantity ?? 1
      active.agreedUnitPrice = offer / quantity
      active.status = 'negotiating'
      next.signals.negotiation = true
    }
  }

  return next
}

export function applyCheapTextToLedger(
  ledger: CommerceLedger,
  text: string,
  catalog: CatalogProduct[] = [],
  now = new Date().toISOString(),
): CommerceLedger | null {
  const normalized = text.trim().toLowerCase().replace(/[.!?]+$/, '')
  if (!normalized) return null

  if (/\b(refund|angry|complain|complaint|bad product|wrong item)\b/.test(normalized)) {
    return applyValidatedLedgerPatch(ledger, {
      signals: { complaint: true },
    }, catalog, now)
  }

  const deliveryAddressMatch = normalized.match(/^(?:deliver to|delivery address(?: is)?|address(?: is)?|my address is)\s+(.{8,160})$/)
  if (deliveryAddressMatch) {
    return applyValidatedLedgerPatch(ledger, {
      customer: { deliveryAddress: deliveryAddressMatch[1].trim() },
      signals: { asksDelivery: true },
    }, catalog, now)
  }

  if (/\b(deliver|delivery|dispatch|rider)\b/.test(normalized)) {
    return applyValidatedLedgerPatch(ledger, {
      signals: { asksDelivery: true },
    }, catalog, now)
  }

  if (/\b(last price|final price|best price|last)\b/.test(normalized)) {
    return applyValidatedLedgerPatch(ledger, {
      signals: { negotiation: true, asksLastPrice: true },
    }, catalog, now)
  }

  if (/\b(reduce|discount|too (?:cost|expensive)|can you do better|abeg reduce|price too much)\b/.test(normalized)) {
    return applyValidatedLedgerPatch(ledger, {
      signals: { negotiation: true },
    }, catalog, now)
  }

  const removeMatch = normalized.match(/^(?:remove|delete|cancel|no|not)\s+(?:the\s+)?([a-z][a-z0-9\s-]{1,60})$/)
  if (removeMatch && !/\d/.test(normalized)) {
    return applyValidatedLedgerPatch(ledger, {
      items: [{ operation: 'remove', productName: removeMatch[1].trim() }],
      signals: { correction: true, purchaseIntent: true },
    }, catalog, now)
  }

  const replacementMatch = normalized.match(/^(?:not\s+(.+?),?\s+)?(?:actually\s+|change (?:it|am) to\s+|make (?:it|am)\s+)?([a-z][a-z0-9\s-]{1,60})$/)
  if (replacementMatch && /\b(not|actually|change|make)\b/.test(normalized) && !/\d/.test(normalized)) {
    const oldName = replacementMatch[1]?.trim()
    const newName = replacementMatch[2]?.trim()
    if (newName && !['it', 'am', 'that one', 'this one'].includes(newName)) {
      const removePatch = oldName
        ? [{ operation: 'remove' as const, productName: oldName }]
        : ledger.activeItemKey
          ? [{ operation: 'remove' as const }]
          : []
      return applyValidatedLedgerPatch(ledger, {
        items: [
          ...removePatch,
          { operation: 'add', productName: newName },
        ],
        signals: { correction: true, purchaseIntent: true },
      }, catalog, now)
    }
  }

  const quantityMatch = normalized.match(/^(?:make (?:it|am)\s+)?(\d+(?:\.\d+)?)$/)
  if (quantityMatch) {
    const quantity = Number(quantityMatch[1])
    if (!Number.isFinite(quantity) || quantity <= 0) return null
    return applyValidatedLedgerPatch(ledger, {
      items: [{ operation: 'update', quantity }],
      signals: { purchaseIntent: true },
    }, catalog, now)
  }

  if (/\b(aza|account details|acc details|send account|send aza)\b/.test(normalized) ||
    (/\b(acc|account|bank|payment|pay)\b/.test(normalized) && /\b(detail|details|number|account|send|give|how|make)\b/.test(normalized))) {
    return applyValidatedLedgerPatch(ledger, {
      signals: { asksForAccount: true, agreement: true, purchaseIntent: true },
    }, catalog, now)
  }

  if (/\b(done transfer|i don pay|check (ur|your) acct|transfer don go|payment made|i just send am|sent)\b/.test(normalized)) {
    return applyValidatedLedgerPatch(ledger, {
      signals: { paymentIntent: true, agreement: true, purchaseIntent: true },
    }, catalog, now)
  }

  if (/^(yes|ok|okay|confirm|confirmed|done)$/.test(normalized) && ledger.items.some(item => item.status !== 'removed')) {
    return applyValidatedLedgerPatch(ledger, {
      signals: { agreement: true, purchaseIntent: true },
    }, catalog, now)
  }

  return null
}

export function applyMerchantQuoteToLedger(
  ledger: CommerceLedger,
  quotedTotal: number,
  now = new Date().toISOString(),
): CommerceLedger {
  const next: CommerceLedger = {
    ...ledger,
    items: ledger.items.map(item => ({ ...item })),
    lastMessageAt: now,
  }

  if (!Number.isFinite(quotedTotal) || quotedTotal <= 0) return next

  const active = next.activeItemKey
    ? next.items.find(item => item.key === next.activeItemKey && item.status !== 'removed')
    : next.items.filter(item => item.status !== 'removed').at(-1)

  if (!active) return next

  const quantity = active.quantity && active.quantity > 0 ? active.quantity : 1
  active.quantity = quantity
  active.quotedUnitPrice = quotedTotal / quantity
  active.floorUnitPrice = active.floorUnitPrice ?? active.quotedUnitPrice
  active.status = 'quoted'
  next.activeItemKey = active.key
  next.draftOrder = next.draftOrder?.status === 'none'
    ? next.draftOrder
    : { status: 'none' }
  return next
}

export function evaluateDraftReadiness(ledger: CommerceLedger, catalog: CatalogProduct[] = []): DraftReadiness {
  const activeItems = ledger.items.filter(item => item.status !== 'removed')
  if (activeItems.length === 0) {
    if (ledger.payment.status === 'proof_received' || ledger.signals.paymentIntent) {
      return { ready: false, blockingReason: 'payment_without_order_facts', missingFields: ['product', 'quantity'] }
    }
    return { ready: false, blockingReason: 'missing_product', missingFields: ['product'] }
  }

  const unresolvedProduct = activeItems.find(item => !item.productId && catalog.length > 0 && !findCatalogProduct(item.productName, catalog))
  if (unresolvedProduct) {
    return { ready: false, blockingReason: 'ambiguous_product', missingFields: ['product'] }
  }

  const missingQuantity = activeItems.find(item => !item.quantity || item.quantity <= 0)
  if (missingQuantity) {
    return { ready: false, blockingReason: 'missing_quantity', missingFields: ['quantity'] }
  }

  const outOfStock = activeItems.find(item => {
    const product = item.productId
      ? catalog.find(p => p.id === item.productId)
      : findCatalogProduct(item.productName, catalog)
    return product?.stockQuantity != null && product.stockQuantity < (item.quantity ?? 0)
  })
  if (outOfStock) {
    return { ready: false, blockingReason: 'out_of_stock', missingFields: ['stock'] }
  }

  const missingPrice = activeItems.find(item => !(item.agreedUnitPrice ?? item.quotedUnitPrice))
  if (missingPrice) {
    return { ready: false, blockingReason: 'missing_price', missingFields: ['price'] }
  }

  const hasPurchaseSignal = ledger.signals.purchaseIntent ||
    ledger.signals.agreement ||
    ledger.signals.asksForAccount ||
    ledger.signals.paymentIntent ||
    ledger.signals.negotiation ||
    ledger.payment.status === 'proof_received'
  if (!hasPurchaseSignal) {
    return { ready: false, blockingReason: 'missing_purchase_signal', missingFields: ['purchase_signal'] }
  }

  const pricedItems = activeItems.map(item => ({ ...item }))
  const total = pricedItems.reduce((sum, item) => sum + ((item.agreedUnitPrice ?? item.quotedUnitPrice ?? 0) * (item.quantity ?? 0)), 0)
  return { ready: true, draft: { items: pricedItems, total } }
}

export function decideNextAction(
  ledger: CommerceLedger,
  readiness: DraftReadiness,
): NextAction {
  if (ledger.signals.complaint) return { type: 'ESCALATE_TO_MERCHANT', reason: 'complaint' }
  if (ledger.payment.status === 'proof_received') {
    return { type: 'VERIFY_PAYMENT', proofUrl: ledger.payment.proofUrl ?? '', orderId: ledger.draftOrder?.orderId }
  }
  if (ledger.signals.asksDelivery && ledger.customer.deliveryAddress) {
    return { type: 'ACKNOWLEDGE_DELIVERY_ADDRESS', address: ledger.customer.deliveryAddress }
  }
  if (ledger.signals.asksDelivery && !ledger.customer.deliveryAddress) {
    return { type: 'ASK_DELIVERY_ADDRESS' }
  }

  if (!readiness.ready) {
    if (ledger.signals.correction && readiness.blockingReason === 'missing_product') {
      return { type: 'ACKNOWLEDGE_CORRECTION' }
    }
    if (readiness.blockingReason === 'missing_quantity') {
      const target = ledger.activeItemKey
        ? ledger.items.find(item => item.key === ledger.activeItemKey)
        : ledger.items.find(item => item.status !== 'removed')
      return target ? { type: 'ASK_QUANTITY', productName: target.productName } : { type: 'NOOP' }
    }
    if (readiness.blockingReason === 'ambiguous_product') {
      return { type: 'ESCALATE_TO_MERCHANT', reason: readiness.blockingReason }
    }
    if (readiness.blockingReason === 'payment_without_order_facts') {
      return { type: 'ESCALATE_TO_MERCHANT', reason: readiness.blockingReason }
    }
    if (readiness.blockingReason === 'out_of_stock') {
      return { type: 'ESCALATE_TO_MERCHANT', reason: 'out_of_stock' }
    }
    if (readiness.blockingReason === 'missing_purchase_signal') {
      const pricedItems = ledger.items.filter(item =>
        item.status !== 'removed' &&
        item.quantity &&
        item.quantity > 0 &&
        (item.quotedUnitPrice ?? item.agreedUnitPrice)
      )
      if (pricedItems.length > 0) {
        const total = pricedItems.reduce((sum, item) => sum + ((item.quotedUnitPrice ?? item.agreedUnitPrice ?? 0) * (item.quantity ?? 0)), 0)
        if (ledger.signals.negotiation) {
          const floorTotal = pricedItems.reduce((sum, item) => sum + ((item.floorUnitPrice ?? item.quotedUnitPrice ?? item.agreedUnitPrice ?? 0) * (item.quantity ?? 0)), 0)
          if (ledger.signals.asksLastPrice) {
            return { type: 'REPLY_WITH_LAST_PRICE', total: floorTotal || total }
          }
          return { type: 'ASK_COUNTER_OFFER' }
        }
        return { type: 'REPLY_WITH_PRICE', items: pricedItems, total }
      }
    }
    return { type: 'NOOP' }
  }

  if (ledger.signals.asksForAccount || ledger.signals.paymentIntent) {
    return { type: 'REQUEST_PAYMENT', draft: readiness.draft }
  }
  if (ledger.signals.correction) {
    return { type: 'REPLY_WITH_PRICE', items: readiness.draft.items, total: readiness.draft.total }
  }
  if (ledger.signals.agreement) {
    if (ledger.draftOrder?.status === 'sent_to_customer' || ledger.draftOrder?.status === 'customer_confirmed') {
      return { type: 'REQUEST_PAYMENT', draft: readiness.draft }
    }
    return { type: 'SEND_ORDER_SUMMARY', draft: readiness.draft }
  }
  if (ledger.signals.negotiation) {
    const quotedTotal = readiness.draft.items.reduce((s, i) => s + (i.quotedUnitPrice ?? 0) * (i.quantity ?? 0), 0)
    const floorTotal = readiness.draft.items.reduce((s, i) => s + (i.floorUnitPrice ?? i.quotedUnitPrice ?? 0) * (i.quantity ?? 0), 0)
    if (ledger.signals.asksLastPrice) {
      return { type: 'REPLY_WITH_LAST_PRICE', total: floorTotal || quotedTotal }
    }
    const negotiatingItem = readiness.draft.items.find(i => i.status === 'negotiating')
    const customerOffer = negotiatingItem?.agreedUnitPrice
      ? negotiatingItem.agreedUnitPrice * (negotiatingItem.quantity ?? 1)
      : undefined
    if (!customerOffer) return { type: 'ASK_COUNTER_OFFER' }
    return { type: 'NEGOTIATE', quotedTotal, floorTotal, customerOffer }
  }
  return { type: 'REPLY_WITH_PRICE', items: readiness.draft.items, total: readiness.draft.total }
}

export function routeMessageForCost(text: string, ledger: CommerceLedger): MessageRoute {
  const normalized = text.trim().toLowerCase().replace(/[.!?]+$/, '')
  if (!normalized) return 'NO_AI'
  if (/^(hi|hello|hey|thanks|thank you|ok|okay)$/.test(normalized) && ledger.items.length === 0) return 'NO_AI'
  if (/^(yes|no|confirm|confirmed|done)$/.test(normalized) && ledger.items.length > 0) return 'CHEAP_RULES'
  if (/\b(done transfer|i don pay|check (ur|your) acct|sent|send aza|account details|acc details)\b/.test(normalized)) return 'CHEAP_RULES'
  if (ledger.items.length > 0 && /\b(deliver|delivery|dispatch|rider|address)\b/.test(normalized)) return 'CHEAP_RULES'
  if (ledger.items.length > 0 && /\b(last price|final price|best price|last|reduce|discount|too (?:cost|expensive)|can you do better|abeg reduce|price too much)\b/.test(normalized)) return 'CHEAP_RULES'
  if (/^(make (it|am) )?\d+(\.\d+)?$/.test(normalized) && ledger.activeItemKey) return 'CHEAP_RULES'
  if (ledger.items.length > 0 && /\b(not|actually|change|make|remove|delete|cancel)\b/.test(normalized) && !/\d/.test(normalized)) return 'CATALOG_RULES'
  if (/\b(refund|angry|complain|complaint|bad product|wrong item)\b/.test(normalized)) return 'SONNET_ESCALATION'
  if (ledger.items.length > 0 && normalized.length < 24) return 'HAIKU_ANALYSIS'
  return 'HAIKU_REPLY'
}
