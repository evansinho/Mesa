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
  beforeEach(async () => {
    await resetDb()
    await flushTestRedis()
  })

  afterAll(async () => {
    await closeTestDb()
    await closeTestRedis()
  })
}