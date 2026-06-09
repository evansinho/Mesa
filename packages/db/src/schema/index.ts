import {
  pgTable,
  pgEnum,
  uuid,
  text,
  timestamp,
  integer,
  numeric,
  jsonb,
  boolean,
  index,
  uniqueIndex,
} from 'drizzle-orm/pg-core'
import { relations } from 'drizzle-orm'

// ─── Enums ──────────────────────────────────────────────────────────────────

export const subscriptionTierEnum = pgEnum('subscription_tier', [
  'starter',
  'growth',
  'business',
])

export const subscriptionStatusEnum = pgEnum('subscription_status', [
  'trialing',
  'active',
  'past_due',
  'expired',
  'cancelled',
])

export const billingEventTypeEnum = pgEnum('billing_event_type', [
  'trial_started',
  'trial_warning_sent',
  'trial_expired',
  'subscription_created',
  'charge_success',
  'charge_failed',
  'subscription_cancelled',
])

export const conversationStateEnum = pgEnum('conversation_state', [
  'IDLE',
  'BROWSING',
  'NEGOTIATING',
  'AGREED',
  'ORDER_CREATED',
  'AWAITING_PAYMENT',
  'PAYMENT_RECEIVED',
  'COMPLETE',
])

export const orderStatusEnum = pgEnum('order_status', [
  'PENDING',
  'CONFIRMED',
  'AWAITING_PAYMENT',
  'PAID',
  'FULFILLED',
  'CANCELLED',
])

export const paymentStatusEnum = pgEnum('payment_status', [
  'PENDING',
  'CONFIRMED',
  'FAILED',
  'DISPUTED',
])

export const inventoryEventReasonEnum = pgEnum('inventory_event_reason', [
  'SALE',
  'RESTOCK',
  'ADJUSTMENT',
  'RETURN',
  'WRITE_OFF',
])

// ─── Tables ──────────────────────────────────────────────────────────────────

export const merchants = pgTable('merchants', {
  id: uuid('id').primaryKey().defaultRandom(),
  name: text('name').notNull(),
  phone: text('phone').notNull(),
  email: text('email'),
  businessType: text('business_type'),
  subscriptionTier: subscriptionTierEnum('subscription_tier').default('starter').notNull(),
  subscriptionStatus: subscriptionStatusEnum('subscription_status').default('trialing').notNull(),
  trialEndsAt: timestamp('trial_ends_at', { withTimezone: true }),
  config: jsonb('config').$type<Record<string, unknown>>().default({}).notNull(),
  active: boolean('active').default(true).notNull(),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
}, (t) => ({
  phoneIdx: uniqueIndex('merchants_phone_idx').on(t.phone),
}))

export const products = pgTable('products', {
  id: uuid('id').primaryKey().defaultRandom(),
  merchantId: uuid('merchant_id').notNull().references(() => merchants.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),
  description: text('description'),
  price: numeric('price', { precision: 12, scale: 2 }).notNull(),
  stockQuantity: integer('stock_quantity').default(0).notNull(),
  lowStockThreshold: integer('low_stock_threshold').default(5).notNull(),
  unit: text('unit').default('unit').notNull(),
  sku: text('sku'),
  aliases: text('aliases').array().default([]).notNull(),
  active: boolean('active').default(true).notNull(),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
}, (t) => ({
  merchantIdx: index('products_merchant_idx').on(t.merchantId),
}))

export const conversations = pgTable('conversations', {
  id: uuid('id').primaryKey().defaultRandom(),
  merchantId: uuid('merchant_id').notNull().references(() => merchants.id, { onDelete: 'cascade' }),
  channel: text('channel').default('whatsapp').notNull(),
  customerPhone: text('customer_phone').notNull(),
  customerName: text('customer_name'),
  state: conversationStateEnum('state').default('IDLE').notNull(),
  // Stores current items, negotiation history, last prices - synced from Redis on state change
  context: jsonb('context').$type<Record<string, unknown>>().default({}).notNull(),
  expiresAt: timestamp('expires_at'),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
}, (t) => ({
  merchantChannelCustomerIdx: uniqueIndex('conversations_merchant_channel_customer_idx').on(
    t.merchantId,
    t.channel,
    t.customerPhone
  ),
}))

