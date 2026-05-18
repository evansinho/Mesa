import { lagosDateKey, nextLagosMidnight } from '../../src/ai/quota'

describe('lagosDateKey (F-10)', () => {
  it('returns the Lagos-local YYYY-MM-DD for a UTC midnight instant', () => {
    // 2026-05-17 00:00:00 UTC → 2026-05-17 01:00:00 Lagos (still same day)
    const utcMidnight = new Date('2026-05-17T00:00:00Z')
    expect(lagosDateKey(utcMidnight)).toBe('2026-05-17')
  })

  it('rolls forward when UTC is the prior day but Lagos has crossed midnight', () => {
    // 2026-05-17 23:30:00 UTC = 2026-05-18 00:30:00 Lagos
    const before = new Date('2026-05-17T23:30:00Z')
    expect(lagosDateKey(before)).toBe('2026-05-18')
  })

  it('does NOT roll forward on the UTC midnight boundary alone', () => {
    // 2026-05-17 22:59:00 UTC = 2026-05-17 23:59:00 Lagos (same day still)
    const before = new Date('2026-05-17T22:59:00Z')
    expect(lagosDateKey(before)).toBe('2026-05-17')
  })
})

describe('nextLagosMidnight (F-10)', () => {
  it('returns the next 00:00 Lagos as a UTC Date (which is 23:00 UTC the prior day)', () => {
    // Now: 2026-05-17 10:00 UTC = 2026-05-17 11:00 Lagos.
    // Next Lagos midnight = 2026-05-18 00:00 Lagos = 2026-05-17 23:00 UTC.
    const now = new Date('2026-05-17T10:00:00Z')
    const expected = new Date('2026-05-17T23:00:00Z')
    expect(nextLagosMidnight(now).toISOString()).toBe(expected.toISOString())
  })

  it('crosses correctly when called right before Lagos midnight', () => {
    // Now: 2026-05-17 22:30 UTC = 2026-05-17 23:30 Lagos.
    // Next Lagos midnight = 2026-05-18 00:00 Lagos = 2026-05-17 23:00 UTC.
    // (We're still 30 min away from Lagos midnight.)
    const now = new Date('2026-05-17T22:30:00Z')
    expect(nextLagosMidnight(now).toISOString()).toBe('2026-05-17T23:00:00.000Z')
  })

  it('returns a Date in the future', () => {
    const now = new Date('2026-05-17T10:00:00Z')
    expect(nextLagosMidnight(now).getTime()).toBeGreaterThan(now.getTime())
  })
})