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
// webhooks. See docs.fezdelivery.co (GitBook). Request/response field names
// below are based on the documented endpoints (POST /order, POST
// /order/cost) but have not yet been exercised against a live sandbox
// response — confirm exact field names there before flipping
// DELIVERY_INTEGRATIONS_ENABLED on in production. Kept off by default for
// exactly this reason.

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
        pickup: { address: input.pickupAddress, state: input.pickupState },
        dropoff: { address: input.dropoffAddress, state: input.dropoffState },
        packageDescription: input.packageDescription,
        packageValue: input.packageValueNaira,
      }),
    })

    if (!ok) {
      console.error(JSON.stringify({ level: 'error', msg: 'FEZ quote failed', status, body }))
      return { status: status >= 500 ? 'unavailable' : 'error' }
    }

    const data = body as { cost?: number; vat?: number; total?: number; quoteId?: string; expiresAt?: string } | undefined
    if (!data || typeof data.total !== 'number') {
      console.error(JSON.stringify({ level: 'error', msg: 'FEZ quote response missing total', body }))
      return { status: 'error' }
    }

    return {
      status: 'quoted',
      feeKobo: Math.round(data.total * 100),
      providerQuoteId: data.quoteId,
      expiresAt: data.expiresAt,
    }
  } catch (err) {
    console.error(JSON.stringify({ level: 'error', msg: 'FEZ quote request threw', err: err instanceof Error ? err.message : String(err) }))
    return { status: 'unavailable' }
  }
}

export async function createOrder(input: DeliveryOrderInput): Promise<DeliveryBookingResult> {
  const h = headers()
  if (!h) return { status: 'error' }

  try {
    const { ok, status, body } = await fezFetch('/order', {
      method: 'POST',
      headers: h,
      body: JSON.stringify({
        quoteId: input.providerQuoteId,
        pickup: { address: input.pickupAddress, state: input.pickupState },
        dropoff: { address: input.dropoffAddress, state: input.dropoffState },
        recipient: { phone: input.customerPhone, name: input.customerName },
        packageDescription: input.packageDescription,
        packageValue: input.packageValueNaira,
      }),
    })

    if (!ok) {
      console.error(JSON.stringify({ level: 'error', msg: 'FEZ create order failed', status, body }))
      // 5xx / network-shaped failures are worth retrying; anything else
      // (bad request, expired quote) is not — the caller must re-quote.
      return { status: status >= 500 ? 'retryable' : 'error' }
    }

    const data = body as { orderNumber?: string; trackingUrl?: string } | undefined
    if (!data?.orderNumber) {
      console.error(JSON.stringify({ level: 'error', msg: 'FEZ create order response missing orderNumber', body }))
      return { status: 'error' }
    }

    return { status: 'booked', providerOrderId: data.orderNumber, trackingUrl: data.trackingUrl }
  } catch (err) {
    console.error(JSON.stringify({ level: 'error', msg: 'FEZ create order request threw', err: err instanceof Error ? err.message : String(err) }))
    return { status: 'retryable' }
  }
}

export async function getStatus(providerOrderId: string): Promise<DeliveryStatusResult> {
  const h = headers()
  if (!h) return { status: 'pending' }

  try {
    const { ok, body } = await fezFetch(`/order/${encodeURIComponent(providerOrderId)}`, {
      method: 'GET',
      headers: h,
    })
    if (!ok) return { status: 'pending' }

    const data = body as { orderStatus?: string } | undefined
    return { status: mapStatus(data?.orderStatus), raw: data?.orderStatus }
  } catch (err) {
    console.error(JSON.stringify({ level: 'error', msg: 'FEZ get status request threw', err: err instanceof Error ? err.message : String(err) }))
    return { status: 'pending' }
  }
}

export async function cancelOrder(providerOrderId: string): Promise<DeliveryCancelResult> {
  const h = headers()
  if (!h) return { status: 'error' }

  try {
    const { ok, status, body } = await fezFetch(`/order/${encodeURIComponent(providerOrderId)}`, {
      method: 'DELETE',
      headers: h,
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

// FEZ's raw orderStatus vocabulary isn't fully documented — map the values
// confirmed in the webhook docs, and treat anything unrecognized as
// 'pending' rather than guessing, so an unmapped status never gets silently
// misreported as terminal.
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
