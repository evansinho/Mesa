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

async function paystackRequest<T>(path: string, body: Record<string, unknown>): Promise<T> {
  const res = await fetch(`https://api.paystack.co${path}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${config.PAYSTACK_SECRET_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  })

  const data = await res.json() as { status?: boolean; message?: string; data?: T }
  if (!res.ok || data.status === false || !data.data) {
    throw new Error(data.message ?? `Paystack request failed: ${res.status}`)
  }
  return data.data
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
