import type { FastifyInstance } from 'fastify'
import type { Db } from '@mesa/db'
import { merchants, merchantChannels } from '@mesa/db'
import { eq, and } from 'drizzle-orm'
import { config } from '@mesa/config'

function d360HubBaseUrl(): string {
  return 'https://hub.360dialog.io'
}

async function exchange360dialogApiKey(clientId: string, channelId: string): Promise<string> {
  const partnerId = config.D360_PARTNER_ID
  const partnerToken = config.D360_PARTNER_TOKEN
  if (!partnerId || !partnerToken) {
    throw new Error('D360_PARTNER_ID/D360_PARTNER_TOKEN not configured')
  }

  const url = `${d360HubBaseUrl()}/api/v2/partners/${partnerId}/channels/${channelId}/api-keys`
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${partnerToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ client_id: clientId }),
  })

  if (!res.ok) {
    const text = await res.text()
    throw new Error(`360dialog API key exchange failed: ${res.status} ${text}`)
  }

  const data = await res.json() as { api_key?: string }
  if (!data.api_key) {
    throw new Error('360dialog API key exchange returned no api_key')
  }
  return data.api_key
}

type D360CallbackPayload = {
  merchantId: string
  clientId: string
  channelId: string
}

type BspSetupPayload = {
  merchantId: string
  channelId: string
  apiKey: string
}

export async function whatsappRoutes(app: FastifyInstance) {
  const db = (app as FastifyInstance & { db: Db }).db

  // 360dialog OAuth callback — exchanges clientId + channelId for per-merchant API key
  app.post<{ Body: D360CallbackPayload }>('/d360/callback', {
    config: { rateLimit: { max: 30, timeWindow: '1 minute' } },
  }, async (req, reply) => {
    try {
      const { merchantId, clientId, channelId } = req.body

      const merchant = await db.query.merchants.findFirst({
        where: eq(merchants.id, merchantId),
      })
      if (!merchant) return reply.status(404).send({ error: 'Merchant not found' })

      const apiKey = await exchange360dialogApiKey(clientId, channelId)

      const existing = await db.query.merchantChannels.findFirst({
        where: and(
          eq(merchantChannels.merchantId, merchantId),
          eq(merchantChannels.channel, 'whatsapp')
        ),
      })

      if (existing) {
        await db.update(merchantChannels)
          .set({ d360ApiKey: apiKey, channelAccountId: channelId, status: 'connected', connectedAt: new Date() })
          .where(eq(merchantChannels.id, existing.id))
      } else {
        await db.insert(merchantChannels).values({
          merchantId,
          channel: 'whatsapp',
          channelAccountId: channelId,
          d360ApiKey: apiKey,
          status: 'connected',
          connectedAt: new Date(),
        })
      }

      // Kick off onboarding if not already started
      const cfg = (merchant.config ?? {}) as Record<string, unknown>
      const onboarding = (cfg.onboarding ?? {}) as Record<string, unknown>
      if (!onboarding.step) {
        await db.update(merchants).set({
          updatedAt: new Date(),
          config: {
            ...cfg,
            onboarding: { status: 'incomplete', step: 'BUSINESS_NAME' },
          },
        }).where(eq(merchants.id, merchantId))
      }

      app.log.info({ merchantId, channelId }, '360dialog WhatsApp channel connected')
      return reply.status(200).send({ ok: true, channelId })
    } catch (err) {
      app.log.error({ err }, '360dialog callback failed')
      return reply.status(500).send({ error: 'WhatsApp connection failed' })
    }
  })

  // Manual BSP setup (dev/test — supply API key directly without OAuth)
  app.post<{ Body: BspSetupPayload }>('/bsp-setup', {
    config: { rateLimit: { max: 10, timeWindow: '1 minute' } },
  }, async (req, reply) => {
    try {
      const { merchantId, channelId, apiKey } = req.body

      const merchant = await db.query.merchants.findFirst({
        where: eq(merchants.id, merchantId),
      })
      if (!merchant) return reply.status(404).send({ error: 'Merchant not found' })

      const existing = await db.query.merchantChannels.findFirst({
        where: and(
          eq(merchantChannels.merchantId, merchantId),
          eq(merchantChannels.channel, 'whatsapp')
        ),
      })

      if (existing) {
        await db.update(merchantChannels)
          .set({ d360ApiKey: apiKey, channelAccountId: channelId, status: 'connected', connectedAt: new Date() })
          .where(eq(merchantChannels.id, existing.id))
      } else {
        await db.insert(merchantChannels).values({
          merchantId,
          channel: 'whatsapp',
          channelAccountId: channelId,
          d360ApiKey: apiKey,
          status: 'connected',
          connectedAt: new Date(),
        })
      }

      app.log.info({ merchantId, channelId }, 'BSP WhatsApp channel set up manually')
      return reply.status(200).send({ ok: true })
    } catch (err) {
      app.log.error({ err }, 'BSP setup failed')
      return reply.status(500).send({ error: 'BSP setup failed' })
    }
  })
}