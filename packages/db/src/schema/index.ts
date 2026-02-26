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
  whatsappNumberId: text('whatsapp_number_id'),
  wabaId: text('waba_id'),
  businessType: text('business_type'),
  subscriptionTier: subscriptionTierEnum('subscription_tier').default('starter').notNull(),
  config: jsonb('config').$type<Record<string, unknown>>().default({}).notNull(),
  active: boolean('active').default(true).notNull(),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
}, (t) => ({
  phoneIdx: uniqueIndex('merchants_phone_idx').on(t.phone),
  whatsappNumberIdx: uniqueIndex('merchants_whatsapp_number_idx').on(t.whatsappNumberId),
}))

export const products = pgTable('products', {
  id: uuid('id').primaryKey().defaultRandom(),
  merchantId: uuid('merchant_id').notNull().references(() => merchants.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),
  description: text('description'),
  price: numeric('price', { precision: 12, scale: 2 }).notNull(),
  stockQuantity: integer('stock_quantity').default(0).notNull(),
  lowStockThreshold: integer('low_stock_threshold').default(5).notNull(),
  unit: text('unit').default('unit').notNull(), // 'bag', 'bottle', 'piece', 'kg'
  sku: text('sku'),
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
  merchantCustomerIdx: uniqueIndex('conversations_merchant_customer_idx').on(
    t.merchantId,
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
  type: text('type').notNull(), // 'ONBOARDING_FOLLOWUP'
  status: text('status').default('OPEN').notNull(),
  payload: jsonb('payload').$type<Record<string, unknown>>().default({}).notNull(),
  createdAt: timestamp('created_at').defaultNow().notNull(),
}, (t) => ({
  merchantIdx: index('agent_tasks_merchant_idx').on(t.merchantId),
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

// Immutable event store — every domain event is appended here
export const domainEvents = pgTable('domain_events', {
  id: uuid('id').primaryKey().defaultRandom(),
  aggregateId: text('aggregate_id').notNull(),
  aggregateType: text('aggregate_type').notNull(), // 'conversation' | 'order' | 'payment'
  eventType: text('event_type').notNull(),
  payload: jsonb('payload').$type<Record<string, unknown>>().notNull(),
  createdAt: timestamp('created_at').defaultNow().notNull(),
}, (t) => ({
  aggregateIdx: index('domain_events_aggregate_idx').on(t.aggregateId, t.aggregateType),
  createdAtIdx: index('domain_events_created_at_idx').on(t.createdAt),
  aggregateEventIdx: uniqueIndex('domain_events_aggregate_event_idx').on(t.aggregateId, t.eventType),
}))

// ─── Relations ───────────────────────────────────────────────────────────────

export const merchantsRelations = relations(merchants, ({ many }) => ({
  products: many(products),
  conversations: many(conversations),
  orders: many(orders),
  agentTasks: many(agentTasks),
  messageTemplates: many(messageTemplates),
  channels: many(merchantChannels),
  authMagicLinks: many(authMagicLinks),
  authSessions: many(authSessions),
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
