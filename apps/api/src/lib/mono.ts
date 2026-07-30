import { config } from '@mesa/config'

// The widget hands back a temporary code (expires in 10 minutes) — this
// exchanges it for the permanent account id that identifies the merchant's
// linked bank account for every future payment lookup.
export async function exchangeMonoCode(code: string): Promise<string | null> {
  if (!config.MONO_SECRET_KEY) return null

  const res = await fetch('https://api.withmono.com/v2/accounts/auth', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      accept: 'application/json',
      'mono-sec-key': config.MONO_SECRET_KEY,
    },
    body: JSON.stringify({ code }),
  })
  if (!res.ok) return null

  const data = await res.json() as { id?: string }
  return data.id ?? null
}
