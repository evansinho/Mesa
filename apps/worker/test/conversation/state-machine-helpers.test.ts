import { ConversationStateMachine, hydrateContext } from '../../src/conversation/state-machine'
import type { ConversationState } from '@mesa/types'

// canTransition is pure; we can call it on any instance.
const sm = new ConversationStateMachine({} as never, {} as never)

describe('canTransition (F-1)', () => {
  const validPairs: Array<[ConversationState, ConversationState]> = [
    ['IDLE', 'BROWSING'],
    ['IDLE', 'NEGOTIATING'],
    ['IDLE', 'ORDER_CREATED'],
    ['BROWSING', 'NEGOTIATING'],
    ['BROWSING', 'ORDER_CREATED'],
    ['BROWSING', 'IDLE'],
    ['NEGOTIATING', 'AGREED'],
    ['NEGOTIATING', 'ORDER_CREATED'],
    ['NEGOTIATING', 'BROWSING'],
    ['NEGOTIATING', 'IDLE'],
    ['AGREED', 'ORDER_CREATED'],
    ['AGREED', 'NEGOTIATING'],
    ['AGREED', 'IDLE'],
    ['ORDER_CREATED', 'AWAITING_PAYMENT'],
    ['ORDER_CREATED', 'IDLE'],
    ['AWAITING_PAYMENT', 'PAYMENT_RECEIVED'],
    ['AWAITING_PAYMENT', 'ORDER_CREATED'],
    ['AWAITING_PAYMENT', 'IDLE'],
    ['PAYMENT_RECEIVED', 'COMPLETE'],
    ['COMPLETE', 'IDLE'],
  ]

  it.each(validPairs)('accepts %s → %s', (from, to) => {
    expect(sm.canTransition(from, to)).toBe(true)
  })

  const invalidPairs: Array<[ConversationState, ConversationState]> = [
    ['NEGOTIATING', 'NEGOTIATING'], // self-loop — must be false
    ['IDLE', 'AGREED'], // can't skip negotiation
    ['IDLE', 'PAYMENT_RECEIVED'],
    ['COMPLETE', 'BROWSING'],
    ['PAYMENT_RECEIVED', 'IDLE'],
    ['AGREED', 'BROWSING'], // re-negotiate path goes through NEGOTIATING
  ]

  it.each(invalidPairs)('rejects %s → %s', (from, to) => {
    expect(sm.canTransition(from, to)).toBe(false)
  })
})

describe('hydrateContext (F-1)', () => {
  it('fills defaults on empty input', () => {
    const out = hydrateContext({})
    expect(out.currentItems).toEqual([])
    expect(out.negotiationHistory).toEqual([])
    expect(typeof out.lastMessageAt).toBe('string')
    expect(out.agreedPrice).toBeUndefined()
  })

  it('fills defaults on null input', () => {
    const out = hydrateContext(null)
    expect(out.currentItems).toEqual([])
    expect(out.negotiationHistory).toEqual([])
  })

  it('preserves existing fields', () => {
    const out = hydrateContext({
      currentItems: [{ productName: 'rice', quantity: 3 }],
      agreedPrice: 5000,
      lastQuotedPrice: 4500,
      orderId: 'order-1',
      negotiationHistory: [{ price: 5000, from: 'customer', timestamp: '2026-05-17' }],
      lastMessageAt: '2026-05-17T10:00:00Z',
    })
    expect(out.currentItems).toHaveLength(1)
    expect(out.agreedPrice).toBe(5000)
    expect(out.lastQuotedPrice).toBe(4500)
    expect(out.orderId).toBe('order-1')
    expect(out.negotiationHistory).toHaveLength(1)
    expect(out.lastMessageAt).toBe('2026-05-17T10:00:00Z')
  })

  it('coerces non-array currentItems to empty array', () => {
    const out = hydrateContext({ currentItems: 'not-an-array' })
    expect(out.currentItems).toEqual([])
  })

  it('regenerates lastMessageAt when missing or not a string', () => {
    const a = hydrateContext({ lastMessageAt: 123 })
    expect(typeof a.lastMessageAt).toBe('string')
    const b = hydrateContext({})
    expect(typeof b.lastMessageAt).toBe('string')
  })
})