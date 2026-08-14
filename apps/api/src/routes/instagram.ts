import type { FastifyInstance } from 'fastify'
import type { Db } from '@mesa/db'
import { merchants, merchantChannels, platformInstagramAccount } from '@mesa/db'
import { and, eq } from 'drizzle-orm'
import { createHmac, randomInt, timingSafeEqual } from 'crypto'
import { config } from '@mesa/config'
import { authorizeMerchant } from '../auth-context'

// Excludes visually ambiguous characters (0/O, 1/I/L) — this gets read off a
// phone screen and typed on another, so every character has to be unambiguous.
const ACTIVATION_CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'

function generateActivationCode(): string {
  let code = ''
  for (let i = 0; i < 6; i++) {
    code += ACTIVATION_CODE_ALPHABET[randomInt(ACTIVATION_CODE_ALPHABET.length)]
  }
  return code
}

// A capability token for the one-time platform-account connect flow, derived
// from the existing internal API key rather than reusing it directly — this
// value is embedded in a URL handed to a human to open in a browser, so a
// leaked URL (browser history, referrer) can only ever replay this one
// action, not forge arbitrary internal-authenticated requests.
export function platformInstagramConnectToken(): string {
  return createHmac('sha256', config.INTERNAL_API_KEY).update('connect-platform-account').digest('hex')
}

function isValidPlatformConnectToken(token: string | undefined): boolean {
  if (!token) return false
  const expected = platformInstagramConnectToken()
  const bufA = Buffer.from(token)
  const bufB = Buffer.from(expected)
  if (bufA.length !== bufB.length) return false
  return timingSafeEqual(bufA, bufB)
}

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

// Meta exposes two different numeric IDs for the same Instagram account
// under Instagram API with Instagram Login, confusingly:
//   - the OAuth code-exchange response's `user_id` (same value as this /me
//     call's own `id` field) — an "Instagram Login" namespace ID.
//   - this /me call's `user_id` field — a DIFFERENT namespace ID, which is
//     what webhook payloads actually use as `entry.id` / sender/recipient
//     ids. Confirmed by comparing a live webhook entry.id against both.
// Storing the wrong one means every webhook lookup for this account silently
// never matches — this is that fetch, always required, never skipped.
async function fetchInstagramAccountInfo(accessToken: string): Promise<{ webhookId: string; username?: string }> {
  const url = new URL('https://graph.instagram.com/v21.0/me')
  url.searchParams.set('fields', 'user_id,username')
  url.searchParams.set('access_token', accessToken)

  const res = await fetch(url.toString())
  if (!res.ok) {
    const text = await res.text()
    throw new Error(`Instagram account info fetch failed: ${text}`)
  }
  const data = await res.json() as { user_id?: string; username?: string }
  if (!data.user_id) {
    throw new Error('Instagram account info fetch returned no user_id')
  }
  return { webhookId: data.user_id, username: data.username }
}

