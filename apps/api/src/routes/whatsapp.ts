import type { FastifyInstance } from 'fastify'
import type { Db } from '@mesa/db'
import { merchants } from '@mesa/db'
import { eq } from 'drizzle-orm'
import { config } from '@mesa/config'

type EmbeddedSignupPayload = {
  merchantId: string
  code?: string
  redirectUri?: string
  phoneNumberId?: string
  wabaId?: string
}

async function exchangeCodeForToken(code: string, redirectUri: string) {
  if (!config.META_APP_ID || !config.META_APP_SECRET) {
    throw new Error('META_APP_ID/META_APP_SECRET not configured')
  }

  const url = new URL('https://graph.facebook.com/v20.0/oauth/access_token')
  url.searchParams.set('client_id', config.META_APP_ID)
  url.searchParams.set('client_secret', config.META_APP_SECRET)
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

async function fetchWhatsappAccount(accessToken: string) {
  const url = new URL('https://graph.facebook.com/v20.0/me')
  url.searchParams.set('fields', 'whatsapp_business_accounts{id,name,phone_numbers{id,display_phone_number}}')
  url.searchParams.set('access_token', accessToken)

  const res = await fetch(url.toString())
  if (!res.ok) {
    const text = await res.text()
    throw new Error(`Meta account fetch failed: ${text}`)
  }

  const data = await res.json() as {
    whatsapp_business_accounts?: {
      data?: Array<{
        id: string
        phone_numbers?: { data?: Array<{ id: string }> }
      }>
    }
  }

  const waba = data.whatsapp_business_accounts?.data?.[0]
  const phone = waba?.phone_numbers?.data?.[0]
  if (!waba?.id || !phone?.id) {
    throw new Error('No WhatsApp Business Account or phone number found')
  }
  return { wabaId: waba.id, phoneNumberId: phone.id }
}

export async function whatsappRoutes(app: FastifyInstance) {
  const db = (app as FastifyInstance & { db: Db }).db

  app.post<{ Body: EmbeddedSignupPayload }>('/embedded-signup', {
    config: { rateLimit: { max: 30, timeWindow: '1 minute' } },
  }, async (req, reply) => {
    const { merchantId, code, redirectUri, phoneNumberId, wabaId } = req.body

    const merchant = await db.query.merchants.findFirst({
      where: eq(merchants.id, merchantId),
    })
    if (!merchant) return reply.status(404).send({ error: 'Merchant not found' })

    let resolvedPhoneNumberId = phoneNumberId
    let resolvedWabaId = wabaId

    if (!resolvedPhoneNumberId || !resolvedWabaId) {
      if (!code) {
        return reply.status(400).send({ error: 'Missing code or phoneNumberId/wabaId' })
      }
      const redirect = redirectUri || config.META_REDIRECT_URI
      if (!redirect) {
        return reply.status(400).send({ error: 'Missing redirectUri' })
      }
      const accessToken = await exchangeCodeForToken(code, redirect)
      const resolved = await fetchWhatsappAccount(accessToken)
      resolvedPhoneNumberId = resolved.phoneNumberId
      resolvedWabaId = resolved.wabaId
    }

    await db.update(merchants).set({
      whatsappNumberId: resolvedPhoneNumberId,
      wabaId: resolvedWabaId,
      updatedAt: new Date(),
    }).where(eq(merchants.id, merchantId))

    app.log.info({ merchantId, wabaId: resolvedWabaId, phoneNumberId: resolvedPhoneNumberId }, 'Embedded signup linked')
    return reply.status(200).send({ ok: true, wabaId: resolvedWabaId, phoneNumberId: resolvedPhoneNumberId })
  })
}