export const orders = pgTable('orders', {
  id: uuid('id').primaryKey().defaultRandom(),
  merchantId: uuid('merchant_id').notNull().references(() => merchants.id),
  conversationId: uuid('conversation_id').references(() => conversations.id),
  customerPhone: text('customer_phone').notNull(),
  customerName: text('customer_name'),
  status: orderStatusEnum('status').default('PENDING').notNull(),
  subtotal: numeric('subtotal', { precision: 12, scale: 2 }).notNull(),
  total: numeric('total', { precision: 12, scale: 2 }).notNull(),
  notes: text('notes'),
  followUpSentAt: timestamp('follow_up_sent_at'),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
}, (t) => ({
  merchantIdx: index('orders_merchant_idx').on(t.merchantId),
  statusIdx: index('orders_status_idx').on(t.status),
}))

export const orderItems = pgTable('order_items', {
  id: uuid('id').primaryKey().defaultRandom(),
  orderId: uuid('order_id').notNull().references(() => orders.id, { onDelete: 'cascade' }),
  productId: uuid('product_id').references(() => products.id),
  productName: text('product_name').notNull(), // snapshot at time of order
  quantity: integer('quantity').notNull(),
  unitPrice: numeric('unit_price', { precision: 12, scale: 2 }).notNull(), // listed price
  agreedPrice: numeric('agreed_price', { precision: 12, scale: 2 }).notNull(), // negotiated price
})

export const payments = pgTable('payments', {
  id: uuid('id').primaryKey().defaultRandom(),
  orderId: uuid('order_id').notNull().references(() => orders.id),
  merchantId: uuid('merchant_id').notNull().references(() => merchants.id),
  amount: numeric('amount', { precision: 12, scale: 2 }),
  screenshotUrl: text('screenshot_url'),
  screenshotHash: text('screenshot_hash'), // SHA256 hash for idempotency
  status: paymentStatusEnum('status').default('PENDING').notNull(),
  rawOcrData: jsonb('raw_ocr_data').$type<Record<string, unknown>>(),
  reference: text('reference'), // bank reference number
  bankName: text('bank_name'),
  confirmedAt: timestamp('confirmed_at'),
  createdAt: timestamp('created_at').defaultNow().notNull(),
}, (t) => ({
  screenshotHashIdx: uniqueIndex('payments_screenshot_hash_idx').on(t.screenshotHash),
  orderIdx: index('payments_order_idx').on(t.orderId),
}))

export const inventoryEvents = pgTable('inventory_events', {
  id: uuid('id').primaryKey().defaultRandom(),
  productId: uuid('product_id').notNull().references(() => products.id),
  merchantId: uuid('merchant_id').notNull().references(() => merchants.id),
  delta: integer('delta').notNull(), // positive = stock in, negative = stock out
  reason: inventoryEventReasonEnum('reason').notNull(),
  orderId: uuid('order_id').references(() => orders.id),
  createdAt: timestamp('created_at').defaultNow().notNull(),
}, (t) => ({
  productIdx: index('inventory_events_product_idx').on(t.productId),
}))

export const agentTasks = pgTable('agent_tasks', {
  id: uuid('id').primaryKey().defaultRandom(),
  merchantId: uuid('merchant_id').notNull().references(() => merchants.id),
  type: text('type').notNull(),
  status: text('status').default('OPEN').notNull(),
  payload: jsonb('payload').$type<Record<string, unknown>>().default({}).notNull(),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  // Signed action token fields — set when the task has a WhatsApp action link
  actionTokenHash: text('action_token_hash'),
  expiresAt: timestamp('expires_at'),
  resolvedAt: timestamp('resolved_at'),
  resolvedBy: text('resolved_by'), // 'webhook' | 'dashboard' | 'action_page'
}, (t) => ({
  merchantIdx: index('agent_tasks_merchant_idx').on(t.merchantId),
  tokenHashIdx: index('agent_tasks_token_hash_idx').on(t.actionTokenHash),
}))

export const messageTemplates = pgTable('message_templates', {
  id: uuid('id').primaryKey().defaultRandom(),
  merchantId: uuid('merchant_id').notNull().references(() => merchants.id),
  name: text('name').notNull(),
  channel: text('channel').default('whatsapp').notNull(),
  body: text('body').notNull(),
  createdAt: timestamp('created_at').defaultNow().notNull(),
}, (t) => ({
  merchantIdx: index('message_templates_merchant_idx').on(t.merchantId),
}))

