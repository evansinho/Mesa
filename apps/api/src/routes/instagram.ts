import type { FastifyInstance } from 'fastify'
import type { Db } from '@mesa/db'
import { merchants, merchantChannels } from '@mesa/db'
import { eq } from 'drizzle-orm'
import { config } from '@mesa/config'

type InstagramConnectPayload = {
  merchantId: string
  code?: string
  redirectUri?: string
  instagramAccountId?: string
}

type PageInfo = {
  id: string
  access_token: string
  instagram_business_account?: { id: string; username?: string }
}

async function exchangeCodeForToken(code: string, redirectUri: string) {
  const metaAppId = config.META_APP_ID ?? process.env.META_APP_ID
  const metaSecret = config.META_APP_SECRET ?? process.env.META_APP_SECRET
  if (!metaAppId || !metaSecret) {
    throw new Error('META_APP_ID/META_APP_SECRET not configured')
  }

  const url = new URL('https://graph.facebook.com/v20.0/oauth/access_token')
  url.searchParams.set('client_id', metaAppId)
  url.searchParams.set('client_secret', metaSecret)
  url.searchParams.set('redirect_uri', redirectUri)
  url.searchParams.set('code', code)

  const res = await fetch(url.toString())
  if (!res.ok) {
    const text = await res.text()
    throw new Error(`Meta token exchange failed: ${text}`)
  }
  const data = await res.json() as { access_token?: string }
  if (!data.access_token) {
    throw new Error('Meta token exchange returned no access_token')
  }
  return data.access_token
}

async function fetchInstagramPageInfo(accessToken: string): Promise<{ instagramAccountId: string; pageId: string; pageAccessToken: string }> {
  const url = new URL('https://graph.facebook.com/v20.0/me/accounts')
  url.searchParams.set('fields', 'id,access_token,instagram_business_account{id,username}')
  url.searchParams.set('access_token', accessToken)

  const res = await fetch(url.toString())
  if (!res.ok) {
    const text = await res.text()
    throw new Error(`Meta accounts fetch failed: ${text}`)
  }

  const data = await res.json() as { data?: PageInfo[] }

  const page = data.data?.find(p => p.instagram_business_account?.id)
  if (!page?.instagram_business_account?.id) {
    throw new Error('No Instagram Business account found on this Meta user')
  }

  return {
    instagramAccountId: page.instagram_business_account.id,
    pageId: page.id,
    pageAccessToken: page.access_token,
  }
}

async function subscribePageToMessagesWebhook(pageId: string, pageAccessToken: string): Promise<void> {
  const url = new URL(`https://graph.facebook.com/v20.0/${pageId}/subscribed_apps`)
  url.searchParams.set('subscribed_fields', 'messages,messaging_postbacks')
  url.searchParams.set('access_token', pageAccessToken)

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

      const merchant = await db.query.merchants.findFirst({
        where: eq(merchants.id, merchantId),
      })
      if (!merchant) return reply.status(404).send({ error: 'Merchant not found' })

      let resolvedInstagramId = instagramAccountId
      let resolvedPageId: string | undefined
      let resolvedPageAccessToken: string | undefined

      if (!resolvedInstagramId) {
        if (!code) {
          return reply.status(400).send({ error: 'Missing code or instagramAccountId' })
        }
        const redirect = redirectUri || config.META_INSTAGRAM_REDIRECT_URI || config.META_REDIRECT_URI
        if (!redirect) {
          return reply.status(400).send({ error: 'Missing redirectUri' })
        }
        const accessToken = await exchangeCodeForToken(code, redirect)
        const pageInfo = await fetchInstagramPageInfo(accessToken)
        resolvedInstagramId = pageInfo.instagramAccountId
        resolvedPageId = pageInfo.pageId
        resolvedPageAccessToken = pageInfo.pageAccessToken
      }

      await db.insert(merchantChannels).values({
        merchantId,
        channel: 'instagram',
        channelAccountId: resolvedInstagramId,
        status: 'connected',
        connectedAt: new Date(),
      }).onConflictDoNothing()

      // Store page credentials in merchant config for outbound messaging
      if (resolvedPageId && resolvedPageAccessToken) {
        await db.update(merchants)
          .set({
            updatedAt: new Date(),
            config: {
              ...(merchant.config ?? {}),
              instagramPageId: resolvedPageId,
              instagramPageAccessToken: resolvedPageAccessToken,
            },
          })
          .where(eq(merchants.id, merchantId))

        // Subscribe page to messages webhook field
        try {
          await subscribePageToMessagesWebhook(resolvedPageId, resolvedPageAccessToken)
          app.log.info({ merchantId, pageId: resolvedPageId }, 'Instagram page subscribed to messages webhook')
        } catch (err) {
          // Non-fatal: channel is connected, webhook subscription can be retried
          app.log.warn({ err, merchantId, pageId: resolvedPageId }, 'Instagram webhook subscription failed — channel still connected')
        }
      }

      app.log.info({ merchantId, instagramAccountId: resolvedInstagramId, pageId: resolvedPageId }, 'Instagram connected')
      return reply.status(200).send({ ok: true, instagramAccountId: resolvedInstagramId })
    } catch (err) {
      app.log.error({ err }, 'Instagram connect failed')
      return reply.status(500).send({ error: 'Instagram connect failed' })
    }
  })
}
