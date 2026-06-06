import { randomUUID, randomBytes } from 'crypto'
import type { Db } from '@mesa/db'
import { merchants, conversations, products, orders, merchantChannels, payments } from '@mesa/db'

// Factory helpers. Each returns the inserted row so tests can chain.
// Overrides let the test pin exactly the fields it cares about.

export async function createMerchant(
  db: Db,
  overrides: Partial<typeof merchants.$inferInsert> = {},
) {
  const [row] = await db.insert(merchants).values({
    name: overrides.name ?? `Test Merchant ${randomBytes(3).toString('hex')}`,
    phone: overrides.phone ?? `+234${Math.floor(Math.random() * 9_000_000_000 + 1_000_000_000)}`,
    subscriptionTier: overrides.subscriptionTier ?? 'starter',
    subscriptionStatus: overrides.subscriptionStatus ?? 'trialing',
    trialEndsAt: overrides.trialEndsAt ?? new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
    config: overrides.config ?? {},
    active: overrides.active ?? true,
    ...overrides,
  }).returning()
  return row
}

export async function createConversation(
  db: Db,
  merchantId: string,
  overrides: Partial<typeof conversations.$inferInsert> = {},
) {
  const [row] = await db.insert(conversations).values({
    merchantId,
    channel: overrides.channel ?? 'whatsapp',
    customerPhone: overrides.customerPhone ?? `+234${Math.floor(Math.random() * 9_000_000_000 + 1_000_000_000)}`,
    state: overrides.state ?? 'IDLE',
    context: overrides.context ?? {
      currentItems: [],
      negotiationHistory: [],
      lastMessageAt: new Date().toISOString(),
    },
    ...overrides,
  }).returning()
  return row
}

export async function createProduct(
  db: Db,
  merchantId: string,
  overrides: Partial<typeof products.$inferInsert> = {},
) {
  const [row] = await db.insert(products).values({
    merchantId,
    name: overrides.name ?? `Product ${randomBytes(3).toString('hex')}`,
    price: overrides.price ?? '1000',
    stockQuantity: overrides.stockQuantity ?? 100,
    unit: overrides.unit ?? 'unit',
    ...overrides,
  }).returning()
  return row
}

export async function createOrder(
  db: Db,
  merchantId: string,
  overrides: Partial<typeof orders.$inferInsert> = {},
) {
  const [row] = await db.insert(orders).values({
    merchantId,
    customerPhone: overrides.customerPhone ?? `+234${Math.floor(Math.random() * 9_000_000_000 + 1_000_000_000)}`,
    status: overrides.status ?? 'CONFIRMED',
    subtotal: overrides.subtotal ?? '5000',
    total: overrides.total ?? '5000',
    ...overrides,
  }).returning()
  return row
}

export async function createPayment(
  db: Db,
  orderId: string,
  merchantId: string,
  overrides: Partial<typeof payments.$inferInsert> = {},
) {
  const [row] = await db.insert(payments).values({
    orderId,
    merchantId,
    status: overrides.status ?? 'PENDING',
    amount: overrides.amount,
    reference: overrides.reference,
    screenshotHash: overrides.screenshotHash ?? randomUUID(),
    screenshotUrl: overrides.screenshotUrl,
    bankName: overrides.bankName,
    rawOcrData: overrides.rawOcrData,
    confirmedAt: overrides.confirmedAt,
    ...overrides,
  }).returning()
  return row
}

export async function createMerchantChannel(
  db: Db,
  merchantId: string,
  overrides: Partial<typeof merchantChannels.$inferInsert> = {},
) {
  const [row] = await db.insert(merchantChannels).values({
    merchantId,
    channel: overrides.channel ?? 'whatsapp',
    channelAccountId: overrides.channelAccountId ?? `pn_${randomUUID().slice(0, 8)}`,
    status: overrides.status ?? 'connected',
    ...overrides,
  }).returning()
  return row
}
