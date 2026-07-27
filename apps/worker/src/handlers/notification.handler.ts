import { createHash } from 'crypto'
import type { Db } from '@mesa/db'
import { merchants, merchantChannels, platformInstagramAccount, notificationFailures, conversations } from '@mesa/db'
import { notificationFailures as notificationFailuresMetric } from '../metrics'
import { and, eq } from 'drizzle-orm'
import { NotificationSendEvent } from '@mesa/types'
import { send } from '@mesa/messaging'
import { sendTemplate, sendText, uploadMedia, sendImage, renderTemplateFallback, type WhatsAppTemplateOptions } from '@mesa/whatsapp'
import type { Redis } from 'ioredis'

function normalizeNigerianPhone(p: string): string {
  const digits = p.replace(/\D/g, '')
  const local = digits.startsWith('234') ? digits.slice(3) : digits.replace(/^0/, '')
  return `+234${local}`
}

// Meta enforces a 24h reply window from the user's last inbound Instagram
// DM — sending outside it fails outright. `lastMessageAt` only reflects
// customer activity for Instagram conversations (the WhatsApp-echo vendor
// path that would otherwise pollute it is gated to `channel === 'whatsapp'`
// in message.handler.ts), so it's safe to check directly.
const INSTAGRAM_MESSAGING_WINDOW_MS = 24 * 60 * 60 * 1000

export class NotificationHandler {
  constructor(
    private db: Db,
    private log: Pick<Console, 'info' | 'warn' | 'error'> = console,
    private redis?: Redis,
  ) {}

  async handle(event: NotificationSendEvent): Promise<void> {
    const dedupeKey = await this.acquireDedupe(event)
    if (dedupeKey === null && this.redis) return
    try {
      await this.deliver(event)
    } catch (err) {
      if (dedupeKey) await this.redis?.del(dedupeKey)
      // Persist the failure so it's discoverable from the dashboard, then
      // re-throw so NATS NAKs and retries. Sentry (via worker's unhandled
      // rejection handler) picks up the throw for alerting.
      notificationFailuresMetric.add(1, { channel: event.channel })
      await this.db.insert(notificationFailures).values({
        merchantId: event.merchantId,
        channel: event.channel,
        recipient: event.to,
        message: event.template ? `[template:${event.template.name}] ${event.message}`.slice(0, 1000) : event.message,
        errorMessage: (err instanceof Error ? err.message : String(err)).slice(0, 1000),
      }).catch(logErr => {
        this.log.error(JSON.stringify({
          level: 'error',
          msg: 'notification_failures insert failed',
          err: logErr instanceof Error ? logErr.message : String(logErr),
        }))
      })
      this.log.error(JSON.stringify({
        level: 'error',
        msg: 'Notification send failed',
        merchantId: event.merchantId,
        channel: event.channel,
        to: event.to,
        err: err instanceof Error ? err.message : String(err),
      }))
      throw err
    }
  }

  private async acquireDedupe(event: NotificationSendEvent): Promise<string | undefined | null> {
    if (!this.redis) return undefined
    const dedupeBody = JSON.stringify({
      merchantId: event.merchantId,
      channel: event.channel,
      to: event.channel === 'whatsapp' ? normalizeNigerianPhone(event.to) : event.to,
      message: event.message.trim(),
      template: event.template
        ? {
          name: event.template.name,
          languageCode: event.template.languageCode,
          bodyParams: event.template.bodyParams ?? [],
          buttons: event.template.buttons ?? [],
        }
        : undefined,
    })
    const key = `notification:dedupe:${createHash('sha256').update(dedupeBody).digest('hex')}`
    const acquired = await this.redis.set(key, '1', 'EX', 120, 'NX')
    if (acquired === 'OK') return key
    this.log.warn(JSON.stringify({
      level: 'warn',
      msg: 'Duplicate notification suppressed',
      merchantId: event.merchantId,
      channel: event.channel,
      to: event.to,
    }))
    return null
  }

