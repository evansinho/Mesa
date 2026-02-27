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

async function fetchInstagramAccountId(accessToken: string) {
  const url = new URL('https://graph.facebook.com/v20.0/me/accounts')
  url.searchParams.set('fields', 'instagram_business_account{id,username}')
  url.searchParams.set('access_token', accessToken)

  const res = await fetch(url.toString())
  if (!res.ok) {
    const text = await res.text()
    throw new Error(`Meta account fetch failed: ${text}`)
  }

  const data = await res.json() as {
    data?: Array<{
      instagram_business_account?: { id: string; username?: string }
    }>
  }

  const account = data.data?.find(item => item.instagram_business_account?.id)?.instagram_business_account
  if (!account?.id) {
    throw new Error('No Instagram Business account found')
  }
  return account.id
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

      if (!resolvedInstagramId) {
        if (!code) {
          return reply.status(400).send({ error: 'Missing code or instagramAccountId' })
        }
        const redirect = redirectUri || config.META_INSTAGRAM_REDIRECT_URI || config.META_REDIRECT_URI
        if (!redirect) {
          return reply.status(400).send({ error: 'Missing redirectUri' })
        }
        const accessToken = await exchangeCodeForToken(code, redirect)
        resolvedInstagramId = await fetchInstagramAccountId(accessToken)
      }

      await db.insert(merchantChannels).values({
        merchantId,
        channel: 'instagram',
        channelAccountId: resolvedInstagramId,
        status: 'connected',
        connectedAt: new Date(),
      }).onConflictDoNothing()

      app.log.info({ merchantId, instagramAccountId: resolvedInstagramId }, 'Instagram connected')
      return reply.status(200).send({ ok: true, instagramAccountId: resolvedInstagramId })
    } catch (err) {
      app.log.error({ err }, 'Instagram connect failed')
      return reply.status(500).send({ error: 'Instagram connect failed' })
    }
  })
}
