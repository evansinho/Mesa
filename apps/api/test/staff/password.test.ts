import { hashPassword, verifyPassword } from '../../src/staff/password'

describe('Staff password hashing', () => {
  it('round-trips a password', async () => {
    const stored = await hashPassword('correct-horse-battery-staple')
    expect(await verifyPassword('correct-horse-battery-staple', stored)).toBe(true)
  })

  it('rejects the wrong password', async () => {
    const stored = await hashPassword('correct-horse-battery-staple')
    expect(await verifyPassword('Correct-horse-battery-staple', stored)).toBe(false)
  })

  it('produces an Argon2id PHC string with the intended parameters', async () => {
    const stored = await hashPassword('whatever')
    expect(stored).toMatch(/^\$argon2id\$v=19\$m=19456,t=2,p=1\$/)
  })

  it('salts — the same password hashes differently every time', async () => {
    const [a, b] = await Promise.all([hashPassword('same'), hashPassword('same')])
    expect(a).not.toBe(b)
    expect(await verifyPassword('same', a)).toBe(true)
    expect(await verifyPassword('same', b)).toBe(true)
  })

  it('returns false rather than throwing on a malformed stored hash', async () => {
    // A corrupt row must be a failed login, never an unhandled 500 and never
    // an auth bypass.
    for (const bad of ['', 'not-a-hash', '$argon2id$broken', '$2b$10$legacybcryptvalue']) {
      expect(await verifyPassword('anything', bad)).toBe(false)
    }
  })
})

describe('Login timing defence', () => {
  it('the hardcoded dummy hash is a verifiable Argon2id hash', async () => {
    // The unknown-email path verifies against this constant so it costs the
    // same as a real check. If it ever stops being a valid PHC string, verify()
    // fails fast and response time silently becomes an account-existence
    // oracle — with no other test failing.
    const DUMMY_HASH =
      '$argon2id$v=19$m=19456,t=2,p=1$UXjZ30/1XiX5DhueZy2LZA$yNQjZqCZFSeOURuKoDVf2qU1Rev6it+aRziTrf7Z800'

    const start = process.hrtime.bigint()
    const result = await verifyPassword('some-attempted-password', DUMMY_HASH)
    const elapsedMs = Number(process.hrtime.bigint() - start) / 1e6

    expect(result).toBe(false)
    // A malformed hash returns in well under a millisecond; a real Argon2id
    // verify at m=19456,t=2 takes tens of milliseconds. Threshold is loose
    // enough to survive a slow CI box.
    expect(elapsedMs).toBeGreaterThan(5)
  })
})
