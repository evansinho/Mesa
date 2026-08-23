// Which provider handles a given pickup→dropoff pair. FEZ is nationwide and
// safe as a default; Kwik is on-demand but same-city only (Lagos/Abuja).
// Never guess Kwik for an unknown destination — an on-demand same-city
// dispatch sent interstate would fail outright, whereas FEZ handles any
// route including ones we can't classify. See idea/plans note: Abuja
// coverage is Kwik's own weaker-confirmed claim (vs. Lagos) — verify it's
// actually live in their vendor dashboard before relying on it in
// production; remove from this set if not.
const KWIK_ELIGIBLE_STATES = new Set(['lagos', 'abuja', 'fct'])

function normalizeState(state: string | undefined | null): string | undefined {
  if (!state) return undefined
  const trimmed = state.trim().toLowerCase()
  return trimmed.length > 0 ? trimmed : undefined
}

export interface ResolveProviderInput {
  pickupState?: string | null
  dropoffState?: string | null
  preferredProvider?: 'FEZ' | 'KWIK' | null
}

export function resolveProvider(input: ResolveProviderInput): 'FEZ' | 'KWIK' | null {
  const pickup = normalizeState(input.pickupState)
  const dropoff = normalizeState(input.dropoffState)

  const kwikEligible = pickup !== undefined
    && dropoff !== undefined
    && KWIK_ELIGIBLE_STATES.has(pickup)
    && KWIK_ELIGIBLE_STATES.has(dropoff)

  if (input.preferredProvider === 'KWIK' && kwikEligible) return 'KWIK'
  if (input.preferredProvider === 'FEZ') return 'FEZ'
  if (kwikEligible) return 'KWIK'
  // FEZ is nationwide and the safe fallback whenever the destination state
  // is unknown or outside Kwik's same-city coverage — never block booking
  // on missing address structure.
  return 'FEZ'
}
