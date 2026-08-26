import { commercialRules } from '@mesa/config'

export type LifecycleState =
  | 'SIGNED_UP'
  | 'CONNECTED'
  | 'FIRST_VALUE'
  | 'FIRST_PAYMENT'
  | 'ACTIVATED'
  | 'PAYING'
  | 'AT_RISK'
  | 'CHURNED'

/**
 * The facts a merchant's lifecycle state is derived from.
 *
 * Every field comes straight out of the product tables. Nothing here is
 * settable by a human, which is the entire point: a rep cannot move a merchant
 * to ACTIVATED, they can only help the merchant do the thing that makes it
 * true.
 */
export interface MerchantFacts {
  merchantId: string
  signedUpAt: Date
  /** min(merchant_channels.connected_at) where the channel is still connected. */
  connectedAt: Date | null
  /**
   * First order that got past PENDING.
   *
   * A row in `orders` is Mesa *detecting* an order, not the merchant receiving
   * value — orders default to PENDING. Counting PENDING rows here would
   * inflate the funnel with detection false-positives and make every
   * downstream conversion number a lie.
   */
  firstValueAt: Date | null
  /** min(payments.confirmed_at) where status = 'CONFIRMED'. */
  firstPaymentAt: Date | null
  /** Orders past PENDING within the activation window, counted now. */
  ordersInActivationWindow: number
  /** Orders past PENDING within the risk window, counted now. */
  ordersInRiskWindow: number
  /** Whether this merchant has EVER satisfied the activation rule. */
  everActivated: boolean
  subscriptionStatus: 'trialing' | 'active' | 'past_due' | 'expired' | 'cancelled'
}

/**
 * Derive a merchant's current lifecycle state.
 *
 * Pure, and deliberately so — the sweep does the I/O, this decides. It means
 * the state machine can be tested exhaustively without a database, which
 * matters because every commercial number in the company inherits its answer.
 *
 * States are checked most-advanced-first, so the result is the furthest point
 * a merchant has reached, with the two exits (churn, risk) taking precedence
 * over it. Order is load-bearing; reordering these branches changes what the
 * funnel means.
 */
export function deriveLifecycleState(facts: MerchantFacts): LifecycleState {
  const { risk } = commercialRules

  // Terminal, and set by billing rather than behaviour.
  if (facts.subscriptionStatus === 'expired' || facts.subscriptionStatus === 'cancelled') {
    return 'CHURNED'
  }

  // A merchant who got going and then went quiet. Checked before PAYING and
  // ACTIVATED because it is the state someone has to act on — a merchant can
  // be paying and silent, and "paying" is the less useful thing to know about
  // them.
  const wentQuiet = facts.ordersInRiskWindow === 0
  const eligibleForRisk = risk.requiresPriorActivation ? facts.everActivated : true
  if (wentQuiet && eligibleForRisk) {
    return 'AT_RISK'
  }

  // Paying and still transacting.
  if (facts.subscriptionStatus === 'active') {
    return 'PAYING'
  }

  if (isActivated(facts)) return 'ACTIVATED'
  if (facts.firstPaymentAt) return 'FIRST_PAYMENT'
  if (facts.firstValueAt) return 'FIRST_VALUE'
  if (facts.connectedAt) return 'CONNECTED'
  return 'SIGNED_UP'
}

/** The activation rule, as one place rather than sprinkled through queries. */
export function isActivated(facts: Pick<MerchantFacts, 'ordersInActivationWindow'>): boolean {
  return facts.ordersInActivationWindow >= commercialRules.activation.minOrders
}

/**
 * Timestamp to record a transition at.
 *
 * States that come from an immutable fact are stamped with that fact's own
 * timestamp, so a sweep that runs late doesn't claim the merchant connected
 * the moment we noticed. Rule-dependent states (ACTIVATED, AT_RISK) have no
 * such timestamp available — the rule could change tomorrow — so they are
 * stamped with detection time, and `ruleVersion` on the row records which rule
 * produced them.
 */
export function transitionTimestamp(
  state: LifecycleState,
  facts: MerchantFacts,
  now: Date,
): Date {
  switch (state) {
    case 'SIGNED_UP':
      return facts.signedUpAt
    case 'CONNECTED':
      return facts.connectedAt ?? now
    case 'FIRST_VALUE':
      return facts.firstValueAt ?? now
    case 'FIRST_PAYMENT':
      return facts.firstPaymentAt ?? now
    default:
      return now
  }
}

/**
 * Which states are recoverable from immutable timestamps, and therefore never
 * need backfilling when a rule changes.
 *
 * CONNECTED / FIRST_VALUE / FIRST_PAYMENT are facts about what happened.
 * ACTIVATED / AT_RISK / PAYING / CHURNED depend on a rule or on current
 * billing state, so a rule-version bump has to re-derive them.
 */
export const RULE_INDEPENDENT_STATES: ReadonlySet<LifecycleState> = new Set([
  'SIGNED_UP',
  'CONNECTED',
  'FIRST_VALUE',
  'FIRST_PAYMENT',
])
