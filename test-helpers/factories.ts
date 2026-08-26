import { randomUUID, randomBytes, createHash } from 'crypto'
import type { Db } from '@mesa/db'
import { merchants, conversations, products, orders, merchantChannels, payments, fulfilments, staff, staffSessions, prospects } from '@mesa/db'
import { normalizePhone } from '@mesa/types'

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

export async function createFulfilment(
  db: Db,
  orderId: string,
  merchantId: string,
  overrides: Partial<typeof fulfilments.$inferInsert> = {},
) {
  const [row] = await db.insert(fulfilments).values({
    orderId,
    merchantId,
    customerPhone: overrides.customerPhone ?? `+234${Math.floor(Math.random() * 9_000_000_000 + 1_000_000_000)}`,
    status: overrides.status ?? 'PENDING',
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

// ─── Commercial layer ───────────────────────────────────────────────────────

export async function createStaff(
  db: Db,
  overrides: Partial<typeof staff.$inferInsert> = {},
) {
  const [row] = await db.insert(staff).values({
    name: overrides.name ?? `Test Staff ${randomBytes(3).toString('hex')}`,
    email: overrides.email ?? `staff-${randomBytes(4).toString('hex')}@example.com`,
    // Callers that need to log in pass a real hash. The default is deliberately
    // not a valid PHC string, so no test can accidentally authenticate with a
    // guessed password.
    passwordHash: overrides.passwordHash ?? 'not-a-valid-hash',
    role: overrides.role ?? 'member',
    active: overrides.active ?? true,
    mustResetPassword: overrides.mustResetPassword ?? false,
    ...overrides,
  }).returning()
  return row
}

export async function createProspect(
  db: Db,
  overrides: Partial<typeof prospects.$inferInsert> = {},
) {
  const phone = overrides.phone ?? `+234${Math.floor(Math.random() * 9_000_000_000 + 1_000_000_000)}`
  const [row] = await db.insert(prospects).values({
    businessName: overrides.businessName ?? `Test Prospect ${randomBytes(3).toString('hex')}`,
    phone,
    phoneNormalized: overrides.phoneNormalized ?? normalizePhone(phone),
    source: overrides.source ?? 'outbound',
    stage: overrides.stage ?? 'SOURCED',
    ...overrides,
  }).returning()
  return row
}

export async function createStaffSession(db: Db, staffId: string): Promise<string> {
  const token = randomBytes(32).toString('hex')
  await db.insert(staffSessions).values({
    staffId,
    sessionHash: createHash('sha256').update(token).digest('hex'),
    expiresAt: new Date(Date.now() + 60 * 60 * 1000),
  })
  return token
}
