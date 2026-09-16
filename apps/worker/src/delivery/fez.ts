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

// FEZ Delivery (fezdelivery.co) — nationwide courier. Field names below are
// confirmed against FEZ's own GitBook docs
// (fez-delivery-co.gitbook.io/fezcorporate-api-docs) as of 2026-09.
//
// Auth is a session login, not a static Bearer token — confirmed directly
// from FEZ's business portal, which shows only one static credential (the
// "secret-key"), not a separate API key. POST /user/authenticate with
// {user_id, password} returns a Bearer authToken (plus an expireToken) that
// must be cached and refreshed, same shape as Kwik's login. The secret-key
// is sent alongside it on every call and is also what verifies inbound
// webhook signatures (see apps/api/src/routes/webhooks.ts) — FEZ has no
// separate webhook secret.
//
// FEZ's cost endpoint (/order/cost) returns no quote id and no expiry —
// pricing is a stateless state-to-state lookup, not a persisted quote.
// providerQuoteId/expiresAt are always left undefined here; the caller
// (fulfilment.handler.ts) treats a missing expiresAt as "assume our own
// default freshness window" rather than something FEZ enforces.

const ACCESS_TOKEN_KEY = 'fez:access_token'
// FEZ's real token lifetime comes back as expireToken on login — this is
// only the fallback for when that value can't be parsed into a sensible
// future timestamp.
const ACCESS_TOKEN_TTL_SECONDS = 20 * 60

function baseUrl(): string {
  return config.FEZ_API_BASE_URL
}

async function fezFetch(path: string, init: RequestInit): Promise<{ ok: boolean; status: number; body: unknown }> {
  const res = await fetch(`${baseUrl()}${path}`, init)
  const text = await res.text().catch(() => '')
  let body: unknown = undefined
  try {
    body = text ? JSON.parse(text) : undefined
  } catch {
    body = text
  }
  return { ok: res.ok, status: res.status, body }
}

// Confirmed against a real login response (2026-09-16): expireToken is a
// literal "YYYY-MM-DD HH:mm:ss" string in Africa/Lagos time (the response
// separately confirms `timezone: "Africa/Lagos"`) — NOT epoch anything, and
// NOT safely parseable via a bare `new Date(string)`/`Date.parse`, since
// that reads a space-separated non-ISO string in whatever timezone the
// running process happens to be in, not Lagos. Converting to an explicit
// ISO offset avoids that ambiguity entirely. Falls back to the conservative
// default if the shape ever changes.
const EXPIRE_TOKEN_FORMAT = /^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2})$/
function ttlFromExpireToken(expireToken: unknown): number {
  if (typeof expireToken !== 'string') return ACCESS_TOKEN_TTL_SECONDS
  const match = expireToken.match(EXPIRE_TOKEN_FORMAT)
  if (!match) return ACCESS_TOKEN_TTL_SECONDS
  const ms = Date.parse(`${match[1]}T${match[2]}+01:00`) // Africa/Lagos — fixed UTC+1, no DST
  if (!Number.isFinite(ms)) return ACCESS_TOKEN_TTL_SECONDS
  const seconds = Math.floor((ms - Date.now()) / 1000) - 60
  return seconds > 60 ? seconds : ACCESS_TOKEN_TTL_SECONDS
}

async function login(): Promise<{ token: string; ttlSeconds: number } | null> {
  const userId = config.FEZ_USER_ID ?? process.env.FEZ_USER_ID
  const password = config.FEZ_PASSWORD ?? process.env.FEZ_PASSWORD
  if (!userId || !password) return null

  try {
    const { ok, status, body } = await fezFetch('/user/authenticate', {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({ user_id: userId, password }),
    })
    if (!ok) {
      console.error(JSON.stringify({ level: 'error', msg: 'FEZ login failed', status, body }))
      return null
    }
    // Confirmed shape: { status, description, authDetails: { authToken,
    // expireToken, timezone }, ... }. The token is nested, not top-level.
    const data = body as { authDetails?: { authToken?: string; expireToken?: unknown } } | undefined
    const authToken = data?.authDetails?.authToken
    if (!authToken) return null
    return { token: authToken, ttlSeconds: ttlFromExpireToken(data?.authDetails?.expireToken) }
  } catch (err) {
    console.error(JSON.stringify({ level: 'error', msg: 'FEZ login request threw', err: err instanceof Error ? err.message : String(err) }))
    return null
  }
}

async function getAccessToken(redis: Redis, forceRefresh = false): Promise<string | null> {
  if (!forceRefresh) {
    const cached = await redis.get(ACCESS_TOKEN_KEY)
    if (cached) return cached
  }
  const result = await login()
  if (result) await redis.set(ACCESS_TOKEN_KEY, result.token, 'EX', result.ttlSeconds)
  return result?.token ?? null
}

// Runs one authenticated FEZ call, transparently retrying once with a
// freshly logged-in token if the cached one turns out to be expired (401)
// — callers never need to know FEZ uses session auth.
async function fezFetchAuthed(
  redis: Redis,
  path: string,
  init: Omit<RequestInit, 'headers'>,
): Promise<{ ok: boolean; status: number; body: unknown } | null> {
  const secretKey = config.FEZ_SECRET_KEY ?? process.env.FEZ_SECRET_KEY
  if (!secretKey) return null

  for (const forceRefresh of [false, true]) {
    const token = await getAccessToken(redis, forceRefresh)
    if (!token) return null

    const result = await fezFetch(path, {
      ...init,
      headers: {
        'content-type': 'application/json',
        accept: 'application/json',
        Authorization: `Bearer ${token}`,
        'secret-key': secretKey,
      },
    })
    if (result.status === 401 && !forceRefresh) continue // stale cached token — retry once with a fresh login
    return result
  }
  return null
}

