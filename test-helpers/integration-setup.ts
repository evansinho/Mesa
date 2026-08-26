import { resetDb, closeTestDb } from './db'
import { flushTestRedis, closeTestRedis } from './redis'

// Call this at the top of any integration test file to register the
// per-test reset hooks. Skip the import in pure-unit tests so they don't
// require docker.
//
//   import { setupIntegration } from '../helpers/integration-setup'
//   setupIntegration()
//
//   describe('thing', () => { ... })
export function setupIntegration(): void {
  // Explicit hook timeout. The default that applied here was 5s, and a
  // database reset on a contended CI runner can exceed that even now it is a
  // single statement — a flake that fails the whole run and says nothing about
  // which test was at fault.
  beforeEach(async () => {
    await resetDb()
    await flushTestRedis()
  }, 30_000)

  afterAll(async () => {
    await closeTestDb()
    await closeTestRedis()
  })
}