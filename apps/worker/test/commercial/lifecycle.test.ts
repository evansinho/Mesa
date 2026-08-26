import { commercialRules } from '@mesa/config'
import {
  deriveLifecycleState,
  isActivated,
  transitionTimestamp,
  RULE_INDEPENDENT_STATES,
  type MerchantFacts,
} from '../../src/commercial/lifecycle'

const SIGNED_UP_AT = new Date('2026-08-01T09:00:00Z')
const NOW = new Date('2026-08-26T09:00:00Z')

function facts(overrides: Partial<MerchantFacts> = {}): MerchantFacts {
  return {
    merchantId: 'm1',
    signedUpAt: SIGNED_UP_AT,
    connectedAt: null,
    firstValueAt: null,
    firstPaymentAt: null,
    ordersInActivationWindow: 0,
    ordersInRiskWindow: 0,
    everActivated: false,
    subscriptionStatus: 'trialing',
    ...overrides,
  }
}

describe('deriveLifecycleState — the ladder', () => {
  it('a fresh signup with nothing connected is SIGNED_UP', () => {
    expect(deriveLifecycleState(facts())).toBe('SIGNED_UP')
  })

  it('connecting a channel advances to CONNECTED', () => {
    expect(deriveLifecycleState(facts({ connectedAt: new Date('2026-08-02T09:00:00Z') })))
      .toBe('CONNECTED')
  })

  it('a first order past PENDING advances to FIRST_VALUE', () => {
    expect(
      deriveLifecycleState(
        facts({
          connectedAt: new Date('2026-08-02T09:00:00Z'),
          firstValueAt: new Date('2026-08-03T09:00:00Z'),
          ordersInRiskWindow: 1,
        }),
      ),
    ).toBe('FIRST_VALUE')
  })

  it('a confirmed payment advances to FIRST_PAYMENT', () => {
    expect(
      deriveLifecycleState(
        facts({
          connectedAt: SIGNED_UP_AT,
          firstValueAt: SIGNED_UP_AT,
          firstPaymentAt: new Date('2026-08-04T09:00:00Z'),
          ordersInRiskWindow: 1,
        }),
      ),
    ).toBe('FIRST_PAYMENT')
  })

  it('hitting the activation rule advances to ACTIVATED', () => {
    expect(
      deriveLifecycleState(
        facts({
          connectedAt: SIGNED_UP_AT,
          firstValueAt: SIGNED_UP_AT,
          ordersInActivationWindow: commercialRules.activation.minOrders,
          ordersInRiskWindow: 5,
        }),
      ),
    ).toBe('ACTIVATED')
  })

  it('an active subscription reads as PAYING', () => {
    expect(
      deriveLifecycleState(
        facts({
          subscriptionStatus: 'active',
          connectedAt: SIGNED_UP_AT,
          ordersInRiskWindow: 2,
        }),
      ),
    ).toBe('PAYING')
  })
})

describe('deriveLifecycleState — activation counts orders, not payments', () => {
  it('activates a merchant taking cash on delivery, who never produces a payment row', () => {
    // The whole point of gating activation on orders: a merchant collecting
    // cash or POS on delivery is genuinely using Mesa for order capture.
    // Gating on confirmed payments would mark that entire segment unactivated
    // and send the team to rescue merchants who are perfectly fine.
    const state = deriveLifecycleState(
      facts({
        connectedAt: SIGNED_UP_AT,
        firstValueAt: SIGNED_UP_AT,
        firstPaymentAt: null,
        ordersInActivationWindow: 4,
        ordersInRiskWindow: 4,
      }),
    )
    expect(state).toBe('ACTIVATED')
  })

  it('does not activate one order short of the rule', () => {
    expect(isActivated({ ordersInActivationWindow: commercialRules.activation.minOrders - 1 }))
      .toBe(false)
    expect(isActivated({ ordersInActivationWindow: commercialRules.activation.minOrders }))
      .toBe(true)
  })
})

describe('deriveLifecycleState — at risk', () => {
  it('flags a previously-activated merchant who has gone quiet', () => {
    expect(
      deriveLifecycleState(
        facts({
          connectedAt: SIGNED_UP_AT,
          firstValueAt: SIGNED_UP_AT,
          everActivated: true,
          ordersInActivationWindow: 0,
          ordersInRiskWindow: 0,
        }),
      ),
    ).toBe('AT_RISK')
  })

  it('takes precedence over PAYING — a paying merchant who stopped selling is the story', () => {
    expect(
      deriveLifecycleState(
        facts({
          subscriptionStatus: 'active',
          everActivated: true,
          ordersInRiskWindow: 0,
        }),
      ),
    ).toBe('AT_RISK')
  })

  it('does NOT flag a merchant who never got going — that is a failed activation', () => {
    // Different problem, different fix. Lumping the two together would bury
    // the merchants who need onboarding help among the ones who need
    // re-engaging.
    const state = deriveLifecycleState(
      facts({ connectedAt: SIGNED_UP_AT, everActivated: false, ordersInRiskWindow: 0 }),
    )
    expect(state).toBe('CONNECTED')
  })

  it('clears back to PAYING once orders resume', () => {
    expect(
      deriveLifecycleState(
        facts({ subscriptionStatus: 'active', everActivated: true, ordersInRiskWindow: 1 }),
      ),
    ).toBe('PAYING')
  })
})

describe('deriveLifecycleState — churn wins outright', () => {
  it.each(['expired', 'cancelled'] as const)('%s reads as CHURNED', (status) => {
    expect(
      deriveLifecycleState(
        facts({
          subscriptionStatus: status,
          connectedAt: SIGNED_UP_AT,
          everActivated: true,
          ordersInActivationWindow: 10,
          ordersInRiskWindow: 10,
        }),
      ),
    ).toBe('CHURNED')
  })
})

describe('transitionTimestamp', () => {
  it('stamps fact-based states with the fact’s own timestamp, not detection time', () => {
    // A sweep that runs late must not claim the merchant connected the moment
    // we noticed — that would corrupt every "median time to connect" figure.
    const connectedAt = new Date('2026-08-02T09:00:00Z')
    expect(transitionTimestamp('CONNECTED', facts({ connectedAt }), NOW)).toEqual(connectedAt)
    expect(transitionTimestamp('SIGNED_UP', facts(), NOW)).toEqual(SIGNED_UP_AT)
  })

  it('stamps rule-dependent states with detection time', () => {
    // ACTIVATED has no timestamp of its own: it depends on a rule that can
    // change. The row records ruleVersion so the reading stays interpretable.
    expect(transitionTimestamp('ACTIVATED', facts(), NOW)).toEqual(NOW)
    expect(transitionTimestamp('AT_RISK', facts(), NOW)).toEqual(NOW)
  })

  it('falls back to now when a fact-based state somehow lacks its fact', () => {
    expect(transitionTimestamp('CONNECTED', facts({ connectedAt: null }), NOW)).toEqual(NOW)
  })
})

describe('RULE_INDEPENDENT_STATES', () => {
  it('covers exactly the states recoverable from immutable timestamps', () => {
    // These never need backfilling after a rule change; the others do. Getting
    // this set wrong means either pointless backfill churn or stale cohorts.
    expect([...RULE_INDEPENDENT_STATES].sort()).toEqual(
      ['CONNECTED', 'FIRST_PAYMENT', 'FIRST_VALUE', 'SIGNED_UP'].sort(),
    )
    for (const ruleDependent of ['ACTIVATED', 'PAYING', 'AT_RISK', 'CHURNED'] as const) {
      expect(RULE_INDEPENDENT_STATES.has(ruleDependent)).toBe(false)
    }
  })
})