export async function quote(redis: Redis, input: DeliveryQuoteInput): Promise<DeliveryQuoteResult> {
  try {
    const result = await fezFetchAuthed(redis, '/order/cost', {
      method: 'POST',
      body: JSON.stringify({
        state: input.dropoffState,
        pickUpState: input.pickupState,
      }),
    })
    if (!result) return { status: 'unavailable' }

    if (!result.ok) {
      console.error(JSON.stringify({ level: 'error', msg: 'FEZ quote failed', status: result.status, body: result.body }))
      return { status: result.status >= 500 ? 'unavailable' : 'error' }
    }

    const data = result.body as { totalCost?: number } | undefined
    if (!data || typeof data.totalCost !== 'number') {
      console.error(JSON.stringify({ level: 'error', msg: 'FEZ quote response missing totalCost', body: result.body }))
      return { status: 'error' }
    }

    return { status: 'quoted', feeKobo: Math.round(data.totalCost * 100) }
  } catch (err) {
    console.error(JSON.stringify({ level: 'error', msg: 'FEZ quote request threw', err: err instanceof Error ? err.message : String(err) }))
    return { status: 'unavailable' }
  }
}

export async function createOrder(redis: Redis, input: DeliveryOrderInput): Promise<DeliveryBookingResult> {
  try {
    // uniqueID is FEZ's own idempotency key, keyed off our stable
    // fulfilmentId — a retried booking attempt (e.g. after a 5xx) reuses
    // the same key rather than risking a duplicate real-world order.
    const result = await fezFetchAuthed(redis, '/order', {
      method: 'POST',
      body: JSON.stringify({
        uniqueID: input.fulfilmentId,
        pickUpAddress: input.pickupAddress,
        pickUpState: input.pickupState,
        recipientAddress: input.dropoffAddress,
        recipientState: input.dropoffState,
        recipientName: input.customerName,
        recipientPhone: input.customerPhone,
        itemDescription: input.packageDescription,
        valueOfItem: input.packageValueNaira,
      }),
    })
    if (!result) return { status: 'retryable' }

    if (!result.ok) {
      console.error(JSON.stringify({ level: 'error', msg: 'FEZ create order failed', status: result.status, body: result.body }))
      return { status: result.status >= 500 ? 'retryable' : 'error' }
    }

    // Response maps our uniqueID to FEZ's own order number:
    // { orderNos: { "<uniqueID>": "<orderNo>" } }. No tracking URL exists
    // anywhere in FEZ's API.
    const data = result.body as { orderNos?: Record<string, string> } | undefined
    const orderNo = data?.orderNos?.[input.fulfilmentId]
    if (!orderNo) {
      console.error(JSON.stringify({ level: 'error', msg: 'FEZ create order response missing orderNos entry', body: result.body }))
      return { status: 'error' }
    }

    return { status: 'booked', providerOrderId: orderNo }
  } catch (err) {
    console.error(JSON.stringify({ level: 'error', msg: 'FEZ create order request threw', err: err instanceof Error ? err.message : String(err) }))
    return { status: 'retryable' }
  }
}

export async function getStatus(redis: Redis, providerOrderId: string): Promise<DeliveryStatusResult> {
  try {
    const result = await fezFetchAuthed(redis, `/orders/${encodeURIComponent(providerOrderId)}`, {
      method: 'GET',
    })
    if (!result?.ok) return { status: 'pending' }

    // { orderDetails: [{ orderStatus, ... }] } — a one-element array per order.
    const data = result.body as { orderDetails?: Array<{ orderStatus?: string }> } | undefined
    const raw = data?.orderDetails?.[0]?.orderStatus
    return { status: mapStatus(raw), raw }
  } catch (err) {
    console.error(JSON.stringify({ level: 'error', msg: 'FEZ get status request threw', err: err instanceof Error ? err.message : String(err) }))
    return { status: 'pending' }
  }
}

export async function cancelOrder(redis: Redis, providerOrderId: string, reason = 'Cancelled by merchant'): Promise<DeliveryCancelResult> {
  try {
    const result = await fezFetchAuthed(redis, '/order/cancel', {
      method: 'POST',
      body: JSON.stringify({ orderNo: providerOrderId, reason }),
    })
    if (!result) return { status: 'retryable' }
    if (!result.ok) {
      console.error(JSON.stringify({ level: 'error', msg: 'FEZ cancel order failed', status: result.status, body: result.body }))
      return { status: result.status >= 500 ? 'retryable' : 'error' }
    }
    return { status: 'cancelled' }
  } catch (err) {
    console.error(JSON.stringify({ level: 'error', msg: 'FEZ cancel order request threw', err: err instanceof Error ? err.message : String(err) }))
    return { status: 'retryable' }
  }
}

// Only "Delivered" is confirmed verbatim from FEZ's docs (their webhook
// example); the rest are best-guess pending real sandbox traffic — treat
// anything unrecognized as 'pending' rather than misreport a terminal state.
function mapStatus(raw: string | undefined): DeliveryStatusResult['status'] {
  switch ((raw ?? '').toLowerCase()) {
    case 'delivered':
      return 'delivered'
    case 'in_transit':
    case 'in-transit':
    case 'dispatched':
      return 'in_transit'
    case 'assigned':
    case 'rider_assigned':
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
