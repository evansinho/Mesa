import type { FastifyInstance } from 'fastify'
import type { Db } from '@mesa/db'
import { merchants, merchantChannels } from '@mesa/db'
import { and, eq } from 'drizzle-orm'
import { config } from '@mesa/config'
import { authorizeMerchant } from '../auth-context'

type InstagramConnectPayload = {
  merchantId: string
  code?: string
  redirectUri?: string
  instagramAccountId?: string
}

// Instagram API with Instagram Login — the merchant logs in directly with
// their Instagram professional account, no Facebook Page involved. This
// uses a distinct companion "Instagram app" ID/secret from Mesa's main Meta
// app (which still handles WhatsApp), never conflate the two.
async function exchangeCodeForShortLivedToken(code: string, redirectUri: string): Promise<{ accessToken: string; userId: string }> {
  const igAppId = config.INSTAGRAM_APP_ID ?? process.env.INSTAGRAM_APP_ID
  const igAppSecret = config.INSTAGRAM_APP_SECRET ?? process.env.INSTAGRAM_APP_SECRET
  if (!igAppId || !igAppSecret) {
    throw new Error('INSTAGRAM_APP_ID/INSTAGRAM_APP_SECRET not configured')
  }

  const body = new URLSearchParams({
    client_id: igAppId,
    client_secret: igAppSecret,
    grant_type: 'authorization_code',
    redirect_uri: redirectUri,
    code,
  })

  const res = await fetch('https://api.instagram.com/oauth/access_token', {
    method: 'POST',
    body,
  })
  if (!res.ok) {
    const text = await res.text()
    throw new Error(`Instagram token exchange failed: ${text}`)
  }
  const data = await res.json() as { access_token?: string; user_id?: string | number }
  if (!data.access_token || data.user_id == null) {
    throw new Error('Instagram token exchange returned no access_token/user_id')
  }
  return { accessToken: data.access_token, userId: String(data.user_id) }
}

// Short-lived tokens (1h) must be exchanged for a long-lived token (60d)
// before they're usable beyond the initial connect — see the refresh cron
// in apps/worker/src/index.ts for keeping this alive past 60 days.
async function exchangeForLongLivedToken(shortLivedToken: string): Promise<string> {
  const igAppSecret = config.INSTAGRAM_APP_SECRET ?? process.env.INSTAGRAM_APP_SECRET
  if (!igAppSecret) {
    throw new Error('INSTAGRAM_APP_SECRET not configured')
  }

  const url = new URL('https://graph.instagram.com/access_token')
  url.searchParams.set('grant_type', 'ig_exchange_token')
  url.searchParams.set('client_secret', igAppSecret)
  url.searchParams.set('access_token', shortLivedToken)

  const res = await fetch(url.toString())
  if (!res.ok) {
    const text = await res.text()
    throw new Error(`Instagram long-lived token exchange failed: ${text}`)
  }
  const data = await res.json() as { access_token?: string }
  if (!data.access_token) {
    throw new Error('Instagram long-lived token exchange returned no access_token')
  }
  return data.access_token
}

// The token exchange only returns user_id, not username — needed separately
// for the ig.me/m/{username} verification deep link (4a).
async function fetchInstagramUsername(accessToken: string): Promise<string | undefined> {
  const url = new URL('https://graph.instagram.com/v21.0/me')
  url.searchParams.set('fields', 'user_id,username')
  url.searchParams.set('access_token', accessToken)

  const res = await fetch(url.toString())
  if (!res.ok) return undefined
  const data = await res.json() as { username?: string }
  return data.username
}

async function subscribeToMessagesWebhook(accessToken: string): Promise<void> {
  const url = new URL('https://graph.instagram.com/v21.0/me/subscribed_apps')
  url.searchParams.set('subscribed_fields', 'messages,messaging_postbacks')
  url.searchParams.set('access_token', accessToken)

  const res = await fetch(url.toString(), { method: 'POST' })
  if (!res.ok) {
    const text = await res.text()
    throw new Error(`Instagram webhook subscription failed: ${text}`)
  }
}

