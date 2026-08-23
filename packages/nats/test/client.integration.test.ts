import { MesaNatsClient } from '../src/client'

describe('MesaNatsClient.getDlqDepth', () => {
  let client: MesaNatsClient
  // CI's NATS service container can't be started with JetStream enabled
  // (GitHub Actions service containers don't accept the `-js` arg the way
  // local `docker compose` does — see ci.yml). Every other integration test
  // in this repo avoids the real client for exactly this reason. This is
  // the first to use a real one, so it has to detect and skip rather than
  // false-fail somewhere CI structurally can't run it — local dev (and any
  // environment with real JetStream) still gets full, real verification.
  let jetstreamAvailable = true

  beforeAll(async () => {
    client = new MesaNatsClient()
    try {
      await client.connect(process.env.NATS_URL ?? 'nats://localhost:4223')
    } catch (err) {
      jetstreamAvailable = false
      console.warn(`Skipping MesaNatsClient.getDlqDepth tests — JetStream unavailable: ${err instanceof Error ? err.message : String(err)}`)
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
