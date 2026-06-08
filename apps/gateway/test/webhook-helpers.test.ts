import { createHmac } from 'crypto'
import {
  extractContactSync,
  extractHistoryMessages,
  getMessageCustomerId,
  isPayloadTimestampFresh,
  isVendorHistoryMessage,
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

describe('WhatsApp coexistence webhook helpers', () => {
  it('extracts history messages from direct, wrapped, and conversation payloads', () => {
    const direct = extractHistoryMessages({
      metadata: { display_phone_number: '+2348012345678', phone_number_id: 'pn_x' },
      messaging_product: 'whatsapp',
      messages: [{ id: 'direct', from: '2348099998888', timestamp: '1', type: 'text' }],
    })
    expect(direct.map(m => m.id)).toEqual(['direct'])

    const wrapped = extractHistoryMessages({
      metadata: { display_phone_number: '+2348012345678', phone_number_id: 'pn_x' },
      messaging_product: 'whatsapp',
      history: {
        conversations: [
          { messages: [{ id: 'nested', from: '2348099998888', timestamp: '2', type: 'text' }] },
        ],
      },
    })
    expect(wrapped.map(m => m.id)).toEqual(['nested'])
  })

  it('maps contact sync from smb_app_state_sync or contacts', () => {
    expect(extractContactSync({
      metadata: { display_phone_number: '+2348012345678', phone_number_id: 'pn_x' },
      messaging_product: 'whatsapp',
      smb_app_state_sync: {
        contacts: [{ wa_id: '2348099998888', profile: { name: 'Ada' } }],
      },
    })).toHaveLength(1)

    expect(extractContactSync({
      metadata: { display_phone_number: '+2348012345678', phone_number_id: 'pn_x' },
      messaging_product: 'whatsapp',
      contacts: [{ wa_id: '2348077776666' }],
    })).toHaveLength(1)
  })

  it('identifies customer ids and vendor history messages', () => {
    expect(getMessageCustomerId({ id: '1', to: '2348099998888', timestamp: '1', type: 'text' }, 'vendor'))
      .toBe('2348099998888')
    expect(getMessageCustomerId({ id: '2', from: '2348099998888', timestamp: '1', type: 'text' }, 'customer'))
      .toBe('2348099998888')
    expect(isVendorHistoryMessage({ id: '3', from: '2348012345678', timestamp: '1', type: 'text' }, '+2348012345678'))
      .toBe(true)
    expect(isVendorHistoryMessage({ id: '4', direction: 'inbound', from: '2348099998888', timestamp: '1', type: 'text' }, '+2348012345678'))
      .toBe(false)
  })
})
