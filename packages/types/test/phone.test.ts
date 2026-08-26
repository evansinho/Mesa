import { normalizePhone } from '../src/phone'

describe('normalizePhone', () => {
  it('normalizes the forms Nigerian merchants actually type', () => {
    // All of these are the same number.
    expect(normalizePhone('08031234567')).toBe('+2348031234567')
    expect(normalizePhone('8031234567')).toBe('+2348031234567')
    expect(normalizePhone('2348031234567')).toBe('+2348031234567')
    expect(normalizePhone('+234 803 123 4567')).toBe('+2348031234567')
    expect(normalizePhone('+234-803-123-4567')).toBe('+2348031234567')
    expect(normalizePhone('(0803) 123 4567')).toBe('+2348031234567')
  })

  it('is idempotent — re-normalizing an already-normal number is a no-op', () => {
    const once = normalizePhone('08031234567')
    expect(normalizePhone(once)).toBe(once)
  })

  it('does not validate — garbage in produces a prefixed string, not a throw', () => {
    // Documents current behaviour so prospect matching treats a malformed
    // number as "no match" rather than relying on an exception.
    expect(normalizePhone('')).toBe('+234')
    expect(normalizePhone('abc')).toBe('+234')
    expect(normalizePhone('123')).toBe('+234123')
  })
})