  // A template can be missing on a freshly connected WABA while Meta review
  // completes (or if provisioning failed). Deliver the body as plain text
  // instead of dying — the reply keywords (ACCEPT/CONFIRM/BOOK RIDER...) are
  // part of the body, so the flow still works without buttons.
  private async sendTemplateOrFallback(
    to: string,
    template: NonNullable<NotificationSendEvent['template']>,
    options: WhatsAppTemplateOptions,
  ): Promise<void> {
    try {
      await sendTemplate(to, template.name, template.bodyParams ?? [], options)
    } catch (err) {
      const text = err instanceof Error ? err.message : String(err)
      if (/132001|does not exist|translation/i.test(text)) {
        const fallback = renderTemplateFallback(template.name, template.bodyParams ?? [])
        if (fallback) {
          this.log.warn(JSON.stringify({
            level: 'warn',
            msg: 'template_missing_fell_back_to_text',
            template: template.name,
            to,
          }))
          await sendText(to, fallback, {
            phoneNumberId: options.phoneNumberId,
            accessToken: options.accessToken,
          })
          return
        }
      }
      throw err
    }
  }

  private async deliver(event: NotificationSendEvent): Promise<void> {
    const { channel, to, message, merchantId } = event

    if (channel === 'instagram') {
      const igChannel = await this.db.query.merchantChannels.findFirst({
        where: and(
          eq(merchantChannels.merchantId, merchantId),
          eq(merchantChannels.channel, 'instagram'),
          eq(merchantChannels.status, 'connected'),
        ),
        columns: { channelAccountId: true, accessToken: true, merchantRecipientId: true, merchantLastMessageAt: true },
      })

      const isMerchantRecipient = igChannel?.merchantRecipientId != null && to === igChannel.merchantRecipientId

      // Merchant-facing notifications send FROM Mesa's own platform account
      // (mirrors the shared WhatsApp number), never from the merchant's own
      // shop account — that's the identity customers see, not what Mesa
      // should look like when it's messaging the merchant.
      const platformAccount = isMerchantRecipient
        ? await this.db.query.platformInstagramAccount.findFirst({
          columns: { accountId: true, accessToken: true },
        })
        : undefined

      const igUserId = isMerchantRecipient ? platformAccount?.accountId : igChannel?.channelAccountId
      const igAccessToken = isMerchantRecipient ? platformAccount?.accessToken : igChannel?.accessToken

      if (!igUserId || !igAccessToken) {
        throw new Error(`Instagram credentials not configured for merchant ${merchantId}`)
      }

      const lastMessageAt = isMerchantRecipient
        ? igChannel?.merchantLastMessageAt?.toISOString()
        : (await this.db.query.conversations.findFirst({
          where: and(
            eq(conversations.merchantId, merchantId),
            eq(conversations.channel, 'instagram'),
            eq(conversations.customerPhone, to),
          ),
          columns: { context: true },
        }).then(conv => (conv?.context as Record<string, unknown> | undefined)?.lastMessageAt as string | undefined))

      const withinWindow = lastMessageAt != null && Date.now() - new Date(lastMessageAt).getTime() < INSTAGRAM_MESSAGING_WINDOW_MS
      if (!withinWindow) {
        notificationFailuresMetric.add(1, { channel })
        await this.db.insert(notificationFailures).values({
          merchantId,
          channel,
          recipient: to,
          message: message.slice(0, 1000),
          errorMessage: isMerchantRecipient
            ? 'Instagram 24h messaging window has closed since the merchant\'s last message'
            : 'Instagram 24h messaging window has closed since the customer\'s last message',
        }).catch(() => { /* best-effort */ })
        this.log.warn(JSON.stringify({
          level: 'warn',
          msg: 'instagram_messaging_window_expired',
          merchantId,
          to,
          recipient: isMerchantRecipient ? 'merchant' : 'customer',
        }))
        return
      }

      await send('instagram', to, message, { igUserId, igAccessToken, mediaUrl: event.mediaUrl, quickReplies: event.quickReplies })
      return
    }

    // WhatsApp routing:
    //   - recipient is the merchant's own number → send from Mesa's shared
    //     bot number so the merchant always sees Mesa as the assistant.
    //   - recipient is anyone else (a customer) → send from the merchant's
    //     own WABA so the customer sees the merchant's brand. If the merchant
    //     hasn't completed embedded signup with stored creds, fall back to
    //     Mesa's shared number and log a warning.
    const merchant = await this.db.query.merchants.findFirst({
      where: eq(merchants.id, merchantId),
      columns: { phone: true },
    })

    const isMerchantBound =
      merchant && normalizeNigerianPhone(to) === normalizeNigerianPhone(merchant.phone)

    if (event.template) {
      // Template send — routing logic still applies for credentials selection.
      if (isMerchantBound) {
        // Send from Mesa's shared number; sendTemplate defaults to config creds.
        await this.sendTemplateOrFallback(to, event.template, {
          languageCode: event.template.languageCode ?? 'en',
          buttons: event.template.buttons,
        })
        return
      }

      const channelRow = await this.db.query.merchantChannels.findFirst({
        where: and(
          eq(merchantChannels.merchantId, merchantId),
          eq(merchantChannels.channel, 'whatsapp'),
          eq(merchantChannels.status, 'connected'),
        ),
      })

      const hasMerchantCreds =
        channelRow?.accessToken &&
        channelRow.channelAccountId &&
        !channelRow.channelAccountId.startsWith('pending_')

      if (hasMerchantCreds) {
        await this.sendTemplateOrFallback(to, event.template, {
          languageCode: event.template.languageCode ?? 'en',
          buttons: event.template.buttons,
          phoneNumberId: channelRow.channelAccountId,
          accessToken: channelRow.accessToken ?? undefined,
        })
        return
      }

      this.log.warn(JSON.stringify({
        level: 'warn',
        msg: 'Customer-facing WhatsApp template send falling back to Mesa shared number — merchant has no stored WABA credentials',
        merchantId,
        to,
        templateName: event.template.name,
      }))
      await this.sendTemplateOrFallback(to, event.template, {
        languageCode: event.template.languageCode ?? 'en',
        buttons: event.template.buttons,
      })
      return
    }

    // Image send (mediaUrl path — used for product status posts).
    if (event.mediaUrl) {
      try {
        const imgRes = await fetch(event.mediaUrl)
        if (imgRes.ok) {
          const buffer = Buffer.from(await imgRes.arrayBuffer())
          const mimeType = imgRes.headers.get('content-type') ?? 'image/jpeg'
          const creds = isMerchantBound ? undefined : await (async () => {
            const row = await this.db.query.merchantChannels.findFirst({
              where: and(
                eq(merchantChannels.merchantId, merchantId),
                eq(merchantChannels.channel, 'whatsapp'),
                eq(merchantChannels.status, 'connected'),
              ),
            })
            if (!row?.accessToken || !row.channelAccountId || row.channelAccountId.startsWith('pending_')) return undefined
            return { phoneNumberId: row.channelAccountId, accessToken: row.accessToken ?? undefined }
          })()
          const mediaId = await uploadMedia(buffer, mimeType, creds)
          await sendImage(to, mediaId, message || undefined, creds)
          return
        }
      } catch (err) {
        this.log.warn(JSON.stringify({ level: 'warn', msg: 'mediaUrl image send failed, falling back to text', merchantId, to, err: String(err) }))
      }
    }

    // Plain text send.
    if (isMerchantBound) {
      await send('whatsapp', to, message)
      return
    }

    const channelRow = await this.db.query.merchantChannels.findFirst({
      where: and(
        eq(merchantChannels.merchantId, merchantId),
        eq(merchantChannels.channel, 'whatsapp'),
        eq(merchantChannels.status, 'connected'),
      ),
    })

    const hasMerchantCreds =
      channelRow?.accessToken &&
      channelRow.channelAccountId &&
      !channelRow.channelAccountId.startsWith('pending_')

    if (hasMerchantCreds) {
      await send('whatsapp', to, message, {
        whatsappPhoneNumberId: channelRow.channelAccountId,
        whatsappAccessToken: channelRow.accessToken ?? undefined,
      })
      return
    }

    this.log.warn(JSON.stringify({
      level: 'warn',
      msg: 'Customer-facing WhatsApp send falling back to Mesa shared number — merchant has no stored WABA credentials',
      merchantId,
      to,
    }))
    await send('whatsapp', to, message)
  }
}
