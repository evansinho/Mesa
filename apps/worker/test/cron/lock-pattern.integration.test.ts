import { getTestRedis } from '@test-helpers/redis'
import { setupIntegration } from '@test-helpers/integration-setup'

setupIntegration()

// F-14: All cron bodies in apps/worker/src/index.ts wrap their work in the
// same Redis `SET key '1' EX ttl NX` lock pattern. This test exercises that
// pattern in isolation. The full per-cron contention tests would require
// extracting each cron body into a testable function — currently the bodies
// are inline in index.ts. See testing-plan.md for the planned refactor.
//
// The outbox publisher integration suite tests the same pattern through the
// publisher's own tick(); this is the abstract version.

describe('cron Redis lock pattern (F-14)', () => {
  it('two concurrent acquisitions on the same key: only one wins', async () => {
    const redis = getTestRedis()
    const a = await redis.set('cron:lock:test_a', '1', 'EX', 30, 'NX')
    const b = await redis.set('cron:lock:test_a', '1', 'EX', 30, 'NX')

    expect(a).toBe('OK')
    expect(b).toBeNull()
  })

  it('releasing the lock allows a subsequent acquisition', async () => {
    const redis = getTestRedis()
    const first = await redis.set('cron:lock:test_b', '1', 'EX', 30, 'NX')
    await redis.del('cron:lock:test_b')
    const second = await redis.set('cron:lock:test_b', '1', 'EX', 30, 'NX')

    expect(first).toBe('OK')
    expect(second).toBe('OK')
  })

  it('TTL expires the lock automatically so a stale holder cannot block forever', async () => {
    const redis = getTestRedis()
    const first = await redis.set('cron:lock:test_c', '1', 'EX', 1, 'NX')
    expect(first).toBe('OK')

    await new Promise(resolve => setTimeout(resolve, 1200))

    const second = await redis.set('cron:lock:test_c', '1', 'EX', 30, 'NX')
    expect(second).toBe('OK')
  })

  it('different lock keys do not interfere with each other', async () => {
    const redis = getTestRedis()
    const monoLock = await redis.set('cron:lock:mono_retries', '1', 'EX', 30, 'NX')
    const reorderLock = await redis.set('cron:lock:reorder_reminders', '1', 'EX', 30, 'NX')
    const onboardingLock = await redis.set('cron:lock:onboarding_followup', '1', 'EX', 30, 'NX')
    const pendingLock = await redis.set('cron:lock:pending_decisions', '1', 'EX', 30, 'NX')
    const outboxLock = await redis.set('outbox:publisher:lock', '1', 'EX', 30, 'NX')

    expect(monoLock).toBe('OK')
    expect(reorderLock).toBe('OK')
    expect(onboardingLock).toBe('OK')
    expect(pendingLock).toBe('OK')
    expect(outboxLock).toBe('OK')
  })
})