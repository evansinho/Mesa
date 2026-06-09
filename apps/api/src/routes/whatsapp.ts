import type { FastifyInstance } from 'fastify'
import type { Db } from '@mesa/db'
import { merchants, merchantChannels } from '@mesa/db'
import { and, eq } from 'drizzle-orm'
import { config } from '@mesa/config'
import { sendTemplate } from '@mesa/whatsapp'
import { authorizeMerchant } from '../auth-context'

type EmbeddedSignupPayload = {
  merchantId: string
  code?: string
  redirectUri?: string
  phoneNumberId?: string
  wabaId?: string
}

async function exchangeCodeForToken(code: string) {
  const metaAppId = config.META_APP_ID ?? process.env.META_APP_ID
  const metaSecret = config.META_APP_SECRET ?? process.env.META_APP_SECRET
  if (!metaAppId || !metaSecret) {
    throw new Error('META_APP_ID/META_APP_SECRET not configured')
  }

  const url = new URL('https://graph.facebook.com/v20.0/oauth/access_token')
  url.searchParams.set('client_id', metaAppId)
  url.searchParams.set('client_secret', metaSecret)
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

async function fetchVerifiedName(phoneNumberId: string, accessToken: string): Promise<string | undefined> {
  const url = new URL(`https://graph.facebook.com/v20.0/${phoneNumberId}`)
  url.searchParams.set('fields', 'verified_name')
  url.searchParams.set('access_token', accessToken)
  const res = await fetch(url.toString())
  if (!res.ok) return undefined
  const data = await res.json() as { verified_name?: string }
  return data.verified_name
}

async function fetchWhatsappAccount(accessToken: string) {
  // Get the user's WABA via whatsapp_business_management permission
  const url = new URL('https://graph.facebook.com/v20.0/me/whatsapp_business_accounts')
  url.searchParams.set('access_token', accessToken)

  const res = await fetch(url.toString())
  if (!res.ok) {
    const text = await res.text()
    throw new Error(`Meta WABA fetch failed: ${text}`)
  }

  const data = await res.json() as {
    data?: Array<{ id: string }>
  }

  const wabaId = data.data?.[0]?.id
  if (!wabaId) throw new Error('No WhatsApp Business Account found on this account')

  // Fetch phone numbers for this WABA
  const phoneUrl = new URL(`https://graph.facebook.com/v20.0/${wabaId}/phone_numbers`)
  phoneUrl.searchParams.set('access_token', accessToken)

  const phoneRes = await fetch(phoneUrl.toString())
  if (!phoneRes.ok) {
    const text = await phoneRes.text()
    throw new Error(`Meta phone number fetch failed: ${text}`)
  }

  const phoneData = await phoneRes.json() as { data?: Array<{ id: string }> }
  const phoneNumberId = phoneData.data?.[0]?.id
  if (!phoneNumberId) throw new Error('No phone number found for this WABA')

  return { wabaId, phoneNumberId }
}

async function subscribeWhatsappAccount(wabaId: string, accessToken: string) {
  const url = new URL(`https://graph.facebook.com/v20.0/${wabaId}/subscribed_apps`)
  url.searchParams.set('access_token', accessToken)

  const res = await fetch(url.toString(), { method: 'POST' })
  if (!res.ok) {
    const text = await res.text()
    throw new Error(`Meta WABA subscription failed: ${text}`)
  }
}

export async function whatsappRoutes(app: FastifyInstance) {
  const db = (app as FastifyInstance & { db: Db }).db

  app.post<{ Body: EmbeddedSignupPayload }>('/embedded-signup', {
    config: { rateLimit: { max: 30, timeWindow: '1 minute' } },
  }, async (req, reply) => {
    try {
      const { merchantId, code, redirectUri, phoneNumberId, wabaId } = req.body
      const auth = authorizeMerchant(req, reply, merchantId)
      if (!auth.ok) return
      const authorizedMerchantId = auth.merchantId!

      const merchant = await db.query.merchants.findFirst({
        where: eq(merchants.id, authorizedMerchantId),
      })
      if (!merchant) return reply.status(404).send({ error: 'Merchant not found' })

      let resolvedPhoneNumberId = phoneNumberId
      let resolvedWabaId = wabaId
      let resolvedAccessToken: string | undefined

      // Exchange code for access token. FB.login() (JS SDK popup) handles the OAuth
      // redirect internally so no redirect_uri is needed in the token exchange.
      if (code) {
        resolvedAccessToken = await exchangeCodeForToken(code)
      }

      // Use WABA + phone from Embedded Signup message event if provided, else fetch from Graph API
      if (!resolvedPhoneNumberId || !resolvedWabaId) {
        if (!resolvedAccessToken) {
          return reply.status(400).send({ error: 'Missing code or phoneNumberId/wabaId' })
        }
        const resolved = await fetchWhatsappAccount(resolvedAccessToken)
        resolvedPhoneNumberId = resolved.phoneNumberId
        resolvedWabaId = resolved.wabaId
      }

      if (resolvedAccessToken && resolvedWabaId) {
        await subscribeWhatsappAccount(resolvedWabaId, resolvedAccessToken)
      }

      let resolvedBusinessName: string | undefined
      if (resolvedAccessToken) {
        resolvedBusinessName = await fetchVerifiedName(resolvedPhoneNumberId, resolvedAccessToken)
      }

      const existingChannel = await db.query.merchantChannels.findFirst({
        where: and(
          eq(merchantChannels.channel, 'whatsapp'),
          eq(merchantChannels.channelAccountId, resolvedPhoneNumberId),
        ),
      })
      if (existingChannel && existingChannel.merchantId !== authorizedMerchantId) {
        return reply.status(409).send({ error: 'This WhatsApp number is already connected to another Mesa merchant.' })
      }

      const connectedAt = new Date()
      await db.update(merchants).set({
        name: resolvedBusinessName ?? merchant.name,
        updatedAt: new Date(),
        config: {
          ...(merchant.config ?? {}),
          whatsapp: {
            ...((merchant.config?.whatsapp as Record<string, unknown> | undefined) ?? {}),
            wabaId: resolvedWabaId,
            phoneNumberId: resolvedPhoneNumberId,
            onboardingMode: 'business_app_coexistence',
            connectedAt: connectedAt.toISOString(),
          },
          onboarding: {
            status: 'incomplete',
            step: 'SETUP',
          },
        },
      }).where(eq(merchants.id, authorizedMerchantId))

      // Persist the per-merchant WhatsApp credentials. If the channel row
      // already exists (re-onboarding), update the access token so the new
      // one is used for subsequent customer-facing sends.
      await db.insert(merchantChannels).values({
        merchantId: authorizedMerchantId,
        channel: 'whatsapp',
        channelAccountId: resolvedPhoneNumberId,
        accessToken: resolvedAccessToken,
        status: 'connected',
        connectedAt,
      }).onConflictDoUpdate({
        target: [merchantChannels.channel, merchantChannels.channelAccountId],
        set: {
          accessToken: resolvedAccessToken,
          status: 'connected',
          connectedAt,
        },
      })

      let onboardingConnectionSent = false
      if (merchant.phone) {
        try {
          await sendTemplate(merchant.phone, 'mesa_connection_success', [], {
            languageCode: 'en',
            buttons: [{ type: 'url', index: 0, urlSuffix: 'onboarding/setup' }],
          })
          onboardingConnectionSent = true
        } catch (err) {
          app.log.warn({ err, merchantId: authorizedMerchantId }, 'Failed to send connection success template')
        }
      }

      app.log.info({ merchantId: authorizedMerchantId, wabaId: resolvedWabaId, phoneNumberId: resolvedPhoneNumberId }, 'Embedded signup linked')
      return reply.status(200).send({
        ok: true,
        wabaId: resolvedWabaId,
        phoneNumberId: resolvedPhoneNumberId,
        onboardingConnectionSent,
      })
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      app.log.error({ err, message }, 'Embedded signup failed')
      return reply.status(500).send({ error: `Embedded signup failed: ${message}` })
    }
  })
}