// is_echo: true events (both Mesa's own sends and the merchant's own native
// replies typed in their Instagram app) arrive under the plain "messages"
// field automatically — no separate subscription needed. A prior version of
// this call included "message_echoes" as its own field, which Meta's API
// actually rejects outright (400 InvalidParameter); every subscribe attempt
// since then silently failed inside the try/catch at each call site, so it
// was never really enabled anyway.
//
// messaging_referral IS a real, separate required field — confirmed against
// Meta's docs ("your webhook must be subscribed to the messaging_referral
// event") and against a live production failure: a merchant's activation DM
// to Mesa's platform account carried no referral at all once a prior test
// attempt had already opened a thread, because Meta only delivers that
// referral via this distinct event once a thread exists. A brand-new
// thread's first message still carries referral inline (see the gateway's
// message.referral check), so this covers the other half.
async function subscribeToMessagesWebhook(accessToken: string): Promise<void> {
  const url = new URL('https://graph.instagram.com/v21.0/me/subscribed_apps')
  url.searchParams.set('subscribed_fields', 'messages,messaging_postbacks,messaging_referral')
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
      let resolvedAccessToken: string | undefined
      let resolvedUsername: string | undefined

      if (!resolvedInstagramId) {
        if (!code) {
          return reply.status(400).send({ error: 'Missing code or instagramAccountId' })
        }
        const redirect = redirectUri || config.META_INSTAGRAM_REDIRECT_URI || config.META_REDIRECT_URI
        if (!redirect) {
          return reply.status(400).send({ error: 'Missing redirectUri' })
        }
        const { accessToken: shortLivedToken } = await exchangeCodeForShortLivedToken(code, redirect)
        resolvedAccessToken = await exchangeForLongLivedToken(shortLivedToken)
        // Deliberately not the OAuth exchange's own userId — that's a
        // different ID namespace than what webhooks deliver. See
        // fetchInstagramAccountInfo.
        const accountInfo = await fetchInstagramAccountInfo(resolvedAccessToken)
        resolvedInstagramId = accountInfo.webhookId
        resolvedUsername = accountInfo.username
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
          ...(resolvedUsername ? { username: resolvedUsername } : {}),
        })
        .onConflictDoUpdate({
          target: [merchantChannels.channel, merchantChannels.channelAccountId],
          set: {
            status: 'connected',
            connectedAt: new Date(),
            ...(resolvedAccessToken ? { accessToken: resolvedAccessToken, tokenRefreshedAt: new Date() } : {}),
            ...(resolvedUsername ? { username: resolvedUsername } : {}),
          },
        })
        .returning({ id: merchantChannels.id, merchantRecipientId: merchantChannels.merchantRecipientId, username: merchantChannels.username })

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
      // reconnect where the merchant already verified before. Points at
      // Mesa's own Instagram account (mirroring the shared WhatsApp number),
      // not the merchant's own just-connected shop account — a merchant
      // can't message themselves, so this DMs Mesa instead.
      //
      // The ?ref= param is kept as a bonus (it can still work for a
      // genuinely first-ever thread) but the activation code is the actual
      // mechanism this depends on — see the schema comment on
      // merchantChannels.activationCode for why ?ref= alone isn't reliable.
      const platformAccount = await db.query.platformInstagramAccount.findFirst()
      let verificationUrl: string | undefined
      let verificationCode: string | undefined
      if (!channelRow.merchantRecipientId && platformAccount?.username) {
        verificationCode = generateActivationCode()
        await db.update(merchantChannels)
          .set({ activationCode: verificationCode })
          .where(eq(merchantChannels.id, channelRow.id))
        verificationUrl = `https://ig.me/m/${platformAccount.username}?ref=${channelRow.id}`
      }

      app.log.info({ merchantId: authorizedMerchantId, instagramAccountId: resolvedInstagramId }, 'Instagram connected')
      return reply.status(200).send({
        ok: true,
        instagramAccountId: resolvedInstagramId,
        username: channelRow.username,
        verificationUrl,
        verificationUsername: verificationUrl ? platformAccount?.username : undefined,
        verificationCode,
      })
    } catch (err) {
      app.log.error({ err }, 'Instagram connect failed')
      return reply.status(500).send({ error: 'Instagram connect failed' })
    }
  })

  // Mesa's own Instagram account, mirroring the shared WhatsApp number.
  // There is exactly one row in platformInstagramAccount. The very first
  // connect (no row exists yet) is opened directly in a browser with no
  // merchant session, so it's guarded by the one-time capability token
  // instead — see platformInstagramConnectToken above. Once bootstrapped,
  // any reconnect must carry internal auth (x-mesa-api-key) instead: the
  // token is a fixed value derived from a secret that never rotates, so
  // treating it as valid forever would let anyone who ever saw that one URL
  // (browser history, a shared screen, a log line) hijack the account later
  // by submitting their own OAuth code against the same token.
  app.post<{ Body: { code?: string; redirectUri?: string; token?: string } }>('/connect-platform-account', {
    config: { rateLimit: { max: 10, timeWindow: '1 minute' } },
  }, async (req, reply) => {
    try {
      const { code, redirectUri, token } = req.body
      const existing = await db.query.platformInstagramAccount.findFirst()

      if (existing) {
        if (req.auth?.kind !== 'internal') {
          return reply.status(403).send({ error: 'Forbidden' })
        }
      } else if (!isValidPlatformConnectToken(token)) {
        return reply.status(403).send({ error: 'Forbidden' })
      }

      if (!code) {
        return reply.status(400).send({ error: 'Missing code' })
      }
      const redirect = redirectUri || config.META_INSTAGRAM_REDIRECT_URI || config.META_REDIRECT_URI
      if (!redirect) {
        return reply.status(400).send({ error: 'Missing redirectUri' })
      }

      const { accessToken: shortLivedToken } = await exchangeCodeForShortLivedToken(code, redirect)
      const accessToken = await exchangeForLongLivedToken(shortLivedToken)
      // Deliberately not the OAuth exchange's own userId — that's a
      // different ID namespace than what webhooks deliver. See
      // fetchInstagramAccountInfo.
      const { webhookId, username } = await fetchInstagramAccountInfo(accessToken)

      if (existing) {
        await db.update(platformInstagramAccount)
          .set({ accountId: webhookId, username, accessToken, tokenRefreshedAt: new Date() })
          .where(eq(platformInstagramAccount.id, existing.id))
      } else {
        await db.insert(platformInstagramAccount).values({
          accountId: webhookId,
          username,
          accessToken,
          tokenRefreshedAt: new Date(),
        })
      }

      try {
        await subscribeToMessagesWebhook(accessToken)
        app.log.info({ instagramAccountId: webhookId }, 'Platform Instagram account subscribed to messages webhook')
      } catch (err) {
        app.log.warn({ err, instagramAccountId: webhookId }, 'Platform Instagram webhook subscription failed — account still connected')
      }

      app.log.info({ instagramAccountId: webhookId, username }, 'Platform Instagram account connected')
      return reply.status(200).send({ ok: true, instagramAccountId: webhookId, username })
    } catch (err) {
      app.log.error({ err }, 'Platform Instagram connect failed')
      return reply.status(500).send({ error: 'Platform Instagram connect failed' })
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
