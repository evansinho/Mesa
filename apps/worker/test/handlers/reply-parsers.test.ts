import {
  isYes,
  isNo,
  isPaymentDetailsRequest,
  parseOrderCorrection,
  parsePriceReply,
  priceWithinReasonableRange,
} from '../../src/handlers/message.handler'

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
    ['paid'],
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
  it.each([['no'], ['NO'], ['n'], ['cancel'], ['reject'], ['dispute'], ['payment_dispute'], ['No.'], [' no ']])(
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
    // Nigerian shorthand — "38k" must be ₦38,000, never ₦38 (Sino regression)
    ['38k', 38000, false],
    ['₦38k', 38000, false],
    ['1.5m', 1500000, false],
    ['CONFIRM 38k', 38000, true],
    ['5000 naira', 5000, false],
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
    ['5000 dollars'], // unknown trailing word
    ["It's 40k"], // conversational quote — must flow to the ledger, not the task
  ])('rejects %s', (input) => {
    expect(parsePriceReply(input)).toBeNull()
  })
})

describe('isPaymentDetailsRequest', () => {
  it.each([
    ['send aza'],
    ['aza'],
    ['account details'],
    ['acc details abeg'],
    ['send account'],
    ['how do I pay?'],
  ])('accepts %s', (input) => {
    expect(isPaymentDetailsRequest(input)).toBe(true)
  })

  it.each([
    ['how much is it'],
    ['payment made'],
    ['I will pay later'],
    ['hello'],
  ])('rejects %s', (input) => {
    expect(isPaymentDetailsRequest(input)).toBe(false)
  })
})

describe('parseOrderCorrection', () => {
  it('parses corrected items and total', () => {
    expect(parseOrderCorrection('2x rice, 1x beans = 180000')).toEqual({
      items: [
        { productName: 'rice', quantity: 2 },
        { productName: 'beans', quantity: 1 },
      ],
      total: 180000,
    })
  })

  it('parses k-suffix totals — "1x sweater = 38k" is ₦38,000, not ₦38 (Sino regression)', () => {
    expect(parseOrderCorrection('1x sweater = 38k')).toEqual({
      items: [{ productName: 'sweater', quantity: 1 }],
      total: 38000,
    })
  })

  it('accepts newline separated items and formatted naira total', () => {
    expect(parseOrderCorrection('2x rice\n1x beans = ₦180,000')).toEqual({
      items: [
        { productName: 'rice', quantity: 2 },
        { productName: 'beans', quantity: 1 },
      ],
      total: 180000,
    })
  })

  it.each([
    ['rice and beans = 180000'],
    ['2x rice, beans = 180000'],
    ['2x rice ='],
    ['2x rice'],
    ['2x rice = 0'],
  ])('rejects %s', (input) => {
    expect(parseOrderCorrection(input)).toBeNull()
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
