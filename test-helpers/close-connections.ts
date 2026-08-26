/**
 * Registered via `setupFilesAfterEnv`, so it runs for every test file.
 *
 * Closes the cached Postgres and Redis clients after each file, whether or not
 * the file remembered to. Both helpers are idempotent and both getters
 * re-create on demand, so this is safe alongside `setupIntegration()`'s own
 * teardown.
 *
 * This exists because forgetting to close is invisible until CI. One test file
 * holding an open ioredis connection keeps the event loop alive, so every test
 * passes and then jest simply never exits — the run reads as hung rather than
 * failed, and it burns the job's entire timeout.
 *
 * It has happened twice: a NATS client (fixed in 8acd3ed, "Stop the new NATS
 * test from hanging CI for 20+ minutes") and Redis in
 * kwik.integration.test.ts, the only Redis-using worker suite that did not call
 * setupIntegration(). Fixing just the instance leaves the trap for the next
 * person, so the teardown is global.
 *
 * The requires are deliberately lazy and inside the hook. Importing them at
 * module scope pulls in `pg`, which needs `TextEncoder` and therefore explodes
 * under jsdom — which is how the first version of this file broke the one
 * project that renders components and never opens a database at all.
 */
afterAll(async () => {
  try {
    const { closeTestDb } = require('./db') as typeof import('./db')
    await closeTestDb()
  } catch {
    // No database in this project (jsdom), or it was never opened.
  }

  try {
    const { closeTestRedis } = require('./redis') as typeof import('./redis')
    await closeTestRedis()
  } catch {
    // No Redis in this project, or it was never opened.
  }
})
