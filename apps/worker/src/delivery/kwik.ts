import type { Redis } from 'ioredis'
import { config } from '@mesa/config'
import type {
  DeliveryBookingResult,
  DeliveryCancelResult,
  DeliveryOrderInput,
  DeliveryQuoteInput,
  DeliveryQuoteResult,
  DeliveryStatusResult,
} from './types'

// Kwik Delivery — Lagos/Abuja same-city on-demand only, no interstate.
// Unlike FEZ/Mono, there's no static API key: auth is a session login
// (email+password → access_token) that must be cached and refreshed, not
// configured directly. Field names below are based on the documented
// endpoints (via the real third-party wrapper libraries confirmed during
// research, since Kwik's own doc site was unreachable) but have not been
// exercised against live sandbox responses — confirm before enabling in
// production. Off by default via DELIVERY_INTEGRATIONS_ENABLED for exactly
// this reason.

const ACCESS_TOKEN_KEY = 'kwik:access_token'
// Kwik's actual session lifetime isn't confirmed — this is a conservative
// default so a stale cached token doesn't outlive the real session. If a
// real login response includes an expiry, prefer that over this constant.
const ACCESS_TOKEN_TTL_SECONDS = 20 * 60

function baseUrl(): string {
  return config.KWIK_API_BASE_URL ?? process.env.KWIK_API_BASE_URL ?? 'https://api.kwik.delivery'
}

