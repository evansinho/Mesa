import { sendText } from '@mesa/whatsapp'

export type ChannelType = 'whatsapp' | 'instagram'

export interface SendOptions {
  /** Instagram: the merchant's own Instagram-scoped user ID (Instagram API with Instagram Login). */
  igUserId?: string
  /** Instagram: the merchant's long-lived Instagram user access token. */
  igAccessToken?: string
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
 * Instagram: uses the merchant's own Instagram Login credentials directly
 * (Instagram API with Instagram Login — no Facebook Page involved).
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
    const { igUserId, igAccessToken, mediaUrl } = opts ?? {}
    if (!igUserId || !igAccessToken) {
      throw new Error(`Instagram send requires igUserId and igAccessToken (recipient: ${to})`)
    }
    // The Send API accepts text OR an attachment per call, never both — send
    // the image first, then a follow-up text message if there's a caption.
    if (mediaUrl) {
      await sendInstagramMedia(igUserId, igAccessToken, to, mediaUrl)
      if (!body) return
    }
    await sendInstagramMessage(igUserId, igAccessToken, to, body)
    return
  }

  throw new Error(`Unsupported channel: ${channel as string}`)
}

async function postInstagramMessage(
  igUserId: string,
  igAccessToken: string,
  recipientId: string,
  message: Record<string, unknown>,
): Promise<void> {
  const url = `https://graph.instagram.com/v21.0/${igUserId}/messages`

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${igAccessToken}`,
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
  igUserId: string,
  igAccessToken: string,
  recipientId: string,
  text: string,
): Promise<void> {
  await postInstagramMessage(igUserId, igAccessToken, recipientId, { text })
}

async function sendInstagramMedia(
  igUserId: string,
  igAccessToken: string,
  recipientId: string,
  mediaUrl: string,
): Promise<void> {
  await postInstagramMessage(igUserId, igAccessToken, recipientId, {
    attachment: { type: 'image', payload: { url: mediaUrl, is_reusable: true } },
  })
}
