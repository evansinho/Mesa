// ─── Conversation State Machine ────────────────────────────────────────────

export type ConversationState =
  | 'IDLE'
  | 'BROWSING'
  | 'NEGOTIATING'
  | 'AGREED'
  | 'ORDER_CREATED'
  | 'AWAITING_PAYMENT'
  | 'PAYMENT_RECEIVED'
  | 'COMPLETE'

// Valid state transitions
export const VALID_TRANSITIONS: Record<ConversationState, ConversationState[]> = {
  IDLE: ['BROWSING', 'NEGOTIATING', 'ORDER_CREATED'],
  BROWSING: ['NEGOTIATING', 'ORDER_CREATED', 'IDLE'],
  NEGOTIATING: ['AGREED', 'ORDER_CREATED', 'BROWSING', 'IDLE'],
  AGREED: ['ORDER_CREATED', 'NEGOTIATING'], // re-negotiation allowed after agreement
  ORDER_CREATED: ['AWAITING_PAYMENT'],
  AWAITING_PAYMENT: ['PAYMENT_RECEIVED', 'ORDER_CREATED'], // ORDER_CREATED for corrections
  PAYMENT_RECEIVED: ['COMPLETE'],
  COMPLETE: ['IDLE'],
}

// ─── WhatsApp Message Types ─────────────────────────────────────────────────

export type WhatsAppMessageType = 'text' | 'image' | 'document' | 'audio' | 'video'

export type ChannelType = 'whatsapp' | 'instagram'

export interface WhatsAppMessage {
  messageId: string
  from: string // customer phone number
  timestamp: number
  type: WhatsAppMessageType
  text?: string
  mediaId?: string   // for image/document/audio
  mimeType?: string
  caption?: string
}

export interface InboundMessage {
  channel: ChannelType
  channelAccountId: string
  customerId: string
  messageId: string
  timestamp: number
  type: WhatsAppMessageType
  text?: string
  mediaId?: string
  mimeType?: string
  caption?: string
}

// ─── NLP Analysis ───────────────────────────────────────────────────────────

export type MessageIntent =
  | 'ORDER'           // "I want 3 bags of rice"
  | 'INQUIRY'         // "How much for X?"
  | 'COUNTER_OFFER'   // "Abeg do ₦40,000 na"
  | 'AGREEMENT'       // "Okay deal", "e don do", "oya send"
  | 'PAYMENT_INTENT'  // "I go pay now", "sending now"
  | 'MERCHANT_SETUP'  // "add product", "update price", "check stock"
  | 'NONE'

export interface DetectedOrderItem {
  productName: string
  quantity: number
  unitPrice?: number  // price as quoted/discussed
  agreedPrice?: number
}

export interface NLPResult {
  intent: MessageIntent
  items: DetectedOrderItem[]
  agreementSignalDetected: boolean
  lastMentionedPrice?: number
  counterOfferPrice?: number
  confidence: number
}

// ─── OCR Result ─────────────────────────────────────────────────────────────

export interface OCRResult {
  amount?: number
  reference?: string
  bankName?: string
  accountName?: string
  transactionDate?: string
  confidence: number // 0-1
  rawText: string
  // F-10b: which Claude model produced the final result.
  modelUsed?: 'haiku' | 'sonnet'
  // True if Haiku ran first but its confidence was below the escalation
  // threshold and we retried with Sonnet. Used by the cost dashboard.
  escalated?: boolean
}

// ─── NATS Subjects ──────────────────────────────────────────────────────────

export const SUBJECTS = {
  // Inbound from gateway
  WHATSAPP_INBOUND: 'mesa.whatsapp.inbound',
  INBOUND_MESSAGE: 'mesa.inbound.message',
  WHATSAPP_MESSAGE_ECHO: 'mesa.whatsapp.message_echo',
  WHATSAPP_HISTORY_SYNC: 'mesa.whatsapp.history_sync',
  WHATSAPP_CONTACT_SYNC: 'mesa.whatsapp.contact_sync',

  // Conversation state machine
  CONVERSATION_STATE_CHANGED: 'mesa.conversation.state_changed',

  // Order lifecycle
  ORDER_DETECTED: 'mesa.order.detected',
  ORDER_CONFIRMED: 'mesa.order.confirmed',
  ORDER_CANCELLED: 'mesa.order.cancelled',

  // Payment
  PAYMENT_SCREENSHOT_RECEIVED: 'mesa.payment.screenshot_received',
  PAYMENT_CONFIRMED: 'mesa.payment.confirmed',
  PAYMENT_FAILED: 'mesa.payment.failed',

  // Inventory
  INVENTORY_UPDATED: 'mesa.inventory.updated',
  INVENTORY_LOW: 'mesa.inventory.low',

  // Notifications (outbound to WhatsApp)
  NOTIFICATION_SEND: 'mesa.notification.send',
} as const

