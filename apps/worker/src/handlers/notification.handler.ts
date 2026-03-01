import type { MesaNatsClient } from '@mesa/nats'
import type { Db } from '@mesa/db'
import { merchants, merchantChannels } from '@mesa/db'
import { eq, and } from 'drizzle-orm'
import { NotificationSendEvent } from '@mesa/types'
import { send } from '@mesa/messaging'

export class NotificationHandler {
  constructor(
    private nats: MesaNatsClient,
    private db: Db,
  ) {}

  async handle(event: NotificationSendEvent): Promise<void> {
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

    const waChannel = await this.db.query.merchantChannels.findFirst({
      where: and(
        eq(merchantChannels.merchantId, merchantId),
        eq(merchantChannels.channel, 'whatsapp')
      ),
      columns: { d360ApiKey: true },
    })
    await send('whatsapp', to, message, { d360ApiKey: waChannel?.d360ApiKey ?? undefined })
  }
}
