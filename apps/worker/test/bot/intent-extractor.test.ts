import { IntentExtractor } from '../../src/bot/intent-extractor'

describe('IntentExtractor', () => {
  it.each([
    ['Yes pls'],
    ['Yes please'],
    ['yes abeg'],
  ])('treats %s as cart confirmation', (input) => {
    const extractor = new IntentExtractor()
    expect(extractor.extract(input, [])).toEqual({ type: 'cart_confirmation' })
  })
})
