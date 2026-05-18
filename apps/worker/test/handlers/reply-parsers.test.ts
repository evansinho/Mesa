import { isYes, isNo, parsePriceReply, priceWithinReasonableRange } from '../../src/handlers/message.handler'

describe('isYes (F-3)', () => {
  it.each([
    ['yes'],
    ['YES'],
    ['Yes'],
    ['y'],
    ['Y'],
    ['ok'],
    ['okay'],
    ['Okay'],
    ['sure'],
    ['confirm'],
    ['confirmed'],
    ['yes.'],
    ['yes!'],
    ['yes?'],
    [' yes '],
  ])('accepts %s', (input) => {
    expect(isYes(input)).toBe(true)
  })

  it.each([
    ['yes please'], // multi-word — not in allowlist
    ['yeah'],
    ['yep'],
    ['no'],
    ['hello'],
    ['5000'],
    ['YES 5000'],
    [''],
  ])('rejects %s', (input) => {
    expect(isYes(input)).toBe(false)
  })
})

describe('isNo (F-3)', () => {
  it.each([['no'], ['NO'], ['n'], ['cancel'], ['reject'], ['dispute'], ['No.'], [' no ']])(
    'accepts %s',
    (input) => {
      expect(isNo(input)).toBe(true)
    },
  )

  it.each([['nope'], ['nah'], ['not now'], ['yes']])('rejects %s', (input) => {
    expect(isNo(input)).toBe(false)
  })
})

describe('parsePriceReply (F-3)', () => {
  it.each([
    ['5000', 5000, false],
    ['5,000', 5000, false],
    ['₦5000', 5000, false],
    ['₦5,000', 5000, false],
    ['#5000', 5000, false],
    ['$5000', 5000, false],
    ['PRICE 5000', 5000, false],
    ['price 5000', 5000, false],
    ['PRICE ₦5,000', 5000, false],
    ['CONFIRM 50', 50, true],
    ['confirm ₦42,000', 42000, true],
  ])('parses %s → %d (forced=%s)', (input, value, forced) => {
    expect(parsePriceReply(input)).toEqual({ value, forced })
  })

  it.each([
    ['YES 5000'], // trailing text on a YES
    ['send 5000 later'], // arbitrary text containing digits
    ['tomorrow at 3pm'], // F-3 plan's example: "3pm" must NOT create a ₦3 order
    ['0'], // zero rejected
    ['-100'], // negative rejected (regex doesn't match the minus)
    [''], // empty
    ['abc'], // non-numeric
    ['5000 naira'], // trailing word
  ])('rejects %s', (input) => {
    expect(parsePriceReply(input)).toBeNull()
  })
})

describe('priceWithinReasonableRange (F-3)', () => {
  it('accepts within 10x ratio', () => {
    expect(priceWithinReasonableRange(5000, 5000)).toBe(true)
    expect(priceWithinReasonableRange(50000, 5000)).toBe(true) // 10x exact
    expect(priceWithinReasonableRange(500, 5000)).toBe(true) // 0.1x exact
  })

  it('rejects outside 10x ratio', () => {
    expect(priceWithinReasonableRange(50001, 5000)).toBe(false)
    expect(priceWithinReasonableRange(499, 5000)).toBe(false)
    expect(priceWithinReasonableRange(50, 5000)).toBe(false) // F-3 plan's "₦50 vs ₦5000"
  })

  it('accepts any override when no detected baseline exists', () => {
    expect(priceWithinReasonableRange(5000, 0)).toBe(true)
    expect(priceWithinReasonableRange(5000, undefined as unknown as number)).toBe(true)
  })
})