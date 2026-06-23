import type { BotDecision, BotRuntimeContext, CartItem, ProductRow, SalesIntent } from './types'
import { CatalogResolver } from './catalog-resolver'
import { cartItemTotal, cartKey, cartTotal, runtimeContextPatch } from './runtime-context'

function money(amount: number): string {
  return `₦${Math.round(amount).toLocaleString()}`
}

function optionList(label: string, products: ProductRow[]): string {
  const lines = products.map(product => `- ${product.name} - ${money(parseFloat(product.price))}`)
  return [`We have a few ${label.trim().toLowerCase()} options:`, ...lines, '', 'Which one do you want?'].join('\n')
}

export function cartReviewText(cart: CartItem[]): string {
  const lines = cart.map(item => `${item.quantity}x ${item.productName} - ${money(cartItemTotal(item))}`)
  return ['Just to confirm:', '', ...lines, '', `Total: ${money(cartTotal(cart))}`, '', 'Should I confirm this order?'].join('\n')
}

function cartExplanationText(cart: CartItem[]): string {
  const lines = cart.map(item => `${item.quantity}x ${item.productName} - ${money(cartItemTotal(item))}`)
  return ['Order summary:', ...lines, `Total: ${money(cartTotal(cart))}`].join('\n')
}

function productToCartItem(product: ProductRow, quantity: number): CartItem {
  return {
    key: cartKey(product.id),
    productId: product.id,
    productName: product.name,
    quantity,
    unitPrice: parseFloat(product.price),
    floorUnitPrice: product.lastPrice ? parseFloat(product.lastPrice) : parseFloat(product.price),
  }
}

function mergeCart(cart: CartItem[], incoming: CartItem[]): CartItem[] {
  const next = cart.map(item => ({ ...item }))
  for (const item of incoming) {
    const existing = next.find(current => current.productId === item.productId)
    if (existing) {
      existing.quantity += item.quantity
      existing.negotiatedUnitPrice = undefined
    } else {
      next.push(item)
    }
  }
  return next
}

function removeFromCart(cart: CartItem[], refs: string[] | undefined): CartItem[] {
  if (!refs?.length) return cart.slice(0, -1)
  const normalized = refs.map(ref => ref.toLowerCase().trim()).filter(Boolean)
  return cart.filter(item => {
    const name = item.productName.toLowerCase()
    const words = new Set(name.split(/\s+/).flatMap(word => [
      word,
      word.endsWith('s') ? word.slice(0, -1) : `${word}s`,
    ]))
    return !normalized.some(ref => {
      if (name.includes(ref)) return true
      return ref.split(/\s+/).some(word => words.has(word) || words.has(word.endsWith('s') ? word.slice(0, -1) : `${word}s`))
    })
  })
}

function allocateNegotiated(cart: CartItem[], offeredTotal: number): { cart: CartItem[]; acceptedTotal: number; accepted: boolean } {
  const listTotal = cart.reduce((sum, item) => sum + item.unitPrice * item.quantity, 0)
  if (listTotal <= 0) return { cart, acceptedTotal: offeredTotal, accepted: false }

  const proportional = cart.map(item => {
    const allocatedLineTotal = (item.unitPrice * item.quantity / listTotal) * offeredTotal
    const allocatedUnit = allocatedLineTotal / item.quantity
    const floor = item.floorUnitPrice ?? item.unitPrice
    return {
      ...item,
      negotiatedUnitPrice: Math.max(allocatedUnit, floor),
    }
  })
  const clampedTotal = cartTotal(proportional)
  return {
    cart: proportional,
    acceptedTotal: clampedTotal,
    accepted: clampedTotal <= offeredTotal,
  }
}

export class CheckoutEngine {
  private resolver = new CatalogResolver()