export async function instagramRoutes(app: FastifyInstance) {
  const db = (app as FastifyInstance & { db: Db }).db

  app.post<{ Body: InstagramConnectPayload }>('/embedded-signup', {
    config: { rateLimit: { max: 30, timeWindow: '1 minute' } },
  }, async (req, reply) => {
    try {
      const { merchantId, code, redirectUri, instagramAccountId } = req.body
      const auth = authorizeMerchant(req, reply, merchantId)
      if (!auth.ok) return
      const authorizedMerchantId = auth.merchantId!

      const merchant = await db.query.merchants.findFirst({
        where: eq(merchants.id, authorizedMerchantId),
      })
      if (!merchant) return reply.status(404).send({ error: 'Merchant not found' })

      let resolvedInstagramId = instagramAccountId
      let resolvedUsername: string | undefined
      let resolvedAccessToken: string | undefined

      if (!resolvedInstagramId) {
        if (!code) {
          return reply.status(400).send({ error: 'Missing code or instagramAccountId' })
        }
        const redirect = redirectUri || config.META_INSTAGRAM_REDIRECT_URI || config.META_REDIRECT_URI
        if (!redirect) {
          return reply.status(400).send({ error: 'Missing redirectUri' })
        }
        const { accessToken: shortLivedToken, userId } = await exchangeCodeForShortLivedToken(code, redirect)
        resolvedAccessToken = await exchangeForLongLivedToken(shortLivedToken)
        resolvedInstagramId = userId
        resolvedUsername = await fetchInstagramUsername(resolvedAccessToken)
      }

      // Credentials live on merchantChannels (matching WhatsApp's pattern).
      // merchantRecipientId is deliberately never touched here: once
      // captured (via the ig.me verification DM, see the gateway's
      // referral-ref handling) it must survive a reconnect.
      const [channelRow] = await db.insert(merchantChannels)
        .values({
          merchantId: authorizedMerchantId,
          channel: 'instagram',
          channelAccountId: resolvedInstagramId,
          status: 'connected',
          connectedAt: new Date(),
          ...(resolvedAccessToken ? { accessToken: resolvedAccessToken, tokenRefreshedAt: new Date() } : {}),
        })
        .onConflictDoUpdate({
          target: [merchantChannels.channel, merchantChannels.channelAccountId],
          set: {
            status: 'connected',
            connectedAt: new Date(),
            ...(resolvedAccessToken ? { accessToken: resolvedAccessToken, tokenRefreshedAt: new Date() } : {}),
          },
        })
        .returning({ id: merchantChannels.id, merchantRecipientId: merchantChannels.merchantRecipientId })

      if (resolvedAccessToken) {
        try {
          await subscribeToMessagesWebhook(resolvedAccessToken)
          app.log.info({ merchantId: authorizedMerchantId, instagramAccountId: resolvedInstagramId }, 'Instagram account subscribed to messages webhook')
        } catch (err) {
          // Non-fatal: channel is connected, webhook subscription can be retried
          app.log.warn({ err, merchantId: authorizedMerchantId, instagramAccountId: resolvedInstagramId }, 'Instagram webhook subscription failed — channel still connected')
        }
      }

      // One-time activation link: Meta only creates a usable recipient ID
      // (IGSID) for a person once they've DM'd the business account — OAuth
      // alone can't provide one. Omitted once already captured, or on a
      // reconnect where the merchant already verified before.
      const verificationUrl = !channelRow.merchantRecipientId && resolvedUsername
        ? `https://ig.me/m/${resolvedUsername}?ref=${channelRow.id}`
        : undefined

      app.log.info({ merchantId: authorizedMerchantId, instagramAccountId: resolvedInstagramId }, 'Instagram connected')
      return reply.status(200).send({ ok: true, instagramAccountId: resolvedInstagramId, verificationUrl })
    } catch (err) {
      app.log.error({ err }, 'Instagram connect failed')
      return reply.status(500).send({ error: 'Instagram connect failed' })
    }
  })

  app.post<{ Body: { merchantId: string } }>('/disconnect', {
    config: { rateLimit: { max: 30, timeWindow: '1 minute' } },
  }, async (req, reply) => {
    const { merchantId } = req.body
    const auth = authorizeMerchant(req, reply, merchantId)
    if (!auth.ok) return
    const authorizedMerchantId = auth.merchantId!

    await db.update(merchantChannels)
      .set({ status: 'disconnected' })
      .where(and(
        eq(merchantChannels.merchantId, authorizedMerchantId),
        eq(merchantChannels.channel, 'instagram'),
      ))

    return reply.status(200).send({ ok: true })
  })
}
