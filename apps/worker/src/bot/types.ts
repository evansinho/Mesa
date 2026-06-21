import type { ConversationContext, RecentMessage } from '@mesa/types'
import type { products } from '@mesa/db'

export type CheckoutStage =
  | 'idle'
  | 'product_selection'
  | 'product_clarification'
  | 'cart_review'
  | 'cart_confirmed'
  | 'payment_pending'
  | 'payment_review'
  | 'paid'
  | 'fulfillment_pending'
  | 'human_handoff'

export type ProductRow = typeof products.$inferSelect

export type CartItem = {
  key: string
  productId: string
  productName: string
  quantity: number
  unitPrice: number
  floorUnitPrice?: number
  negotiatedUnitPrice?: number
  selectedVariantText?: string
}

export type BotRuntimeContext = {
  checkoutStage: CheckoutStage
  cart: CartItem[]
  activeItemKey?: string
  lastCustomerMessageId?: string
  lastBotDecisionKey?: string
  lastQuoteTotal?: number
  awaitingCartConfirmation?: boolean
  automationPausedUntil?: string
  escalationReason?: string
  recentIntentTypes?: Array<{
    messageId: string
    type: SalesIntent['type']
    ts: string
  }>
  recentMessages: RecentMessage[]
}

export type ProductResolution =
  | { type: 'exact'; product: ProductRow }
  | { type: 'category'; category: string; candidates: ProductRow[] }
  | { type: 'ambiguous'; rawName: string; candidates: ProductRow[] }
  | { type: 'unknown'; rawName: string }
  | { type: 'out_of_stock'; product: ProductRow }

export type RequestedItem = {
  name: string
  quantity: number
}

export type SalesIntent =
  | { type: 'greeting' }
  | { type: 'catalog_question'; category?: string }
  | { type: 'product_request'; items: RequestedItem[] }
  | { type: 'quantity_update'; quantity: number; productRef?: string }
  | { type: 'cart_confirmation' }
  | { type: 'cart_rejection_or_confusion'; reason?: string }
  | { type: 'cart_correction'; add?: RequestedItem[]; remove?: string[] }
  | { type: 'price_negotiation'; offeredTotal?: number; productRef?: string; asksLastPrice?: boolean }
  | { type: 'payment_request' }
  | { type: 'payment_claim'; proofHashOrDone?: string }
  | { type: 'complaint_or_confusion'; reason: string }
  | { type: 'smalltalk_or_faq'; question: string }
  | { type: 'unknown' }

export type BotDecision =
  | { type: 'NOOP'; reason: string; contextPatch?: Partial<ConversationContext> }
  | { type: 'SEND_CUSTOMER_REPLY'; message: string; contextPatch?: Partial<ConversationContext> }
  | { type: 'SEND_MERCHANT_ALERT'; message: string; customerReply?: string; contextPatch?: Partial<ConversationContext> }
  | { type: 'CREATE_ORDER'; total: number; items: CartItem[]; customerReply: string; contextPatch?: Partial<ConversationContext> }
  | { type: 'REQUEST_PAYMENT'; orderId: string; total: number; customerReply: string; contextPatch?: Partial<ConversationContext> }
  | { type: 'START_PAYMENT_REVIEW'; orderId: string; proofUrl?: string; proofHashOrDone?: string; customerReply: string; contextPatch?: Partial<ConversationContext> }
  | { type: 'START_FULFILLMENT'; orderId: string; customerReply: string; contextPatch?: Partial<ConversationContext> }