  decide(input: {
    runtime: BotRuntimeContext
    intent: SalesIntent
    catalog: ProductRow[]
    merchantName?: string | null
    messageId: string
  }): BotDecision {
    const runtime: BotRuntimeContext = {
      ...input.runtime,
      cart: input.runtime.cart.map(item => ({ ...item })),
      recentIntentTypes: [
        ...(input.runtime.recentIntentTypes ?? []),
        { messageId: input.messageId, type: input.intent.type, ts: new Date().toISOString() },
      ].slice(-10),
    }

    if (runtime.lastCustomerMessageId === input.messageId) return { type: 'NOOP', reason: 'duplicate_message' }
    runtime.lastCustomerMessageId = input.messageId

    if (runtime.checkoutStage === 'human_handoff' && runtime.automationPausedUntil && new Date(runtime.automationPausedUntil) > new Date()) {
      return { type: 'NOOP', reason: 'human_handoff_active', contextPatch: runtimeContextPatch(runtime) }
    }

    switch (input.intent.type) {
      case 'greeting': {
        const active = input.catalog.filter(product => product.active && product.stockQuantity > 0).slice(0, 4)
        const suffix = active.length ? ` We have ${active.map(product => product.name).join(', ')}.` : ''
        runtime.checkoutStage = 'product_selection'
        return {
          type: 'SEND_CUSTOMER_REPLY',
          message: `Hi! Welcome to ${input.merchantName ?? 'the shop'}. What would you like to buy today?${suffix}`,
          contextPatch: runtimeContextPatch(runtime),
        }
      }

      case 'catalog_question': {
        const matches = input.intent.category
          ? this.resolver.categoryMatches(input.intent.category, input.catalog)
          : input.catalog.filter(product => product.active && product.stockQuantity > 0).slice(0, 8)
        runtime.checkoutStage = 'product_selection'
        const message = matches.length
          ? optionList(input.intent.category ?? 'product', matches)
          : 'What product are you looking for?'
        return { type: 'SEND_CUSTOMER_REPLY', message, contextPatch: runtimeContextPatch(runtime) }
      }

      case 'product_price_question': {
        const exactItems: CartItem[] = []
        let clarification: { label: string; candidates: ProductRow[] } | undefined
        for (const item of input.intent.items) {
          const resolution = this.resolver.resolve(item.name, input.catalog)
          if (resolution.type === 'exact') {
            exactItems.push(productToCartItem(resolution.product, item.quantity))
          } else if (resolution.type === 'category') {
            clarification = { label: resolution.category, candidates: resolution.candidates }
          } else if (resolution.type === 'ambiguous') {
            clarification = { label: resolution.rawName, candidates: resolution.candidates }
          } else if (resolution.type === 'out_of_stock') {
            runtime.checkoutStage = 'product_selection'
            return {
              type: 'SEND_CUSTOMER_REPLY',
              message: `${resolution.product.name} is currently out of stock.`,
              contextPatch: runtimeContextPatch(runtime),
            }
          }
        }

        if (exactItems.length > 0) {
          runtime.cart = mergeCart(runtime.cart, exactItems)
          runtime.activeItemKey = exactItems.length === 1 ? exactItems[0].key : undefined
          runtime.lastQuoteTotal = cartTotal(runtime.cart)
          runtime.checkoutStage = 'product_selection'
          runtime.awaitingCartConfirmation = false
        }
        if (clarification) {
          runtime.checkoutStage = 'product_clarification'
          return { type: 'SEND_CUSTOMER_REPLY', message: optionList(clarification.label, clarification.candidates), contextPatch: runtimeContextPatch(runtime) }
        }
        if (exactItems.length === 1) {
          const item = exactItems[0]
          return {
            type: 'SEND_CUSTOMER_REPLY',
            message: `${item.productName} is ${money(item.unitPrice)}. Would you like to order it?`,
            contextPatch: runtimeContextPatch(runtime),
          }
        }
        if (exactItems.length > 1) {
          const lines = exactItems.map(item => `${item.quantity}x ${item.productName} - ${money(cartItemTotal(item))}`)
          return {
            type: 'SEND_CUSTOMER_REPLY',
            message: ['Here are the prices:', ...lines, '', `Total: ${money(cartTotal(exactItems))}`, '', 'Would you like to order these?'].join('\n'),
            contextPatch: runtimeContextPatch(runtime),
          }
        }
        runtime.checkoutStage = 'product_selection'
        return { type: 'SEND_CUSTOMER_REPLY', message: 'Which item are you asking about?', contextPatch: runtimeContextPatch(runtime) }
      }

      case 'product_request': {
        const exactItems: CartItem[] = []
        let clarification: { label: string; candidates: ProductRow[] } | undefined
        for (const item of input.intent.items) {
          const resolution = this.resolver.resolve(item.name, input.catalog)
          if (resolution.type === 'exact') {
            exactItems.push(productToCartItem(resolution.product, item.quantity))
          } else if (resolution.type === 'category') {
            clarification = { label: resolution.category, candidates: resolution.candidates }
          } else if (resolution.type === 'ambiguous') {
            clarification = { label: resolution.rawName, candidates: resolution.candidates }
          } else if (resolution.type === 'out_of_stock') {
            runtime.checkoutStage = 'human_handoff'
            runtime.activeItemKey = undefined
            runtime.automationPausedUntil = new Date(Date.now() + 30 * 60 * 1000).toISOString()
            runtime.escalationReason = 'out_of_stock'
            return {
              type: 'SEND_MERCHANT_ALERT',
              message: `Stock check needed - ${resolution.product.name}. Customer wants to order but stock is insufficient.`,
              customerReply: `Let me confirm stock availability for ${resolution.product.name} and get back to you.`,
              contextPatch: runtimeContextPatch(runtime),
            }
          } else {
            runtime.checkoutStage = 'human_handoff'
            runtime.activeItemKey = undefined
            runtime.automationPausedUntil = new Date(Date.now() + 30 * 60 * 1000).toISOString()
            runtime.escalationReason = 'unknown_product'
            return {
              type: 'SEND_MERCHANT_ALERT',
              message: `Customer needs attention: unknown product "${resolution.rawName}"`,
              customerReply: `Let me confirm if we have ${resolution.rawName} available. I'll get back to you shortly.`,
              contextPatch: runtimeContextPatch(runtime),
            }
          }
        }

        if (exactItems.length > 0) {
          runtime.cart = mergeCart(runtime.cart, exactItems)
          runtime.activeItemKey = exactItems.length === 1 ? exactItems[0].key : undefined
          runtime.lastQuoteTotal = cartTotal(runtime.cart)
        }
        if (clarification) {
          runtime.checkoutStage = 'product_clarification'
          return { type: 'SEND_CUSTOMER_REPLY', message: optionList(clarification.label, clarification.candidates), contextPatch: runtimeContextPatch(runtime) }
        }
        if (runtime.cart.length === 0) {
          runtime.checkoutStage = 'product_selection'
          return { type: 'SEND_CUSTOMER_REPLY', message: 'What product are you looking for?', contextPatch: runtimeContextPatch(runtime) }
        }
        runtime.checkoutStage = 'cart_review'
        runtime.activeItemKey = undefined
        runtime.awaitingCartConfirmation = true
        return { type: 'SEND_CUSTOMER_REPLY', message: cartReviewText(runtime.cart), contextPatch: runtimeContextPatch(runtime) }
      }

      case 'quantity_update': {
        const active = runtime.activeItemKey ? runtime.cart.find(item => item.key === runtime.activeItemKey) : undefined
        if (!active) {
          return { type: 'SEND_CUSTOMER_REPLY', message: 'Which item should I update?', contextPatch: runtimeContextPatch(runtime) }
        }
        active.quantity = input.intent.quantity
        active.negotiatedUnitPrice = undefined
        runtime.lastQuoteTotal = cartTotal(runtime.cart)
        runtime.checkoutStage = 'cart_review'
        runtime.activeItemKey = undefined
        runtime.awaitingCartConfirmation = true
        return { type: 'SEND_CUSTOMER_REPLY', message: cartReviewText(runtime.cart), contextPatch: runtimeContextPatch(runtime) }
      }

      case 'price_negotiation': {
        if (runtime.cart.length === 0) return { type: 'SEND_CUSTOMER_REPLY', message: 'Which item are you asking about?', contextPatch: runtimeContextPatch(runtime) }
        if (input.intent.asksLastPrice && !input.intent.offeredTotal) {
          runtime.cart = runtime.cart.map(item => ({
            ...item,
            negotiatedUnitPrice: item.floorUnitPrice ?? item.unitPrice,
          }))
          const floorTotal = cartTotal(runtime.cart)
          runtime.lastQuoteTotal = floorTotal
          runtime.checkoutStage = 'cart_review'
          runtime.awaitingCartConfirmation = true
          return { type: 'SEND_CUSTOMER_REPLY', message: `${money(floorTotal)} is the best I can do.`, contextPatch: runtimeContextPatch(runtime) }
        }
        if (!input.intent.offeredTotal) return { type: 'SEND_CUSTOMER_REPLY', message: 'What price are you offering?', contextPatch: runtimeContextPatch(runtime) }
        const allocated = allocateNegotiated(runtime.cart, input.intent.offeredTotal)
        runtime.cart = allocated.cart
        runtime.lastQuoteTotal = allocated.acceptedTotal
        runtime.checkoutStage = 'product_selection'
        return {
          type: 'SEND_CUSTOMER_REPLY',
          message: allocated.accepted
            ? `I can do ${money(input.intent.offeredTotal)} for everything.`
            : `The best I can do is ${money(allocated.acceptedTotal)} for everything.`,
          contextPatch: runtimeContextPatch(runtime),
        }
      }

      case 'cart_rejection_or_confusion': {
        if (input.intent.reason === 'total_explanation' && runtime.cart.length > 0) {
          return { type: 'SEND_CUSTOMER_REPLY', message: cartExplanationText(runtime.cart), contextPatch: runtimeContextPatch(runtime) }
        }
        return { type: 'SEND_CUSTOMER_REPLY', message: 'What should I change?', contextPatch: runtimeContextPatch(runtime) }
      }

      case 'cart_correction': {
        runtime.cart = removeFromCart(runtime.cart, input.intent.remove)
        runtime.activeItemKey = runtime.cart.at(-1)?.key
        runtime.awaitingCartConfirmation = false
        runtime.checkoutStage = 'product_selection'
        runtime.lastQuoteTotal = cartTotal(runtime.cart) || undefined
        const message = runtime.cart.length > 0
          ? `${cartExplanationText(runtime.cart)}\n\nWhat else should I change or add?`
          : 'Noted. What would you like to order?'
        return { type: 'SEND_CUSTOMER_REPLY', message, contextPatch: runtimeContextPatch(runtime) }
      }

      case 'cart_confirmation': {
        if (runtime.checkoutStage !== 'cart_review') {
          return { type: 'SEND_CUSTOMER_REPLY', message: runtime.cart.length > 0 ? cartReviewText(runtime.cart) : 'What would you like to order?', contextPatch: runtimeContextPatch(runtime) }
        }
        const total = cartTotal(runtime.cart)
        if (total <= 0 || runtime.cart.length === 0) return { type: 'SEND_CUSTOMER_REPLY', message: 'What would you like to order?', contextPatch: runtimeContextPatch(runtime) }
        runtime.checkoutStage = 'cart_confirmed'
        runtime.activeItemKey = undefined
        runtime.awaitingCartConfirmation = false
        runtime.lastQuoteTotal = total
        return {
          type: 'CREATE_ORDER',
          items: runtime.cart,
          total,
          customerReply: 'Order confirmed. I will send the payment details shortly.',
          contextPatch: runtimeContextPatch(runtime),
        }
      }

      case 'payment_request': {
        if (runtime.checkoutStage === 'cart_review') {
          const total = cartTotal(runtime.cart)
          runtime.checkoutStage = 'cart_confirmed'
          runtime.activeItemKey = undefined
          return {
            type: 'CREATE_ORDER',
            items: runtime.cart,
            total,
            customerReply: 'Order confirmed. I will send the payment details shortly.',
            contextPatch: runtimeContextPatch(runtime),
          }
        }
        return { type: 'SEND_CUSTOMER_REPLY', message: 'I need to confirm your cart before payment.', contextPatch: runtimeContextPatch(runtime) }
      }

      case 'payment_claim': {
        if (runtime.checkoutStage === 'payment_pending' && runtime.orderId) {
          runtime.checkoutStage = 'payment_review'
          runtime.activeItemKey = undefined
          return {
            type: 'START_PAYMENT_REVIEW',
            orderId: runtime.orderId,
            proofHashOrDone: input.intent.proofHashOrDone ?? 'done',
            customerReply: 'Thanks. I have sent this to the merchant to confirm payment.',
            contextPatch: runtimeContextPatch(runtime),
          }
        }
        return { type: 'NOOP', reason: 'payment_claim_without_pending_order', contextPatch: runtimeContextPatch(runtime) }
      }

      case 'smalltalk_or_faq': {
        const question = input.intent.question.toLowerCase()
        const message = /\b(thanks|thank you)\b/.test(question)
          ? 'You are welcome. What would you like to order?'
          : 'What would you like to know about our products?'
        return { type: 'SEND_CUSTOMER_REPLY', message, contextPatch: runtimeContextPatch(runtime) }
      }

      case 'complaint_or_confusion': {
        runtime.checkoutStage = 'human_handoff'
        runtime.activeItemKey = undefined
        runtime.automationPausedUntil = new Date(Date.now() + 30 * 60 * 1000).toISOString()
        runtime.escalationReason = input.intent.reason
        return {
          type: 'SEND_MERCHANT_ALERT',
          message: `Customer needs attention: ${input.intent.reason}`,
          customerReply: 'Let me ask someone from the store to help with this.',
          contextPatch: runtimeContextPatch(runtime),
        }
      }

      default:
        return { type: 'NOOP', reason: `unhandled_${input.intent.type}`, contextPatch: runtimeContextPatch(runtime) }
    }
  }
}
