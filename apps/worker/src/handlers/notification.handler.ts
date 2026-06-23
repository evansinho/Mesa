import { createHash } from 'crypto'
import type { Db } from '@mesa/db'
import { merchants, merchantChannels, notificationFailures } from '@mesa/db'
import { and, eq } from 'drizzle-orm'
import { NotificationSendEvent } from '@mesa/types'
import { send } from '@mesa/messaging'
import { sendTemplate, uploadMedia, sendImage } from '@mesa/whatsapp'
import type { Redis } from 'ioredis'

function normalizeNigerianPhone(p: string): string {
  const digits = p.replace(/\D/g, '')
  const local = digits.startsWith('234') ? digits.slice(3) : digits.replace(/^0/, '')
  return `+234${local}`
}

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

  private async deliver(event: NotificationSendEvent): Promise<void> {
    const { channel, to, message, merchantId } = event

    if (channel === 'instagram') {
      const merchant = await this.db.query.merchants.findFirst({
        where: eq(merchants.id, merchantId),
        columns: { config: true },
      })
      const cfg = (merchant?.config ?? {}) as Record<string, unknown>
      const pageId = cfg.instagramPageId as string | undefined
      const pageAccessToken = cfg.instagramPageAccessToken as string | undefined

      if (!pageId || !pageAccessToken) {
        throw new Error(`Instagram page credentials not configured for merchant ${merchantId}`)
      }

      await send('instagram', to, message, { pageId, pageAccessToken })
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
        await sendTemplate(
          to,
          event.template.name,
          event.template.bodyParams ?? [],
          {
            languageCode: event.template.languageCode ?? 'en',
            buttons: event.template.buttons,
          },
        )
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
        await sendTemplate(
          to,
          event.template.name,
          event.template.bodyParams ?? [],
          {
            languageCode: event.template.languageCode ?? 'en',
            buttons: event.template.buttons,
            phoneNumberId: channelRow.channelAccountId,
            accessToken: channelRow.accessToken ?? undefined,
          },
        )
        return
      }

      this.log.warn(JSON.stringify({
        level: 'warn',
        msg: 'Customer-facing WhatsApp template send falling back to Mesa shared number — merchant has no stored WABA credentials',
        merchantId,
        to,
        templateName: event.template.name,
      }))
      await sendTemplate(
        to,
        event.template.name,
        event.template.bodyParams ?? [],
        {
          languageCode: event.template.languageCode ?? 'en',
          buttons: event.template.buttons,
        },
      )
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
