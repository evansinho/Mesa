import { createHmac, timingSafeEqual } from 'crypto'
import { config } from '@mesa/config'
import type { Db } from '@mesa/db'
import { merchants } from '@mesa/db'
import { eq } from 'drizzle-orm'

type Plan = 'starter' | 'growth' | 'business'

const PLAN_AMOUNT_KOBO: Record<Plan, number> = {
  starter: 1_200_000,
  growth: 3_500_000,
  business: 6_000_000,
}

function planCode(plan: Plan): string | undefined {
  if (plan === 'starter') return config.PAYSTACK_STARTER_PLAN_CODE
  if (plan === 'growth') return config.PAYSTACK_GROWTH_PLAN_CODE
  return config.PAYSTACK_BUSINESS_PLAN_CODE
}

// Paystack normally returns JSON even on its own error responses — but a
// gateway/WAF/timeout in front of it (Cloudflare, etc.) can return an HTML
// error page instead. Calling res.json() directly on that throws an opaque
// "Unexpected token '<'" SyntaxError with no indication of what actually
// went wrong (confirmed via Sentry: exactly this happened for /bank).
async function parsePaystackResponse<T>(res: Response, context: string): Promise<T> {
  const text = await res.text()
  let data: { status?: boolean; message?: string; data?: T }
  try {
    data = JSON.parse(text)
  } catch {
    console.error(JSON.stringify({
      level: 'error',
      msg: 'Paystack returned a non-JSON response',
      context,
      status: res.status,
      body: text.slice(0, 500),
    }))
    throw new Error(`Paystack ${context} failed: non-JSON response (status ${res.status})`)
  }
  if (!res.ok || data.status === false || data.data == null) {
    throw new Error(data.message ?? `Paystack ${context} failed: ${res.status}`)
  }
  return data.data
}

async function paystackRequest<T>(path: string, body: Record<string, unknown>): Promise<T> {
  const res = await fetch(`https://api.paystack.co${path}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${config.PAYSTACK_SECRET_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  })

  return parsePaystackResponse<T>(res, path)
}

export function verifyPaystackSignature(rawBody: string, signature: string | undefined): boolean {
  if (!signature) return false
  const expected = createHmac('sha512', config.PAYSTACK_SECRET_KEY)
    .update(rawBody)
    .digest('hex')
  const expectedBuffer = Buffer.from(expected, 'utf8')
  const signatureBuffer = Buffer.from(signature, 'utf8')
  if (expectedBuffer.length !== signatureBuffer.length) return false
  return timingSafeEqual(expectedBuffer, signatureBuffer)
}

export async function generatePaymentLink(
  db: Db,
  merchantId: string,
): Promise<{ paymentLink?: string; needsEmail?: boolean; error?: string }> {
  const merchant = await db.query.merchants.findFirst({
    where: eq(merchants.id, merchantId),
  })
  if (!merchant) return { error: 'Merchant not found' }
  if (!merchant.email) return { needsEmail: true }

  const plan = (merchant.subscriptionTier ?? 'starter') as Plan
  const code = planCode(plan)
  if (!code || !config.PAYSTACK_CALLBACK_URL) {
    return { error: 'Billing is not configured' }
  }

  const customer = await paystackRequest<{ customer_code: string }>('/customer', {
    email: merchant.email,
    first_name: merchant.name,
    phone: merchant.phone,
  })

  const transaction = await paystackRequest<{ authorization_url: string }>('/transaction/initialize', {
    email: merchant.email,
    amount: PLAN_AMOUNT_KOBO[plan],
    plan: code,
    callback_url: config.PAYSTACK_CALLBACK_URL,
    metadata: { merchantId, plan },
  })

  // Paystack returns the authorization URL from transaction initialize; the
  // customer call above ensures Paystack has a reusable customer record.
  void customer
  return { paymentLink: transaction.authorization_url }
}

export async function cancelSubscription(subscriptionCode: string, token: string): Promise<void> {
  await paystackRequest('/subscription/disable', {
    code: subscriptionCode,
    token,
  })
}

export function planAmountKobo(plan: Plan): number {
  return PLAN_AMOUNT_KOBO[plan]
}

export function paystackPlanCode(plan: Plan): string | undefined {
  return planCode(plan)
}

// ─── Bank list & account resolution ──────────────────────────────────────────

async function paystackGet<T>(path: string): Promise<T> {
  const res = await fetch(`https://api.paystack.co${path}`, {
    headers: { Authorization: `Bearer ${config.PAYSTACK_SECRET_KEY}` },
  })
  return parsePaystackResponse<T>(res, path)
}

export type PaystackBank = { name: string; code: string }

export async function listBanks(): Promise<PaystackBank[]> {
  const banks: PaystackBank[] = []
  for (let page = 1; page <= 5; page++) {
    const data = await paystackGet<Array<{ name: string; code: string; active?: boolean }>>(
      `/bank?currency=NGN&perPage=100&page=${page}`,
    )
    banks.push(...data.filter(b => b.active !== false).map(b => ({ name: b.name, code: b.code })))
    if (data.length < 100) break
  }
  const seen = new Set<string>()
  return banks
    .filter(b => (seen.has(b.code) ? false : (seen.add(b.code), true)))
    .sort((a, b) => a.name.localeCompare(b.name))
}

export async function resolveBankAccount(
  accountNumber: string,
  bankCode: string,
): Promise<{ accountName: string }> {
  const data = await paystackGet<{ account_name: string }>(
    `/bank/resolve?account_number=${encodeURIComponent(accountNumber)}&bank_code=${encodeURIComponent(bankCode)}`,
  )
  return { accountName: data.account_name }
}
