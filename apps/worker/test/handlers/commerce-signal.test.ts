import { hasCommerceSignal } from '../../src/handlers/message.handler'
import type { ConversationState } from '@mesa/types'

describe('hasCommerceSignal — NLP cost gate', () => {
  it('skips empty and whitespace-only messages', () => {
    expect(hasCommerceSignal('', 'IDLE')).toBe(false)
    expect(hasCommerceSignal('   ', 'IDLE')).toBe(false)
  })

  it('skips pure emoji / punctuation', () => {
    expect(hasCommerceSignal('👍', 'IDLE')).toBe(false)
    expect(hasCommerceSignal('!!!', 'IDLE')).toBe(false)
    expect(hasCommerceSignal('😀😀', 'BROWSING')).toBe(false)
  })

  it('skips bare greetings/acks when no deal is in flight', () => {
    for (const word of ['hi', 'hello', 'Hey', 'thanks', 'ok', 'okay', 'good morning']) {
      expect(hasCommerceSignal(word, 'IDLE')).toBe(false)
      expect(hasCommerceSignal(word, 'COMPLETE')).toBe(false)
    }
  })

  it('ALWAYS analyzes during an active deal — short acks are meaningful there', () => {
    const activeStates: ConversationState[] = ['NEGOTIATING', 'AGREED', 'ORDER_CREATED', 'AWAITING_PAYMENT']
    for (const state of activeStates) {
      expect(hasCommerceSignal('ok', state)).toBe(true)
      expect(hasCommerceSignal('👍', state)).toBe(true) // even emoji — could be a thumbs-up confirm
    }
  })

  it('analyzes anything that looks like commerce', () => {
    expect(hasCommerceSignal('I want 3 bags of rice', 'IDLE')).toBe(true)
    expect(hasCommerceSignal('how much for garri?', 'IDLE')).toBe(true)
    expect(hasCommerceSignal('hello I want rice', 'IDLE')).toBe(true) // multi-word, not a bare greeting
    expect(hasCommerceSignal('5000', 'NEGOTIATING')).toBe(true)
  })

  it('does not skip a greeting that carries more content', () => {
    expect(hasCommerceSignal('hi do you have oil', 'IDLE')).toBe(true)
  })
})