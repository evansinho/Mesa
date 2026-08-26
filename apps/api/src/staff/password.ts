import { hash, verify, Algorithm } from '@node-rs/argon2'

// Argon2id: OWASP's first-choice password KDF, and there are no legacy hashes
// here to stay compatible with, which is bcrypt's main remaining advantage.
//
// @node-rs/argon2 (Rust, prebuilt binaries) rather than the node-gyp-based
// `argon2` package: production runs on node:20-slim (Debian/glibc) where both
// work, but prebuilds avoid needing a build toolchain in the image, and this
// workspace already has one native-binary version mismatch to its name.
//
// Parameters are OWASP's Argon2id recommendation: 19 MiB memory, 2 iterations,
// 1 degree of parallelism. Roughly 50ms per hash.
const PARAMS = {
  algorithm: Algorithm.Argon2id,
  memoryCost: 19456, // KiB
  timeCost: 2,
  parallelism: 1,
}

export async function hashPassword(password: string): Promise<string> {
  // Returns the PHC string — `$argon2id$v=19$m=19456,t=2,p=1$<salt>$<hash>`.
  // Salt is generated internally, and the parameters travel with the hash, so
  // raising PARAMS later leaves existing hashes verifiable.
  return hash(password, PARAMS)
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  try {
    return await verify(stored, password)
  } catch {
    // A malformed or truncated hash throws rather than returning false. Treat
    // it as a failed login: a corrupt row must not become an auth bypass.
    return false
  }
}
