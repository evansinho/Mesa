import { sendText } from '@mesa/whatsapp'

export type ChannelType = 'whatsapp' | 'instagram'

export interface SendOptions {
  /** Instagram: the connected Facebook Page ID */
  pageId?: string
  /** Instagram: the Page access token stored at connect time */
  pageAccessToken?: string
  /** WhatsApp: the merchant's WABA phone_number_id to send FROM. Omit to use Mesa's shared number. */
  whatsappPhoneNumberId?: string
  /** WhatsApp: the merchant's WABA system access token. Omit to use Mesa's shared token. */
  whatsappAccessToken?: string
  /** Instagram only: a directly-fetchable image URL to send as an attachment. */
  mediaUrl?: string
}

/**
 * Send an outbound message on the channel the customer used.
 *
 * WhatsApp: customer-facing messages should pass the merchant's WABA
 * creds so the customer sees the merchant's number; merchant-facing
 * messages should omit them so they come from Mesa's shared bot number.
 * Instagram: uses the merchant's connected Facebook Page credentials.
 */
export async function send(
  channel: ChannelType,
  to: string,
  body: string,
  opts?: SendOptions,
): Promise<void> {
  if (channel === 'whatsapp') {
    await sendText(to, body, {
      phoneNumberId: opts?.whatsappPhoneNumberId,
      accessToken: opts?.whatsappAccessToken,
    })
    return
  }

  if (channel === 'instagram') {
    const { pageId, pageAccessToken, mediaUrl } = opts ?? {}
    if (!pageId || !pageAccessToken) {
      throw new Error(`Instagram send requires pageId and pageAccessToken (recipient: ${to})`)
    }
    // The Send API accepts text OR an attachment per call, never both — send
    // the image first, then a follow-up text message if there's a caption.
    if (mediaUrl) {
      await sendInstagramMedia(pageId, pageAccessToken, to, mediaUrl)
      if (!body) return
    }
    await sendInstagramMessage(pageId, pageAccessToken, to, body)
    return
  }

  throw new Error(`Unsupported channel: ${channel as string}`)
}

async function postInstagramMessage(
  pageId: string,
  pageAccessToken: string,
  recipientId: string,
  message: Record<string, unknown>,
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
      message,
      messaging_type: 'RESPONSE',
    }),
  })

  if (!res.ok) {
    const responseText = await res.text()
    throw new Error(`Instagram send failed: ${res.status} ${responseText}`)
  }
}

async function sendInstagramMessage(
  pageId: string,
  pageAccessToken: string,
  recipientId: string,
  text: string,
): Promise<void> {
  await postInstagramMessage(pageId, pageAccessToken, recipientId, { text })
}

async function sendInstagramMedia(
  pageId: string,
  pageAccessToken: string,
  recipientId: string,
  mediaUrl: string,
): Promise<void> {
  await postInstagramMessage(pageId, pageAccessToken, recipientId, {
    attachment: { type: 'image', payload: { url: mediaUrl, is_reusable: true } },
  })
}