// ─── NATS Event Payloads ────────────────────────────────────────────────────

export interface WhatsAppInboundEvent {
  subject: typeof SUBJECTS.WHATSAPP_INBOUND
  merchantId: string
  message: WhatsAppMessage
}

export interface InboundMessageEvent {
  subject: typeof SUBJECTS.INBOUND_MESSAGE
  merchantId: string
  message: InboundMessage
}

export interface WhatsAppMessageEchoEvent {
  subject: typeof SUBJECTS.WHATSAPP_MESSAGE_ECHO
  merchantId: string
  message: InboundMessage
}

export interface WhatsAppHistorySyncEvent {
  subject: typeof SUBJECTS.WHATSAPP_HISTORY_SYNC
  merchantId: string
  channelAccountId: string
  messages: Array<InboundMessage & { direction: 'customer' | 'vendor'; historical: true }>
}

export interface WhatsAppContactSyncEvent {
  subject: typeof SUBJECTS.WHATSAPP_CONTACT_SYNC
  merchantId: string
  channelAccountId: string
  contacts: Array<{
    customerId: string
    name?: string
    updatedAt?: string
  }>
}

export interface ConversationStateChangedEvent {
  subject: typeof SUBJECTS.CONVERSATION_STATE_CHANGED
  conversationId: string
  merchantId: string
  customerPhone: string
  from: ConversationState
  to: ConversationState
  context: ConversationContext
}

export interface OrderDetectedEvent {
  subject: typeof SUBJECTS.ORDER_DETECTED
  conversationId: string
  merchantId: string
  customerPhone: string
  customerName?: string
  items: DetectedOrderItem[]
  agreedTotal?: number
}

export interface OrderConfirmedEvent {
  subject: typeof SUBJECTS.ORDER_CONFIRMED
  orderId: string
  merchantId: string
  conversationId?: string
}

export interface PaymentScreenshotReceivedEvent {
  subject: typeof SUBJECTS.PAYMENT_SCREENSHOT_RECEIVED
  orderId: string
  merchantId: string
  screenshotUrl: string
  screenshotHash: string
}

export interface PaymentConfirmedEvent {
  subject: typeof SUBJECTS.PAYMENT_CONFIRMED
  orderId: string
  merchantId: string
  amount: number
  reference?: string
}

export interface InventoryUpdatedEvent {
  subject: typeof SUBJECTS.INVENTORY_UPDATED
  productId: string
  merchantId: string
  delta: number
  newQuantity: number
  orderId?: string
}

export interface InventoryLowEvent {
  subject: typeof SUBJECTS.INVENTORY_LOW
  productId: string
  merchantId: string
  newQuantity: number
}

export type WhatsAppTemplateButton =
  | { type: 'url';         index: number; urlSuffix: string }
  | { type: 'quick_reply'; index: number; payload: string }

export interface NotificationSendEvent {
  subject: typeof SUBJECTS.NOTIFICATION_SEND
  merchantId: string
  /** Recipient identifier: phone number for WhatsApp, IG-scoped user ID for Instagram */
  to: string
  channel: 'whatsapp' | 'instagram'
  message: string
  mediaUrl?: string
  /** When present, send a WhatsApp template instead of a plain text message. */
  template?: {
    name: string
    languageCode?: string
    bodyParams?: string[]
    buttons?: WhatsAppTemplateButton[]
  }
}

// ─── Conversation Context (stored in Redis) ──────────────────────────────────

export interface NegotiationEntry {
  price: number
  from: 'vendor' | 'customer'
  timestamp: string
}

export interface RecentMessage {
  role: 'customer' | 'vendor'
  text: string
  ts: string
}

export interface ConversationContext {
  currentItems: DetectedOrderItem[]
  lastQuotedPrice?: number
  agreedPrice?: number
  orderId?: string
  negotiationHistory: NegotiationEntry[]
  // F-11: rolling window of the last N raw messages, used to give Claude real
  // conversational context (not just price points). Capped to keep the prompt
  // bounded.
  recentMessages?: RecentMessage[]
  manualLastAt?: string
  automationPausedUntil?: string
  lastMessageAt: string
}
