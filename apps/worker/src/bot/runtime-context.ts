import type { ConversationContext, RecentMessage } from '@mesa/types'
import type { BotRuntimeContext, CartItem, CheckoutStage } from './types'

function toNumber(value: unknown): number | undefined {
  if (typeof value === 'number') return Number.isFinite(value) && value > 0 ? value : undefined
  if (typeof value === 'string') {
    const parsed = Number(value)
    return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined
  }
  return undefined
}

export function cartKey(productId: string): string {
  return `product:${productId}`
}

export function cartItemTotal(item: CartItem): number {
  return (item.negotiatedUnitPrice ?? item.unitPrice) * item.quantity
}

export function cartTotal(cart: CartItem[]): number {
  return cart.reduce((sum, item) => sum + cartItemTotal(item), 0)
}

export function activeCartHash(cart: CartItem[]): string {
  return cart
    .map(item => [
      item.productId,
      item.quantity,
      item.unitPrice,
      item.floorUnitPrice ?? '',
      item.negotiatedUnitPrice ?? '',
    ].join(':'))
    .sort()
    .join('|') || 'empty'
}

function runtimeStageFromLegacy(ctx: ConversationContext): CheckoutStage {
  const pausedUntil = ctx.automationPausedUntil ? new Date(ctx.automationPausedUntil).getTime() : 0
  if (pausedUntil > Date.now() || ctx.escalationReason) return 'human_handoff'
  if (ctx.checkoutStage === 'payment_review') return 'payment_review'
  if (ctx.orderId && ctx.checkoutStage === 'payment_pending') return 'payment_pending'
  if (ctx.orderId) return 'payment_pending'
  if (ctx.awaitingOrderConfirmation) return 'cart_review'
  if ((ctx.agreedPrice ?? 0) > 0) return 'cart_review'
  if (ctx.checkoutStage === 'product_clarification') return 'product_clarification'
  if (ctx.currentItems.length > 0) return 'product_selection'
  return 'idle'
}

export function legacyContextToBotRuntime(ctx: ConversationContext): BotRuntimeContext {
  const existing = ctx.botRuntime
  if (existing && Array.isArray(existing.cart) && typeof existing.checkoutStage === 'string') {
    const legacyStage = runtimeStageFromLegacy(ctx)
    const checkoutStage = ['payment_pending', 'payment_review', 'human_handoff'].includes(legacyStage)
      ? legacyStage
      : existing.checkoutStage as CheckoutStage
    return {
      checkoutStage,
      cart: existing.cart,
      sessionId: existing.sessionId ?? ctx.sessionId,
      orderId: existing.orderId ?? ctx.orderId,
      activeItemKey: existing.activeItemKey,
      lastCustomerMessageId: existing.lastCustomerMessageId,
      lastBotDecisionKey: existing.lastBotDecisionKey,
      lastQuoteTotal: existing.lastQuoteTotal,
      awaitingCartConfirmation: existing.awaitingCartConfirmation,
      automationPausedUntil: existing.automationPausedUntil,
      escalationReason: existing.escalationReason,
      recentIntentTypes: existing.recentIntentTypes as BotRuntimeContext['recentIntentTypes'],
      recentMessages: Array.isArray(existing.recentMessages) ? existing.recentMessages : (ctx.recentMessages ?? []),
    }
  }

  const cart: CartItem[] = ctx.currentItems
    .map((item, index) => {
      const legacy = item as typeof item & {
        productId?: string
        floorUnitPrice?: number
        agreedPrice?: number
      }
      const productId = legacy.productId ?? `legacy-${index}-${item.productName.toLowerCase().replace(/\s+/g, '-')}`
      const quantity = item.quantity > 0 ? item.quantity : 1
      const unitPrice = toNumber(item.unitPrice) ?? (ctx.lastQuotedPrice && ctx.currentItems.length === 1 ? ctx.lastQuotedPrice / quantity : undefined)
      if (!unitPrice) {
        console.warn(JSON.stringify({
          level: 'warn',
          msg: 'bot_runtime_hydration_missing_unit_price',
          productName: item.productName,
        }))
      }
      return {
        key: cartKey(productId),
        productId,
        productName: item.productName,
        quantity,
        unitPrice: unitPrice ?? 0,
        floorUnitPrice: toNumber(legacy.floorUnitPrice),
        negotiatedUnitPrice: legacy.agreedPrice && quantity > 0 ? legacy.agreedPrice / quantity : undefined,
      }
    })
    .filter(item => item.unitPrice > 0)

  const stage = runtimeStageFromLegacy(ctx)
  return {
    checkoutStage: stage,
    cart,
    sessionId: ctx.sessionId,
    orderId: ctx.orderId,
    activeItemKey: stage === 'cart_review' || stage === 'human_handoff' ? undefined : cart.at(-1)?.key,
    lastQuoteTotal: ctx.agreedPrice ?? ctx.lastQuotedPrice,
    awaitingCartConfirmation: ctx.awaitingOrderConfirmation || stage === 'cart_review',
    automationPausedUntil: ctx.automationPausedUntil,
    escalationReason: ctx.escalationReason,
    recentIntentTypes: [],
    recentMessages: (ctx.recentMessages ?? []) as RecentMessage[],
  }
}

export function runtimeContextPatch(runtime: BotRuntimeContext): Partial<ConversationContext> {
  const total = cartTotal(runtime.cart)
  return {
    checkoutStage: runtime.checkoutStage,
    sessionId: runtime.sessionId,
    currentItems: runtime.cart.map(item => ({
      productId: item.productId,
      productName: item.productName,
      quantity: item.quantity,
      unitPrice: item.unitPrice,
      floorUnitPrice: item.floorUnitPrice,
      agreedPrice: item.negotiatedUnitPrice ? item.negotiatedUnitPrice * item.quantity : undefined,
    })),
    lastQuotedPrice: total > 0 ? total : runtime.lastQuoteTotal,
    agreedPrice: runtime.checkoutStage === 'cart_review' || runtime.checkoutStage === 'cart_confirmed' || runtime.checkoutStage === 'payment_pending'
      ? (total > 0 ? total : runtime.lastQuoteTotal)
      : undefined,
    awaitingOrderConfirmation: runtime.checkoutStage === 'cart_review',
    orderId: runtime.orderId,
    botRuntime: runtime,
    automationPausedUntil: runtime.automationPausedUntil,
    escalationReason: runtime.escalationReason,
  }
}
