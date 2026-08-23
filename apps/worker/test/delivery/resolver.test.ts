import { resolveProvider } from '../../src/delivery/resolver'

describe('resolveProvider', () => {
  it('picks Kwik for a Lagos-to-Lagos delivery with no preference', () => {
    expect(resolveProvider({ pickupState: 'Lagos', dropoffState: 'Lagos' })).toBe('KWIK')
  })

  it('is case/whitespace insensitive on state names', () => {
    expect(resolveProvider({ pickupState: '  LAGOS ', dropoffState: 'lagos' })).toBe('KWIK')
  })

  it('picks Kwik for Abuja-to-Abuja', () => {
    expect(resolveProvider({ pickupState: 'Abuja', dropoffState: 'Abuja' })).toBe('KWIK')
  })

  it('falls back to FEZ for an interstate route', () => {
    expect(resolveProvider({ pickupState: 'Lagos', dropoffState: 'Ogun' })).toBe('FEZ')
  })

  it('falls back to FEZ when the dropoff state is unknown — never guesses Kwik for an uncertain destination', () => {
    expect(resolveProvider({ pickupState: 'Lagos', dropoffState: undefined })).toBe('FEZ')
  })

  it('falls back to FEZ when both states are unknown', () => {
    expect(resolveProvider({})).toBe('FEZ')
  })

  it('honors an explicit FEZ preference even for a Kwik-eligible same-city route', () => {
    expect(resolveProvider({ pickupState: 'Lagos', dropoffState: 'Lagos', preferredProvider: 'FEZ' })).toBe('FEZ')
  })

  it('ignores a Kwik preference when the route is not Kwik-eligible — never sends an interstate job to an on-demand same-city provider', () => {
    expect(resolveProvider({ pickupState: 'Lagos', dropoffState: 'Ogun', preferredProvider: 'KWIK' })).toBe('FEZ')
  })

  it('honors a Kwik preference when the route is eligible', () => {
    expect(resolveProvider({ pickupState: 'Lagos', dropoffState: 'Abuja', preferredProvider: 'KWIK' })).toBe('KWIK')
  })
})
