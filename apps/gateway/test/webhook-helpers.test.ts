import { createHmac } from 'crypto'
import {
  isPayloadTimestampFresh,
  verifyWebhookSignature,
} from '../src/routes/webhook'

describe('isPayloadTimestampFresh (F-9)', () => {
  const NOW = 1_700_000_000_000 // fixed reference point

  it('accepts a timestamp at the current instant', () => {
    expect(isPayloadTimestampFresh(NOW, NOW)).toBe(true)
  })

  it('accepts a timestamp 4 minutes in the past', () => {
    expect(isPayloadTimestampFresh(NOW - 4 * 60_000, NOW)).toBe(true)
  })

  it('accepts a timestamp 4 minutes in the future (clock skew tolerance)', () => {
    expect(isPayloadTimestampFresh(NOW + 4 * 60_000, NOW)).toBe(true)
  })

  it('rejects a timestamp more than 5 minutes in the past — F-9 regression', () => {
    expect(isPayloadTimestampFresh(NOW - 6 * 60_000, NOW)).toBe(false)
  })

  it('rejects a timestamp more than 5 minutes in the future — F-9 regression', () => {
    expect(isPayloadTimestampFresh(NOW + 6 * 60_000, NOW)).toBe(false)
  })

  it('rejects undefined', () => {
    expect(isPayloadTimestampFresh(undefined, NOW)).toBe(false)
  })

  it('rejects NaN / infinity', () => {
    expect(isPayloadTimestampFresh(NaN, NOW)).toBe(false)
    expect(isPayloadTimestampFresh(Infinity, NOW)).toBe(false)
  })
})

describe('verifyWebhookSignature', () => {
  const secret = process.env.WHATSAPP_APP_SECRET || 'test-app-secret'

  function sign(body: string): string {
    return 'sha256=' + createHmac('sha256', secret).update(body).digest('hex')
  }

  it('accepts a signature computed with the configured secret', () => {
    const body = '{"hello":"world"}'
    expect(verifyWebhookSignature(body, sign(body))).toBe(true)
  })

  it('rejects when the body has been tampered with', () => {
    const body = '{"hello":"world"}'
    const signature = sign(body)
    expect(verifyWebhookSignature('{"hello":"tampered"}', signature)).toBe(false)
  })

  it('rejects a malformed signature header', () => {
    expect(verifyWebhookSignature('{}', 'not-a-signature')).toBe(false)
  })

  it('uses constant-time comparison (length mismatch returns false without throwing)', () => {
    expect(verifyWebhookSignature('{}', 'sha256=tooshort')).toBe(false)
  })
})