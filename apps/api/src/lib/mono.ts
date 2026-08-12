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
  if (!res.ok) {
    // Mono's actual rejection reason (e.g. a live/test key or code/env
    // mismatch) used to be discarded here, leaving nothing to debug beyond
    // a generic 502 at the caller.
    const text = await res.text().catch(() => '')
    console.error(JSON.stringify({ level: 'error', msg: 'Mono code exchange failed', status: res.status, body: text }))
    return null
  }

  // Mono wraps the payload in a {status, message, data} envelope — the
  // account id is at data.data.id, not top-level. Reading it as a bare
  // {id} (matching the widget's own onSuccess shape) silently returned
  // undefined on every real exchange, in and out of test mode alike.
  const body = await res.json() as { data?: { id?: string } }
  const accountId = body.data?.id
  if (!accountId) {
    console.error(JSON.stringify({ level: 'error', msg: 'Mono code exchange returned no account id', body }))
  }
  return accountId ?? null
}