async function login(): Promise<string | null> {
  const email = config.KWIK_VENDOR_EMAIL ?? process.env.KWIK_VENDOR_EMAIL
  const password = config.KWIK_VENDOR_PASSWORD ?? process.env.KWIK_VENDOR_PASSWORD
  if (!email || !password) return null

  try {
    const res = await fetch(`${baseUrl()}/vendor_login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({ email, password }),
    })
    if (!res.ok) {
      console.error(JSON.stringify({ level: 'error', msg: 'Kwik login failed', status: res.status }))
      return null
    }
    const data = await res.json().catch(() => undefined) as { access_token?: string } | undefined
    return data?.access_token ?? null
  } catch (err) {
    console.error(JSON.stringify({ level: 'error', msg: 'Kwik login request threw', err: err instanceof Error ? err.message : String(err) }))
    return null
  }
}

async function getAccessToken(redis: Redis, forceRefresh = false): Promise<string | null> {
  if (!forceRefresh) {
    const cached = await redis.get(ACCESS_TOKEN_KEY)
    if (cached) return cached
  }
  const token = await login()
  if (token) await redis.set(ACCESS_TOKEN_KEY, token, 'EX', ACCESS_TOKEN_TTL_SECONDS)
  return token
}

// Runs one Kwik API call, transparently retrying once with a freshly
// logged-in token if the cached one turns out to be expired (401) — the
// caller never has to know Kwik uses session auth instead of a static key.
async function kwikFetch(
  redis: Redis,
  path: string,
  init: Omit<RequestInit, 'headers'>,
): Promise<{ ok: boolean; status: number; body: unknown } | null> {
  for (const forceRefresh of [false, true]) {
    const token = await getAccessToken(redis, forceRefresh)
    if (!token) return null

    const res = await fetch(`${baseUrl()}${path}`, {
      ...init,
      headers: { 'content-type': 'application/json', accept: 'application/json', Authorization: `Bearer ${token}` },
    })
    if (res.status === 401 && !forceRefresh) continue // stale cached token — retry once with a fresh login

    const text = await res.text().catch(() => '')
    let body: unknown
    try {
      body = text ? JSON.parse(text) : undefined
    } catch {
      body = text
    }
    return { ok: res.ok, status: res.status, body }
  }
  return null
}

export async function quote(redis: Redis, input: DeliveryQuoteInput): Promise<DeliveryQuoteResult> {
  try {
    const result = await kwikFetch(redis, '/get_bill_breakdown', {
      method: 'POST',
      body: JSON.stringify({
        pickup_address: input.pickupAddress,
        dropoff_address: input.dropoffAddress,
        package_description: input.packageDescription,
      }),
    })
    if (!result) return { status: 'unavailable' }
    if (!result.ok) {
      console.error(JSON.stringify({ level: 'error', msg: 'Kwik quote failed', status: result.status, body: result.body }))
      return { status: result.status >= 500 ? 'unavailable' : 'error' }
    }

    const data = result.body as { total?: number; task_id?: string } | undefined
    if (!data || typeof data.total !== 'number') {
      console.error(JSON.stringify({ level: 'error', msg: 'Kwik quote response missing total', body: result.body }))
      return { status: 'error' }
    }
    // Kwik is on-demand, minutes-scale — a quote here is only meaningful for
    // the next few minutes, not hours. Callers should treat this as expiring
    // fast regardless of what expiresAt implies for FEZ.
    return {
      status: 'quoted',
      feeKobo: Math.round(data.total * 100),
      providerQuoteId: data.task_id,
      expiresAt: new Date(Date.now() + 5 * 60 * 1000).toISOString(),
    }
  } catch (err) {
    console.error(JSON.stringify({ level: 'error', msg: 'Kwik quote request threw', err: err instanceof Error ? err.message : String(err) }))
    return { status: 'unavailable' }
  }
}

export async function createTask(redis: Redis, input: DeliveryOrderInput): Promise<DeliveryBookingResult> {
  try {
    const result = await kwikFetch(redis, '/create_task_via_vendor', {
      method: 'POST',
      body: JSON.stringify({
        pickup_address: input.pickupAddress,
        dropoff_address: input.dropoffAddress,
        recipient_phone: input.customerPhone,
        recipient_name: input.customerName,
        package_description: input.packageDescription,
      }),
    })
    if (!result) return { status: 'retryable' }
    if (!result.ok) {
      console.error(JSON.stringify({ level: 'error', msg: 'Kwik create task failed', status: result.status, body: result.body }))
      return { status: result.status >= 500 ? 'retryable' : 'error' }
    }

    const data = result.body as { task_id?: string; tracking_url?: string } | undefined
    if (!data?.task_id) {
      console.error(JSON.stringify({ level: 'error', msg: 'Kwik create task response missing task_id', body: result.body }))
      return { status: 'error' }
    }
    return { status: 'booked', providerOrderId: data.task_id, trackingUrl: data.tracking_url }
  } catch (err) {
    console.error(JSON.stringify({ level: 'error', msg: 'Kwik create task request threw', err: err instanceof Error ? err.message : String(err) }))
    return { status: 'retryable' }
  }
}

export async function getStatus(redis: Redis, providerOrderId: string): Promise<DeliveryStatusResult> {
  try {
    const result = await kwikFetch(redis, `/getJobStatus?relationship_id=${encodeURIComponent(providerOrderId)}`, {
      method: 'GET',
    })
    if (!result?.ok) return { status: 'pending' }

    const data = result.body as { status?: string } | undefined
    return { status: mapStatus(data?.status), raw: data?.status }
  } catch (err) {
    console.error(JSON.stringify({ level: 'error', msg: 'Kwik get status request threw', err: err instanceof Error ? err.message : String(err) }))
    return { status: 'pending' }
  }
}

export async function cancelTask(redis: Redis, providerOrderId: string): Promise<DeliveryCancelResult> {
  try {
    const result = await kwikFetch(redis, '/cancel_vendor_task', {
      method: 'POST',
      body: JSON.stringify({ relationship_id: providerOrderId }),
    })
    if (!result) return { status: 'retryable' }
    if (!result.ok) {
      console.error(JSON.stringify({ level: 'error', msg: 'Kwik cancel task failed', status: result.status, body: result.body }))
      return { status: result.status >= 500 ? 'retryable' : 'error' }
    }
    return { status: 'cancelled' }
  } catch (err) {
    console.error(JSON.stringify({ level: 'error', msg: 'Kwik cancel task request threw', err: err instanceof Error ? err.message : String(err) }))
    return { status: 'retryable' }
  }
}

// Kwik's raw status vocabulary isn't fully documented (docs site was
// unreachable during research) — map the values seen in third-party
// wrapper libraries, default unrecognized ones to 'pending' rather than
// guessing.
function mapStatus(raw: string | undefined): DeliveryStatusResult['status'] {
  switch ((raw ?? '').toLowerCase()) {
    case 'delivered':
    case 'completed':
      return 'delivered'
    case 'in_transit':
    case 'in-progress':
    case 'ongoing':
      return 'in_transit'
    case 'assigned':
    case 'accepted':
      return 'assigned'
    case 'cancelled':
    case 'canceled':
      return 'cancelled'
    case 'failed':
      return 'failed'
    default:
      return 'pending'
  }
}
