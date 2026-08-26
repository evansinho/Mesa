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

  it('throws a legible error on a non-string, rather than a TypeError deep inside', () => {
    // This reached production: POST /auth/request with an empty body passed
    // undefined through and surfaced in Sentry as "Cannot read properties of
    // undefined (reading 'replace')" three frames into a shared package, which
    // names neither the field nor the caller.
    //
    // Returning '' instead would be worse: the caller would go on to query for
    // a valid-looking phone that nobody has.
    for (const bad of [undefined, null, 42, {}, []] as unknown[]) {
      expect(() => normalizePhone(bad as string)).toThrow(/expected a string, received/)
    }
  })

  it('does not validate the shape of a real string — garbage in, prefixed string out', () => {
    // Documents current behaviour so prospect matching treats a malformed
    // number as "no match" rather than relying on an exception.
    expect(normalizePhone('')).toBe('+234')
    expect(normalizePhone('abc')).toBe('+234')
    expect(normalizePhone('123')).toBe('+234123')
  })
})
