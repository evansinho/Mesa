import type { Db } from '@mesa/db'
import { merchants, merchantChannels, notificationFailures } from '@mesa/db'
import { and, eq } from 'drizzle-orm'
import { NotificationSendEvent } from '@mesa/types'
import { send } from '@mesa/messaging'

function normalizeNigerianPhone(p: string): string {
  const digits = p.replace(/\D/g, '')
  const local = digits.startsWith('234') ? digits.slice(3) : digits.replace(/^0/, '')
  return `+234${local}`
}

export class NotificationHandler {
  constructor(
    private db: Db,
    private log: Pick<Console, 'info' | 'warn' | 'error'> = console,
  ) {}

  async handle(event: NotificationSendEvent): Promise<void> {
    try {
      await this.deliver(event)
    } catch (err) {
      // Persist the failure so it's discoverable from the dashboard, then
      // re-throw so NATS NAKs and retries. Sentry (via worker's unhandled
      // rejection handler) picks up the throw for alerting.
      await this.db.insert(notificationFailures).values({
        merchantId: event.merchantId,
        channel: event.channel,
        recipient: event.to,
        message: event.message,
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
