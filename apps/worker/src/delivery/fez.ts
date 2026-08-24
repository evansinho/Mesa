import { config } from '@mesa/config'
import type {
  DeliveryBookingResult,
  DeliveryCancelResult,
  DeliveryOrderInput,
  DeliveryQuoteInput,
  DeliveryQuoteResult,
  DeliveryStatusResult,
} from './types'

// FEZ Delivery (fezdelivery.co) — nationwide courier, static platform-level
// credentials (Authorization bearer token + secret-key header), real
// webhooks. Field names below are confirmed against FEZ's own GitBook docs
// (fez-delivery-co.gitbook.io/fezcorporate-api-docs) as of 2026-08 — NOT
// yet exercised against a live sandbox response, so still confirm end to
// end before flipping DELIVERY_INTEGRATIONS_ENABLED on in production.
//
// Notably, FEZ's cost endpoint (/order/cost) returns no quote id and no
// expiry — pricing is a stateless state-to-state lookup, not a persisted
// quote. providerQuoteId/expiresAt are always left undefined here; the
// caller (fulfilment.handler.ts) treats a missing expiresAt as "assume our
// own default freshness window" rather than something FEZ enforces.

function headers(): Record<string, string> | null {
  const authToken = config.FEZ_AUTH_TOKEN ?? process.env.FEZ_AUTH_TOKEN
  const secretKey = config.FEZ_SECRET_KEY ?? process.env.FEZ_SECRET_KEY
  if (!authToken || !secretKey) return null
  return {
    'content-type': 'application/json',
    accept: 'application/json',
    Authorization: `Bearer ${authToken}`,
    'secret-key': secretKey,
  }
}

async function fezFetch(path: string, init: RequestInit): Promise<{ ok: boolean; status: number; body: unknown }> {
  const res = await fetch(`${config.FEZ_API_BASE_URL}${path}`, init)
  const text = await res.text().catch(() => '')
  let body: unknown = undefined
  try {
    body = text ? JSON.parse(text) : undefined
  } catch {
    body = text
  }
  return { ok: res.ok, status: res.status, body }
}

export async function quote(input: DeliveryQuoteInput): Promise<DeliveryQuoteResult> {
  const h = headers()
  if (!h) return { status: 'unavailable' }

  try {
    const { ok, status, body } = await fezFetch('/order/cost', {
      method: 'POST',
      headers: h,
      body: JSON.stringify({
        state: input.dropoffState,
        pickUpState: input.pickupState,
      }),
    })

    if (!ok) {
      console.error(JSON.stringify({ level: 'error', msg: 'FEZ quote failed', status, body }))
      return { status: status >= 500 ? 'unavailable' : 'error' }
    }

    const data = body as { totalCost?: number } | undefined
    if (!data || typeof data.totalCost !== 'number') {
      console.error(JSON.stringify({ level: 'error', msg: 'FEZ quote response missing totalCost', body }))
      return { status: 'error' }
    }

    return { status: 'quoted', feeKobo: Math.round(data.totalCost * 100) }
  } catch (err) {
    console.error(JSON.stringify({ level: 'error', msg: 'FEZ quote request threw', err: err instanceof Error ? err.message : String(err) }))
    return { status: 'unavailable' }
  }
}

export async function createOrder(input: DeliveryOrderInput): Promise<DeliveryBookingResult> {
  const h = headers()
  if (!h) return { status: 'error' }

  try {
    // uniqueID is FEZ's own idempotency key, keyed off our stable
    // fulfilmentId — a retried booking attempt (e.g. after a 5xx) reuses
    // the same key rather than risking a duplicate real-world order.
    const { ok, status, body } = await fezFetch('/order', {
      method: 'POST',
      headers: h,
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

    if (!ok) {
      console.error(JSON.stringify({ level: 'error', msg: 'FEZ create order failed', status, body }))
      return { status: status >= 500 ? 'retryable' : 'error' }
    }

    // Response maps our uniqueID to FEZ's own order number:
    // { orderNos: { "<uniqueID>": "<orderNo>" } }. No tracking URL exists
    // anywhere in FEZ's API.
    const data = body as { orderNos?: Record<string, string> } | undefined
    const orderNo = data?.orderNos?.[input.fulfilmentId]
    if (!orderNo) {
      console.error(JSON.stringify({ level: 'error', msg: 'FEZ create order response missing orderNos entry', body }))
      return { status: 'error' }
    }

    return { status: 'booked', providerOrderId: orderNo }
  } catch (err) {
    console.error(JSON.stringify({ level: 'error', msg: 'FEZ create order request threw', err: err instanceof Error ? err.message : String(err) }))
    return { status: 'retryable' }
  }
}

export async function getStatus(providerOrderId: string): Promise<DeliveryStatusResult> {
  const h = headers()
  if (!h) return { status: 'pending' }

  try {
    const { ok, body } = await fezFetch(`/orders/${encodeURIComponent(providerOrderId)}`, {
      method: 'GET',
      headers: h,
    })
    if (!ok) return { status: 'pending' }

    // { orderDetails: [{ orderStatus, ... }] } — a one-element array per order.
    const data = body as { orderDetails?: Array<{ orderStatus?: string }> } | undefined
    const raw = data?.orderDetails?.[0]?.orderStatus
    return { status: mapStatus(raw), raw }
  } catch (err) {
    console.error(JSON.stringify({ level: 'error', msg: 'FEZ get status request threw', err: err instanceof Error ? err.message : String(err) }))
    return { status: 'pending' }
  }
}

export async function cancelOrder(providerOrderId: string, reason = 'Cancelled by merchant'): Promise<DeliveryCancelResult> {
  const h = headers()
  if (!h) return { status: 'error' }

  try {
    const { ok, status, body } = await fezFetch('/order/cancel', {
      method: 'POST',
      headers: h,
      body: JSON.stringify({ orderNo: providerOrderId, reason }),
    })
    if (!ok) {
      console.error(JSON.stringify({ level: 'error', msg: 'FEZ cancel order failed', status, body }))
      return { status: status >= 500 ? 'retryable' : 'error' }
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
