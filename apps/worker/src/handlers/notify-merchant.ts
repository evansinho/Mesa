import type { Db } from '@mesa/db'
import { merchants, merchantChannels } from '@mesa/db'
import { and, eq } from 'drizzle-orm'
import type { MesaNatsClient } from '@mesa/nats'
import { NotificationSendEvent, SUBJECTS, type WhatsAppTemplateButton } from '@mesa/types'
import { renderInstagramNotification } from '@mesa/whatsapp'

export interface MerchantDecisionTemplate {
  name: string
  languageCode?: string
  bodyParams: string[]
  buttons?: WhatsAppTemplateButton[]
}

// Sends a merchant decision prompt (new order / payment review / payment
// confirmed) on whichever channel the underlying order came from — an order
// placed via Instagram notifies the merchant on Instagram, WhatsApp on
// WhatsApp, independent of each other per product direction. Instagram has
// no template system, so it gets the same body copy as plain text ending in
// the dashboard action link instead of quick-reply buttons.
export async function notifyMerchantOnSourceChannel(
  db: Db,
  nats: MesaNatsClient,
  params: {
    merchantId: string
    sourceChannel: string
    template: MerchantDecisionTemplate
    actionUrl: string
  },
  log: Pick<Console, 'warn'> = console,
): Promise<void> {
  const { merchantId, sourceChannel, template, actionUrl } = params

  if (sourceChannel === 'instagram') {
    const igChannel = await db.query.merchantChannels.findFirst({
      where: and(
        eq(merchantChannels.merchantId, merchantId),
        eq(merchantChannels.channel, 'instagram'),
        eq(merchantChannels.status, 'connected'),
      ),
      columns: { merchantRecipientId: true },
    })
    if (igChannel?.merchantRecipientId) {
      const text = renderInstagramNotification(template.name, template.bodyParams, actionUrl)
      if (text) {
        await nats.publish({
          subject: SUBJECTS.NOTIFICATION_SEND,
          merchantId,
          to: igChannel.merchantRecipientId,
          channel: 'instagram',
          message: text,
        } satisfies NotificationSendEvent)
        return
      }
    }
    // Merchant hasn't completed the one-tap Instagram activation yet (or the
    // template has no known plain-text rendering) — fall back to WhatsApp
    // rather than silently dropping a time-sensitive decision prompt.
    log.warn(JSON.stringify({
      level: 'warn',
      msg: 'merchant_instagram_inbox_not_activated_falling_back_to_whatsapp',
      merchantId,
      templateName: template.name,
    }))
  }

  const merchant = await db.query.merchants.findFirst({
    where: eq(merchants.id, merchantId),
    columns: { phone: true },
  })
  if (!merchant) return

  await nats.publish({
    subject: SUBJECTS.NOTIFICATION_SEND,
    merchantId,
    to: merchant.phone,
    channel: 'whatsapp',
    message: '',
    template,
  } satisfies NotificationSendEvent)
}