export const merchantChannels = pgTable('merchant_channels', {
  id: uuid('id').primaryKey().defaultRandom(),
  merchantId: uuid('merchant_id').notNull().references(() => merchants.id, { onDelete: 'cascade' }),
  channel: text('channel').notNull(), // 'whatsapp' | 'instagram'
  channelAccountId: text('channel_account_id').notNull(),
  // WhatsApp: long-lived system access token from embedded signup. Used to
  // send customer-facing messages from the merchant's own WABA number. Treat
  // as a secret — anyone holding this can send messages as the merchant.
  accessToken: text('access_token'),
  status: text('status').default('connected').notNull(),
  connectedAt: timestamp('connected_at').defaultNow().notNull(),
}, (t) => ({
  merchantIdx: index('merchant_channels_merchant_idx').on(t.merchantId),
  channelAccountIdx: uniqueIndex('merchant_channels_channel_account_idx').on(t.channel, t.channelAccountId),
}))

export const authMagicLinks = pgTable('auth_magic_links', {
  id: uuid('id').primaryKey().defaultRandom(),
  merchantId: uuid('merchant_id').notNull().references(() => merchants.id),
  tokenHash: text('token_hash').notNull(),
  expiresAt: timestamp('expires_at').notNull(),
  usedAt: timestamp('used_at'),
  createdAt: timestamp('created_at').defaultNow().notNull(),
}, (t) => ({
  merchantIdx: index('auth_magic_links_merchant_idx').on(t.merchantId),
  tokenIdx: index('auth_magic_links_token_idx').on(t.tokenHash),
}))

export const authSessions = pgTable('auth_sessions', {
  id: uuid('id').primaryKey().defaultRandom(),
  merchantId: uuid('merchant_id').notNull().references(() => merchants.id),
  sessionHash: text('session_hash').notNull(),
  expiresAt: timestamp('expires_at').notNull(),
  createdAt: timestamp('created_at').defaultNow().notNull(),
}, (t) => ({
  merchantIdx: index('auth_sessions_merchant_idx').on(t.merchantId),
  sessionIdx: index('auth_sessions_session_idx').on(t.sessionHash),
}))

// Immutable event store + transactional outbox. Every domain event is appended
// here in the same transaction as the business write that produced it. The
// outbox publisher (apps/worker/src/events/outbox-publisher.ts) polls unpublished
// rows and emits them to NATS.
export const domainEvents = pgTable('domain_events', {
  id: uuid('id').primaryKey().defaultRandom(),
  aggregateId: text('aggregate_id').notNull(),
  aggregateType: text('aggregate_type').notNull(), // 'conversation' | 'order' | 'payment'
  eventType: text('event_type').notNull(),
  payload: jsonb('payload').$type<Record<string, unknown>>().notNull(),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  publishedAt: timestamp('published_at'),
  publishAttempts: integer('publish_attempts').default(0).notNull(),
  lastPublishError: text('last_publish_error'),
}, (t) => ({
  aggregateIdx: index('domain_events_aggregate_idx').on(t.aggregateId, t.aggregateType),
  createdAtIdx: index('domain_events_created_at_idx').on(t.createdAt),
  aggregateEventIdx: index('domain_events_aggregate_event_idx').on(t.aggregateId, t.eventType),
  // domain_events_appendonce_idx and domain_events_unpublished_idx are partial
  // indexes; Drizzle's pg-core can't express them inline, so they live only in
  // the migration (0014_outbox_publisher.sql).
}))

// ─── Relations ───────────────────────────────────────────────────────────────

// Outbound notification delivery failures. One row per failed send
// attempt. Operators triage from a dashboard query (GET /notifications/failures).
// resolvedAt is set when ops marks the failure handled or when a later attempt
// succeeds.
export const notificationFailures = pgTable('notification_failures', {
  id: uuid('id').primaryKey().defaultRandom(),
  merchantId: uuid('merchant_id').notNull().references(() => merchants.id, { onDelete: 'cascade' }),
  channel: text('channel').notNull(), // 'whatsapp' | 'instagram'
  recipient: text('recipient').notNull(),
  message: text('message').notNull(),
  errorMessage: text('error_message').notNull(),
  resolvedAt: timestamp('resolved_at'),
  createdAt: timestamp('created_at').defaultNow().notNull(),
}, (t) => ({
  merchantIdx: index('notification_failures_merchant_idx').on(t.merchantId),
  unresolvedIdx: index('notification_failures_unresolved_idx').on(t.createdAt),
}))

