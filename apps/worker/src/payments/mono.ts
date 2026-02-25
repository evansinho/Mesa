import { config } from '@mesa/config'

interface MonoValidationResult {
  status: 'confirmed' | 'reference_not_found' | 'failed'
}

export async function validate(reference: string, monoAccountId: string): Promise<MonoValidationResult> {
  if (!config.MONO_SECRET_KEY) {
    return { status: 'failed' }
  }

  const res = await fetch('https://api.withmono.com/accounts/verify-reference', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'mono-sec-key': config.MONO_SECRET_KEY,
    },
    body: JSON.stringify({ reference, account_id: monoAccountId }),
  })

  if (!res.ok) {
    return { status: 'failed' }
  }

  const data = await res.json() as { status?: string }
  if (data.status === 'confirmed') return { status: 'confirmed' }
  if (data.status === 'reference_not_found') return { status: 'reference_not_found' }
  return { status: 'failed' }
}
