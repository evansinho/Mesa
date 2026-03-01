import { sendText } from '@mesa/whatsapp'

export type ChannelType = 'whatsapp' | 'instagram'

export interface SendOptions {
  /** Required for Instagram: the connected Facebook Page ID */
  pageId?: string
  /** Required for Instagram: the Page access token stored at connect time */
  pageAccessToken?: string
}

/**
 * Send an outbound message on the channel the customer used.
 *
 * WhatsApp: uses Mesa's shared phone number (config.WHATSAPP_PHONE_NUMBER_ID)
 * Instagram: uses the merchant's connected Facebook Page credentials
 */
export async function send(
  channel: ChannelType,
  to: string,
  body: string,
  opts?: SendOptions,
): Promise<void> {
  if (channel === 'whatsapp') {
    await sendText(to, body)
    return
  }

  if (channel === 'instagram') {
    const { pageId, pageAccessToken } = opts ?? {}
    if (!pageId || !pageAccessToken) {
      throw new Error(`Instagram send requires pageId and pageAccessToken (recipient: ${to})`)
    }
    await sendInstagramMessage(pageId, pageAccessToken, to, body)
    return
  }

  throw new Error(`Unsupported channel: ${channel as string}`)
}

async function sendInstagramMessage(
  pageId: string,
  pageAccessToken: string,
  recipientId: string,
  text: string,
): Promise<void> {
  const url = `https://graph.facebook.com/v20.0/${pageId}/messages`

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${pageAccessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      recipient: { id: recipientId },
      message: { text },
      messaging_type: 'RESPONSE',
    }),
  })

  if (!res.ok) {
    const responseText = await res.text()
    throw new Error(`Instagram send failed: ${res.status} ${responseText}`)
  }
}
