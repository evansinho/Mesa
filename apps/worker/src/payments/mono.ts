import { config } from '@mesa/config'

interface MonoTransaction {
  narration?: string
  amount?: number // minor units — kobo for NGN
  type?: 'credit' | 'debit'
}

interface MonoValidationResult {
  status: 'confirmed' | 'reference_not_found' | 'failed'
}

const LOOKUP_WINDOW_MS = 48 * 60 * 60 * 1000

// Mono has no dedicated "verify a reference" endpoint (the previous
// implementation called https://api.withmono.com/accounts/verify-reference,
// which doesn't exist in Mono's API — every real transfer 404'd straight to
// 'failed' with no visibility). This instead pulls the account's own recent
// credit transactions and checks whether one matches this reference and
// amount — the same evidence a human reviewing the bank app would use.
export async function validate(
  reference: string,
  monoAccountId: string,
  expectedAmountNaira: number,
): Promise<MonoValidationResult> {
  const secretKey = config.MONO_SECRET_KEY ?? process.env.MONO_SECRET_KEY
  if (!secretKey) return { status: 'failed' }

  const start = new Date(Date.now() - LOOKUP_WINDOW_MS).toISOString().slice(0, 10)
  const url = `https://api.withmono.com/v2/accounts/${monoAccountId}/transactions?type=credit&paginate=false&start=${start}`

  const res = await fetch(url, {
    headers: { accept: 'application/json', 'mono-sec-key': secretKey },
  })

  if (!res.ok) {
    const text = await res.text().catch(() => '')
    console.error(JSON.stringify({
      level: 'error',
      msg: 'Mono transaction lookup failed',
      status: res.status,
      body: text,
      monoAccountId,
    }))
    return { status: 'failed' }
  }

  const body = await res.json() as { data?: MonoTransaction[] }
  const transactions = body.data ?? []
  const expectedKobo = Math.round(expectedAmountNaira * 100)

  const match = transactions.find(t =>
    t.type === 'credit'
    && typeof t.narration === 'string' && t.narration.includes(reference)
    && typeof t.amount === 'number' && Math.abs(t.amount - expectedKobo) < 100,
  )

  if (!match) {
    console.info(JSON.stringify({
      level: 'info',
      msg: 'Mono found no matching credit transaction yet',
      reference,
      monoAccountId,
      expectedAmountNaira,
      candidateCount: transactions.length,
    }))
    return { status: 'reference_not_found' }
  }

  return { status: 'confirmed' }
}
