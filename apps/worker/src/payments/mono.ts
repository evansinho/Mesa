import { config } from '@mesa/config'

interface MonoTransaction {
  id?: string
  narration?: string
  amount?: number // minor units — kobo for NGN
  type?: 'credit' | 'debit'
}

interface MonoValidationResult {
  status: 'confirmed' | 'reference_not_found' | 'failed'
  // Set only on 'confirmed'. Callers must persist this and let the
  // payments_mono_transaction_unique_idx partial unique index reject a
  // second payment confirming against the same real transaction — required
  // for amount-only fallback matches, which have no reference to dedupe on.
  transactionId?: string
}

const LOOKUP_WINDOW_MS = 48 * 60 * 60 * 1000

// Mono wants dd-mm-yyyy — not ISO 8601 — confirmed via its own 400 response
// ("Invalid date format; please use dd-mm-yyyy ie 05-01-2020") when this was
// still sending yyyy-mm-dd.
function formatMonoDate(date: Date): string {
  const dd = String(date.getDate()).padStart(2, '0')
  const mm = String(date.getMonth() + 1).padStart(2, '0')
  const yyyy = date.getFullYear()
  return `${dd}-${mm}-${yyyy}`
}

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

  // Mono rejects the request with "Incomplete period range" if only one of
  // start/end is given — both are required together, not independently optional.
  const start = formatMonoDate(new Date(Date.now() - LOOKUP_WINDOW_MS))
  const end = formatMonoDate(new Date())
  const url = `https://api.withmono.com/v2/accounts/${monoAccountId}/transactions?type=credit&paginate=false&start=${start}&end=${end}`

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

  const isCreditOfExpectedAmount = (t: MonoTransaction) =>
    t.type === 'credit'
    && typeof t.amount === 'number' && Math.abs(t.amount - expectedKobo) < 100

  const referenceMatch = transactions.find(t =>
    isCreditOfExpectedAmount(t)
    && typeof t.narration === 'string' && t.narration.includes(reference),
  )

  if (referenceMatch) {
    return { status: 'confirmed', transactionId: referenceMatch.id }
  }

  // Fallback: some providers (confirmed with OPay) never put a reference in
  // the narration at all — it's always the literal string "Bank Deposit" —
  // so t.narration.includes(reference) can never match, for any payment,
  // ever. When exactly one credit transaction of the expected amount exists
  // in the window, treat that as sufficient evidence on its own. When more
  // than one exists, we can't tell them apart without a reference — fall
  // through to manual review rather than guess (the unique index on
  // mono_transaction_id also blocks any of them from being claimed twice).
  const amountCandidates = transactions.filter(isCreditOfExpectedAmount)

  if (amountCandidates.length === 1 && amountCandidates[0].id) {
    console.info(JSON.stringify({
      level: 'info',
      msg: 'Mono matched by amount only — no reference in narration',
      reference,
      monoAccountId,
      expectedAmountNaira,
      transactionId: amountCandidates[0].id,
      narration: amountCandidates[0].narration,
    }))
    return { status: 'confirmed', transactionId: amountCandidates[0].id }
  }

  console.info(JSON.stringify({
    level: 'info',
    msg: 'Mono found no matching credit transaction yet',
    reference,
    monoAccountId,
    expectedAmountNaira,
    candidateCount: transactions.length,
    amountCandidateCount: amountCandidates.length,
  }))
  return { status: 'reference_not_found' }
}
