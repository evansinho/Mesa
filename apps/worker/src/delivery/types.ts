// Shared result shapes for delivery-provider adapters (FEZ, Kwik). Mirrors
// apps/worker/src/payments/mono.ts's convention: every adapter function
// returns one of these status-enum objects and never throws across the
// module boundary — callers decide what to do with a non-happy-path result
// (e.g. 'retryable' means enqueue a retry, not "something is broken").

export interface DeliveryQuoteResult {
  status: 'quoted' | 'unavailable' | 'error'
  feeKobo?: number
  etaMinutes?: number
  providerQuoteId?: string
  expiresAt?: string
}

export interface DeliveryBookingResult {
  status: 'booked' | 'retryable' | 'error'
  providerOrderId?: string
  trackingUrl?: string
}

export interface DeliveryStatusResult {
  status: 'pending' | 'assigned' | 'in_transit' | 'delivered' | 'failed' | 'cancelled'
  raw?: string
}

export interface DeliveryCancelResult {
  status: 'cancelled' | 'retryable' | 'error'
}

export interface DeliveryQuoteInput {
  pickupAddress: string
  pickupState: string
  dropoffAddress: string
  dropoffState: string
  packageDescription?: string
  packageValueNaira?: number
}

export interface DeliveryOrderInput extends DeliveryQuoteInput {
  // Stable across retries — used as FEZ's idempotency key (uniqueID) so a
  // retried booking attempt never risks creating a duplicate real-world order.
  fulfilmentId: string
  providerQuoteId: string
  customerPhone: string
  customerName?: string
}