// Per-call audit trail for AI usage. One row per call to Claude (NLP or OCR).
// Used by the cost dashboard and by F-10's quota enforcement to reconcile
// Redis-tracked daily counts. costUsdMicros stores rough estimates; exact
// reconciliation should pair with Anthropic's billing export.
export const aiUsage = pgTable('ai_usage', {
  id: uuid('id').primaryKey().defaultRandom(),
  merchantId: uuid('merchant_id').notNull().references(() => merchants.id, { onDelete: 'cascade' }),
  model: text('model').notNull(), // 'haiku' | 'sonnet'
  costUsdMicros: integer('cost_usd_micros').notNull(),
  inputTokens: integer('input_tokens'),
  outputTokens: integer('output_tokens'),
  createdAt: timestamp('created_at').defaultNow().notNull(),
}, (t) => ({
  merchantIdx: index('ai_usage_merchant_idx').on(t.merchantId),
  merchantDateIdx: index('ai_usage_merchant_date_idx').on(t.merchantId, t.createdAt),
}))

export const subscriptions = pgTable('subscriptions', {
  id: uuid('id').primaryKey().defaultRandom(),
  merchantId: uuid('merchant_id').notNull().references(() => merchants.id, { onDelete: 'cascade' }),
  plan: subscriptionTierEnum('plan').default('starter').notNull(),
  status: text('status').notNull(),
  paystackCustomerCode: text('paystack_customer_code'),
  paystackSubscriptionCode: text('paystack_subscription_code'),
  paystackEmailToken: text('paystack_email_token'),
  paystackPlanCode: text('paystack_plan_code').notNull(),
  amountKobo: integer('amount_kobo').notNull(),
  currentPeriodStart: timestamp('current_period_start', { withTimezone: true }).notNull(),
  currentPeriodEnd: timestamp('current_period_end', { withTimezone: true }).notNull(),
  cancelledAt: timestamp('cancelled_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
}, (t) => ({
  merchantIdx: index('subscriptions_merchant_idx').on(t.merchantId),
  subscriptionCodeIdx: index('subscriptions_paystack_subscription_code_idx').on(t.paystackSubscriptionCode),
}))

export const billingEvents = pgTable('billing_events', {
  id: uuid('id').primaryKey().defaultRandom(),
  merchantId: uuid('merchant_id').notNull().references(() => merchants.id, { onDelete: 'cascade' }),
  type: billingEventTypeEnum('type').notNull(),
  eventKey: text('event_key'),
  metadata: jsonb('metadata').$type<Record<string, unknown>>().default({}).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
}, (t) => ({
  merchantIdx: index('billing_events_merchant_idx').on(t.merchantId, t.createdAt),
  eventKeyIdx: uniqueIndex('billing_events_event_key_idx').on(t.eventKey),
}))

export const merchantsRelations = relations(merchants, ({ many }) => ({
  products: many(products),
  conversations: many(conversations),
  orders: many(orders),
  agentTasks: many(agentTasks),
  messageTemplates: many(messageTemplates),
  channels: many(merchantChannels),
  authMagicLinks: many(authMagicLinks),
  authSessions: many(authSessions),
  subscriptions: many(subscriptions),
  billingEvents: many(billingEvents),
}))

export const merchantChannelsRelations = relations(merchantChannels, ({ one }) => ({
  merchant: one(merchants, { fields: [merchantChannels.merchantId], references: [merchants.id] }),
}))

export const productsRelations = relations(products, ({ one }) => ({
  merchant: one(merchants, { fields: [products.merchantId], references: [merchants.id] }),
}))

export const conversationsRelations = relations(conversations, ({ one, many }) => ({
  merchant: one(merchants, { fields: [conversations.merchantId], references: [merchants.id] }),
  orders: many(orders),
}))

export const ordersRelations = relations(orders, ({ one, many }) => ({
  merchant: one(merchants, { fields: [orders.merchantId], references: [merchants.id] }),
  conversation: one(conversations, { fields: [orders.conversationId], references: [conversations.id] }),
  items: many(orderItems),
  payments: many(payments),
}))

export const orderItemsRelations = relations(orderItems, ({ one }) => ({
  order: one(orders, { fields: [orderItems.orderId], references: [orders.id] }),
  product: one(products, { fields: [orderItems.productId], references: [products.id] }),
}))

export const paymentsRelations = relations(payments, ({ one }) => ({
  order: one(orders, { fields: [payments.orderId], references: [orders.id] }),
  merchant: one(merchants, { fields: [payments.merchantId], references: [merchants.id] }),
}))

export const subscriptionsRelations = relations(subscriptions, ({ one }) => ({
  merchant: one(merchants, { fields: [subscriptions.merchantId], references: [merchants.id] }),
}))

export const billingEventsRelations = relations(billingEvents, ({ one }) => ({
  merchant: one(merchants, { fields: [billingEvents.merchantId], references: [merchants.id] }),
}))
