import { config } from '@mesa/config'

interface WhatsAppSendTextResponse {
  messaging_product: string
  contacts?: Array<{ input: string; wa_id: string }>
  messages?: Array<{ id: string }>
}

function d360BaseUrl(): string {
  return config.D360_SANDBOX === 'true'
    ? 'https://waba-sandbox.360dialog.io'
    : 'https://waba.360dialog.io'
}

export async function sendText(to: string, body: string, apiKey?: string): Promise<WhatsAppSendTextResponse> {
  if (apiKey) {
    const url = `${d360BaseUrl()}/v1/messages`
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'D360-API-KEY': apiKey,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ to, type: 'text', text: { body } }),
    })
    if (!res.ok) {
      const text = await res.text()
      throw new Error(`360dialog sendText failed: ${res.status} ${text}`)
    }
    return res.json() as Promise<WhatsAppSendTextResponse>
  }

  const url = `https://graph.facebook.com/v20.0/${config.WHATSAPP_PHONE_NUMBER_ID}/messages`
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${config.WHATSAPP_ACCESS_TOKEN}`,
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

export async function downloadMedia(mediaId: string, apiKey?: string): Promise<{ buffer: Buffer; mimeType?: string }> {
  if (apiKey) {
    const url = `${d360BaseUrl()}/v1/media/${mediaId}`
    const res = await fetch(url, {
      headers: { 'D360-API-KEY': apiKey },
    })
    if (!res.ok) {
      const text = await res.text()
      throw new Error(`360dialog media download failed: ${res.status} ${text}`)
    }
    const mimeType = res.headers.get('content-type') ?? undefined
    const arrayBuffer = await res.arrayBuffer()
    return { buffer: Buffer.from(arrayBuffer), mimeType }
  }

  const metaUrl = `https://graph.facebook.com/v20.0/${mediaId}`
  const metaRes = await fetch(metaUrl, {
    headers: {
      Authorization: `Bearer ${config.WHATSAPP_ACCESS_TOKEN}`,
    },
  })

  if (!metaRes.ok) {
    const text = await metaRes.text()
    throw new Error(`WhatsApp media meta fetch failed: ${metaRes.status} ${text}`)
  }

  const meta = await metaRes.json() as { url: string; mime_type?: string }

  const mediaRes = await fetch(meta.url, {
    headers: {
      Authorization: `Bearer ${config.WHATSAPP_ACCESS_TOKEN}`,
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
  apiKey?: string
): Promise<WhatsAppSendTextResponse> {
  const components = params.length
    ? [{
        type: 'body',
        parameters: params.map(p => ({
          type: 'text',
          text: String(p),
        })),
      }]
    : []

  if (apiKey) {
    const url = `${d360BaseUrl()}/v1/messages`
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'D360-API-KEY': apiKey,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
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
      throw new Error(`360dialog sendTemplate failed: ${res.status} ${text}`)
    }
    return res.json() as Promise<WhatsAppSendTextResponse>
  }

  const url = `https://graph.facebook.com/v20.0/${config.WHATSAPP_PHONE_NUMBER_ID}/messages`
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${config.WHATSAPP_ACCESS_TOKEN}`,
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