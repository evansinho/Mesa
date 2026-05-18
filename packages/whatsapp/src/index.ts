import { config } from '@mesa/config'

interface WhatsAppSendTextResponse {
  messaging_product: string
  contacts?: Array<{ input: string; wa_id: string }>
  messages?: Array<{ id: string }>
}

export interface WhatsAppCredentials {
  // Meta's internal id for the WABA phone number to send FROM.
  phoneNumberId?: string
  // System access token from embedded signup. When omitted, falls back to
  // Mesa's shared bot credentials (config.WHATSAPP_*).
  accessToken?: string
}

export async function sendText(
  to: string,
  body: string,
  creds?: WhatsAppCredentials,
): Promise<WhatsAppSendTextResponse> {
  const phoneNumberId = creds?.phoneNumberId ?? config.WHATSAPP_PHONE_NUMBER_ID
  const accessToken = creds?.accessToken ?? config.WHATSAPP_ACCESS_TOKEN
  const url = `https://graph.facebook.com/v20.0/${phoneNumberId}/messages`

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      messaging_product: 'whatsapp',
      to,
      type: 'text',
      text: { body },
    }),
  })

  if (!res.ok) {
    const text = await res.text()
    throw new Error(`WhatsApp sendText failed: ${res.status} ${text}`)
  }

  return res.json() as Promise<WhatsAppSendTextResponse>
}

export async function downloadMedia(mediaId: string, accessToken?: string): Promise<{ buffer: Buffer; mimeType?: string }> {
  const token = accessToken ?? config.WHATSAPP_ACCESS_TOKEN
  const metaUrl = `https://graph.facebook.com/v20.0/${mediaId}`
  const metaRes = await fetch(metaUrl, {
    headers: {
      Authorization: `Bearer ${token}`,
    },
  })

  if (!metaRes.ok) {
    const text = await metaRes.text()
    throw new Error(`WhatsApp media meta fetch failed: ${metaRes.status} ${text}`)
  }

  const meta = await metaRes.json() as { url: string; mime_type?: string }

  const mediaRes = await fetch(meta.url, {
    headers: {
      Authorization: `Bearer ${token}`,
    },
  })

  if (!mediaRes.ok) {
    const text = await mediaRes.text()
    throw new Error(`WhatsApp media download failed: ${mediaRes.status} ${text}`)
  }

  const arrayBuffer = await mediaRes.arrayBuffer()
  return {
    buffer: Buffer.from(arrayBuffer),
    mimeType: meta.mime_type,
  }
}

export async function sendTemplate(
  to: string,
  templateName: string,
  params: Array<string | number>,
  creds?: WhatsAppCredentials,
): Promise<WhatsAppSendTextResponse> {
  const phoneNumberId = creds?.phoneNumberId ?? config.WHATSAPP_PHONE_NUMBER_ID
  const accessToken = creds?.accessToken ?? config.WHATSAPP_ACCESS_TOKEN
  const url = `https://graph.facebook.com/v20.0/${phoneNumberId}/messages`

  const components = params.length
    ? [{
        type: 'body',
        parameters: params.map(p => ({
          type: 'text',
          text: String(p),
        })),
      }]
    : []

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      messaging_product: 'whatsapp',
      to,
      type: 'template',
      template: {
        name: templateName,
        language: { code: 'en_US' },
        components,
      },
    }),
  })

  if (!res.ok) {
    const text = await res.text()
    throw new Error(`WhatsApp sendTemplate failed: ${res.status} ${text}`)
  }

  return res.json() as Promise<WhatsAppSendTextResponse>
}
