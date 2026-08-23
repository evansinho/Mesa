import { MesaNatsClient } from '../src/client'

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return Promise.race([
    promise,
    new Promise<never>((_, reject) => setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms)),
  ])
}

describe('MesaNatsClient.getDlqDepth', () => {
  let client: MesaNatsClient
  // CI's NATS service container can't be started with JetStream enabled
  // (GitHub Actions service containers don't accept the `-js` arg the way
  // local `docker compose` does — see ci.yml, which documents this as
  // deliberate). Every other integration test in this repo avoids the real
  // NATS client for exactly this reason. This was the first to use one for
  // real, and the first attempt hung CI for 20+ minutes: jetstreamManager()
  // against a non-JetStream server didn't reliably reject fast (sometimes a
  // prompt 503, sometimes the client's internal reconnect logic just kept
  // retrying). Skip deterministically in CI — never even attempt the real
  // connection there — and keep a hard timeout as a second, independent
  // guard for any other environment where JetStream is unexpectedly
  // unavailable, so this can never block a pipeline again either way.
  let jetstreamAvailable = !process.env.CI

  beforeAll(async () => {
    if (!jetstreamAvailable) return
    client = new MesaNatsClient()
    try {
      await withTimeout(client.connect(process.env.NATS_URL ?? 'nats://localhost:4223'), 8000, 'MesaNatsClient.connect')
    } catch (err) {
      jetstreamAvailable = false
      console.warn(`Skipping MesaNatsClient.getDlqDepth tests — JetStream unavailable: ${err instanceof Error ? err.message : String(err)}`)
      await client.close().catch(() => {})
    }
  })

  afterAll(async () => {
    if (jetstreamAvailable) await client.close()
  })

  it('reflects real DLQ backlog growth — the 5-day silent-loss regression', async () => {
    if (!jetstreamAvailable) return
    // Real incident: 49 customer WhatsApp messages piled up in the DLQ over
    // 5 days with zero alerting, only discovered by manually connecting to
    // JetStream. This proves the monitoring method actually sees what's
    // really in the stream, not a mocked stand-in for it.
    const before = await client.getDlqDepth()

    const probeSubject = `mesa.dlq.mesa.test.probe.${Date.now()}.${Math.random().toString(36).slice(2)}`
    await client.publish({ subject: probeSubject, hello: 'world' } as never)
    await client.publish({ subject: probeSubject, hello: 'again' } as never)

    // JetStream ack of the publish confirms durability; consumer info can
    // lag by a beat on some setups, so poll briefly rather than assume
    // instant consistency.
    let after = before
    for (let attempt = 0; attempt < 20; attempt++) {
      after = await client.getDlqDepth()
      if (after >= before + 2) break
      await new Promise(resolve => setTimeout(resolve, 100))
    }

    expect(after).toBe(before + 2)
  })
})
