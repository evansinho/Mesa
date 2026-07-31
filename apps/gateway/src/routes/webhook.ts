import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify'
import { createHmac, timingSafeEqual } from 'crypto'
import { config } from '@mesa/config'
import type { MesaNatsClient } from '@mesa/nats'
import {
  SUBJECTS,
  type InboundMessageEvent,
  type InboundMessage,
  type WhatsAppContactSyncEvent,
  type WhatsAppHistorySyncEvent,
  type WhatsAppMessageEchoEvent,
} from '@mesa/types'
import type { Redis } from 'ioredis'
import { getDb } from '@mesa/db'
import { merchantChannels, merchants, platformInstagramAccount } from '@mesa/db'
import { and, eq } from 'drizzle-orm'

type WhatsAppRawMessage = {
  id: string
  from?: string
  to?: string
  recipient_id?: string
  timestamp: string
  type: string
  text?: { body: string }
  button?: { text?: string; payload?: string }
  interactive?: {
    button_reply?: { title?: string; id?: string }
    list_reply?: { title?: string; id?: string }
  }
  image?: { id: string; mime_type: string; caption?: string }
  document?: { id: string; mime_type: string }
  context?: {
    id?: string
    from?: string
    forwarded?: boolean
    frequently_forwarded?: boolean
    referred_product?: {
      catalog_id?: string
      product_retailer_id?: string
    }
  }
  direction?: string
  from_me?: boolean
  from_business?: boolean
}

type WhatsAppRawContact = {
  wa_id?: string
  input?: string
  id?: string
  phone_number?: string
  profile?: { name?: string }
  name?: string
  updated_at?: string
}

// WhatsApp Business API webhook payload shape
interface WhatsAppWebhookPayload {
  object: string
  entry: Array<{
    id: string
    changes: Array<{
      value: {
        messaging_product: string
        metadata: {
          display_phone_number: string
          phone_number_id: string
        }
        messages?: WhatsAppRawMessage[]
        message_echoes?: WhatsAppRawMessage[]
        smb_message_echoes?: WhatsAppRawMessage[]
        history?: unknown
        contacts?: WhatsAppRawContact[]
        smb_app_state_sync?: { contacts?: WhatsAppRawContact[] }
        statuses?: unknown[]
      }
      field: string
    }>
  }>
}

// Instagram Messaging webhook payload shape (subset)
interface InstagramWebhookPayload {
  object: string
  entry: Array<{
    id: string
    time: number
    messaging?: Array<{
      sender?: { id: string }
      recipient?: { id: string }
      timestamp?: number
      message?: {
        mid?: string
        text?: string
        is_echo?: boolean
        // Present on is_echo messages — the app that sent it. Matches Mesa's
        // own INSTAGRAM_APP_ID when Mesa itself sent the message via the Send
        // API; absent or a different value when the merchant typed it
        // natively in their own Instagram app. See the is_echo branch below.
        app_id?: string
        attachments?: Array<{
          type: string
          payload?: { id?: string; url?: string }
        }>
        // Meta nests referral HERE (message.referral) for a brand new
        // thread's first message sent via the composer after tapping an
        // ig.me/m/{username}?ref= link — confirmed against Meta's own
        // example payload. It only appears at the top level (below, as a
        // sibling of `message`) for the separate messaging_referral event
        // Meta sends on an EXISTING thread. A first-ever activation DM is
        // always a new thread, so this nested field is the one that
        // actually fires in practice — check both.
        referral?: { ref?: string }
      }
      // Present on the standalone messaging_referral event for an EXISTING
      // thread — never present on a brand-new thread's first message (see
      // message.referral above instead). Used to recognize the merchant's
      // own one-time verification DM (see instagramRoutes in apps/api),
      // never present on a genuine customer message.
      referral?: { ref?: string }
    }>
  }>
}

export function verifySignatureWithSecrets(payload: string, signature: string, secrets: Array<string | undefined>): boolean {
  const uniqueSecrets = [...new Set(secrets.filter((secret): secret is string => Boolean(secret)))]
  return uniqueSecrets.some(secret => {
    const expected = createHmac('sha256', secret)
      .update(payload)
      .digest('hex')
    const expectedBuffer = Buffer.from(`sha256=${expected}`, 'utf8')
    const sigBuffer = Buffer.from(signature, 'utf8')
    if (expectedBuffer.length !== sigBuffer.length) return false
    return timingSafeEqual(expectedBuffer, sigBuffer)
  })
}

export function verifyWebhookSignature(payload: string, signature: string): boolean {
  return verifySignatureWithSecrets(payload, signature, [
    config.WHATSAPP_APP_SECRET,
    config.META_APP_SECRET,
  ])
}

// Instagram API with Instagram Login webhooks may be signed with the
// companion Instagram app's own secret rather than the parent Meta app's —
// accept either since which one Meta actually uses isn't fully documented.
function verifyMetaSignature(payload: string, signature: string): boolean {
  return verifySignatureWithSecrets(payload, signature, [config.META_APP_SECRET, config.INSTAGRAM_APP_SECRET])
}

const REPLAY_WINDOW_MS = 5 * 60 * 1000

// Optional internal-callers replay defense via x-mesa-timestamp + x-mesa-nonce.
// Meta does not send these headers, so this only activates for service-to-service
// calls that opt in. The defense for real Meta webhooks is the payload-timestamp
// check below (`isPayloadTimestampFresh`).
async function enforceReplayProtection(
  req: FastifyRequest,
  redis: Redis
): Promise<boolean> {
  const timestampHeader = req.headers['x-mesa-timestamp']
  const nonceHeader = req.headers['x-mesa-nonce']

  if (typeof timestampHeader === 'string' && typeof nonceHeader === 'string') {
    const ts = Number(timestampHeader)
    if (!Number.isFinite(ts)) return false

    const now = Date.now()
    if (Math.abs(now - ts) > REPLAY_WINDOW_MS) return false

    const nonceKey = `webhook:nonce:${nonceHeader}`
    const set = await redis.set(nonceKey, '1', 'PX', REPLAY_WINDOW_MS, 'NX')
    if (set !== 'OK') return false
  }

  return true
}

// Reject webhook payloads whose own timestamp is older than the replay
// window. This is the meaningful Meta-side replay defense — the signature
// alone doesn't prevent a captured payload from being submitted hours later.
export function isPayloadTimestampFresh(timestampMs: number | undefined, now = Date.now()): boolean {
  if (timestampMs === undefined || !Number.isFinite(timestampMs)) return false
  // Reject anything more than REPLAY_WINDOW_MS in the past. Future-dated
  // timestamps are tolerated up to one window to allow for clock skew.
  return now - timestampMs <= REPLAY_WINDOW_MS && timestampMs - now <= REPLAY_WINDOW_MS
}

// A Redis error here must not drop the message — treat it as accepted
// (not a duplicate) rather than aborting the whole webhook. Worst case is an
// occasional reprocessed message, which is far cheaper than silent ingestion
// failure while Redis is unavailable.
async function dedupeMessageIds(
  redis: Redis,
  merchantId: string,
  messages: Array<{ id: string }>,
  namespace = 'wa:msg'
): Promise<Set<string>> {
  const accepted = new Set<string>()
  for (const msg of messages) {
    const key = `${namespace}:${merchantId}:${msg.id}`
    const set = await redis.set(key, '1', 'EX', 60 * 60 * 24, 'NX').catch(() => 'OK')
    if (set === 'OK') accepted.add(msg.id)
  }
  return accepted
}

async function dedupeInstagramMessageIds(
  redis: Redis,
  merchantId: string,
  messageIds: string[]
): Promise<Set<string>> {
  const accepted = new Set<string>()
  for (const id of messageIds) {
    const key = `ig:msg:${merchantId}:${id}`
    const set = await redis.set(key, '1', 'EX', 60 * 60 * 24, 'NX').catch(() => 'OK')
    if (set === 'OK') accepted.add(id)
  }
  return accepted
}

// Look up merchantId from channel account id. Redis-cached with 5min TTL
// to avoid a Postgres round-trip on every inbound webhook. Negative results
// are also cached (as the sentinel '__null__') so unknown phone_number_ids
// don't hammer the DB.
//
// Staleness: re-onboarding (re-running embedded signup) won't be reflected
// for up to 5 minutes. Acceptable trade-off — re-onboarding is rare and the
// fallback (old merchantId) still routes the message correctly.
const MERCHANT_LOOKUP_TTL = 5 * 60
const NULL_SENTINEL = '__null__'

export async function getMerchantIdByChannelAccountId(
  redis: Redis,
  channel: string,
  channelAccountId: string,
): Promise<string | null> {
  const cacheKey = `merchant_channel:${channel}:${channelAccountId}`
  // Redis is a pure performance optimization here — a down/exhausted cache
  // must not block message ingestion, so fall through to Postgres on error.
  const cached = await redis.get(cacheKey).catch(() => null)
  if (cached !== null) {
    return cached === NULL_SENTINEL ? null : cached
  }

  const db = getDb(config.DATABASE_URL)
  const channelRow = await db.query.merchantChannels.findFirst({
    where: and(
      eq(merchantChannels.channel, channel),
      eq(merchantChannels.channelAccountId, channelAccountId)
    ),
    columns: { merchantId: true },
  })

  const value = channelRow?.merchantId ?? null
  await redis.set(cacheKey, value ?? NULL_SENTINEL, 'EX', MERCHANT_LOOKUP_TTL).catch(() => {})
  return value
}

// Mesa's own Instagram account ID — every merchant's reply to Mesa lands in
// this one shared inbox (distinct from any merchant's own channelAccountId),
// so the webhook needs to recognize it before falling into the per-merchant
// lookup above. Cached the same way and for the same reason: a down/exhausted
// Redis must not block message ingestion.
const PLATFORM_ACCOUNT_LOOKUP_TTL = 5 * 60
const PLATFORM_ACCOUNT_CACHE_KEY = 'platform_instagram_account:id'

export async function getPlatformInstagramAccountId(redis: Redis): Promise<string | null> {
  const cached = await redis.get(PLATFORM_ACCOUNT_CACHE_KEY).catch(() => null)
  if (cached !== null) {
    return cached === NULL_SENTINEL ? null : cached
  }

  const db = getDb(config.DATABASE_URL)
  const account = await db.query.platformInstagramAccount.findFirst({
    columns: { accountId: true },
  })

  const value = account?.accountId ?? null
  await redis.set(PLATFORM_ACCOUNT_CACHE_KEY, value ?? NULL_SENTINEL, 'EX', PLATFORM_ACCOUNT_LOOKUP_TTL).catch(() => {})
  return value
}

function normalizeNigerianPhone(raw: string): string {
  const digits = raw.replace(/\D/g, '')
  const national = digits.startsWith('234') ? digits.slice(3) : digits.replace(/^0/, '')
  return `+234${national}`
}

async function getMerchantIdByPhone(redis: Redis, phone: string): Promise<string | null> {
  const normalized = normalizeNigerianPhone(phone)
  const cacheKey = `merchant_phone:${normalized}`
  const cached = await redis.get(cacheKey).catch(() => null)
  if (cached !== null) {
    return cached === NULL_SENTINEL ? null : cached
  }

  const db = getDb(config.DATABASE_URL)
  const merchant = await db.query.merchants.findFirst({
    where: eq(merchants.phone, normalized),
    columns: { id: true },
  })

  const value = merchant?.id ?? null
  await redis.set(cacheKey, value ?? NULL_SENTINEL, 'EX', MERCHANT_LOOKUP_TTL).catch(() => {})
  return value
}

export function getMessageText(msg: WhatsAppRawMessage): string | undefined {
  return msg.text?.body
    ?? msg.button?.text
    ?? msg.button?.payload
    ?? msg.interactive?.button_reply?.title
    ?? msg.interactive?.button_reply?.id
    ?? msg.interactive?.list_reply?.title
    ?? msg.interactive?.list_reply?.id
}

function getMessageType(msg: WhatsAppRawMessage): InboundMessage['type'] {
  if (getMessageText(msg)) return 'text'
  if (msg.type === 'image' || msg.type === 'document' || msg.type === 'audio' || msg.type === 'video') return msg.type
  return msg.type as InboundMessage['type']
}

export function getMessageCustomerId(msg: WhatsAppRawMessage, direction: 'customer' | 'vendor'): string | null {
  if (direction === 'vendor') return msg.to ?? msg.recipient_id ?? null
  return msg.from ?? null
}

function toInboundMessage(
  msg: WhatsAppRawMessage,
  channelAccountId: string,
  customerId: string,
): InboundMessage {
  return {
    channel: 'whatsapp',
    channelAccountId,
    customerId,
    messageId: msg.id,
    timestamp: parseInt(msg.timestamp, 10),
    type: getMessageType(msg),
    text: getMessageText(msg),
    mediaId: msg.image?.id ?? msg.document?.id,
    mimeType: msg.image?.mime_type ?? msg.document?.mime_type,
    caption: msg.image?.caption,
    context: msg.context ? {
      id: msg.context.id,
      from: msg.context.from,
      forwarded: msg.context.forwarded,
      frequentlyForwarded: msg.context.frequently_forwarded,
      referredProduct: msg.context.referred_product ? {
        catalogId: msg.context.referred_product.catalog_id,
        productRetailerId: msg.context.referred_product.product_retailer_id,
      } : undefined,
    } : undefined,
  }
}

function summarizeRawMessage(msg: WhatsAppRawMessage) {
  return {
    id: msg.id,
    type: msg.type,
    direction: msg.direction,
    fromMe: msg.from_me,
    fromBusiness: msg.from_business,
    hasText: Boolean(getMessageText(msg)),
  }
}

export function isVendorHistoryMessage(msg: WhatsAppRawMessage, businessPhone: string): boolean {
  const direction = msg.direction?.toLowerCase()
  if (direction === 'outbound' || direction === 'sent' || direction === 'vendor' || direction === 'business') return true
  if (direction === 'inbound' || direction === 'received' || direction === 'customer') return false
  if (msg.from_me === true || msg.from_business === true) return true
  const normalizedBusiness = businessPhone.replace(/\D/g, '')
  const normalizedFrom = (msg.from ?? '').replace(/\D/g, '')
  return normalizedBusiness.length > 0 && normalizedFrom === normalizedBusiness
}

export function extractHistoryMessages(value: WhatsAppWebhookPayload['entry'][number]['changes'][number]['value']): WhatsAppRawMessage[] {
  const history = value.history as
    | undefined
    | WhatsAppRawMessage[]
    | { messages?: WhatsAppRawMessage[]; conversations?: Array<{ messages?: WhatsAppRawMessage[] }> }

  if (Array.isArray(value.messages)) return value.messages
  if (Array.isArray(history)) return history
  if (Array.isArray(history?.messages)) return history.messages
  if (Array.isArray(history?.conversations)) {
    return history.conversations.flatMap(conversation => conversation.messages ?? [])
  }
  return []
}

export function extractMessageEchoes(
  field: string,
  value: WhatsAppWebhookPayload['entry'][number]['changes'][number]['value'],
): WhatsAppRawMessage[] {
  const directEchoes = value.smb_message_echoes ?? value.message_echoes
  if (Array.isArray(directEchoes)) return directEchoes
  if (field === 'smb_message_echoes' || field === 'message_echoes') return value.messages ?? []
  return []
}

export function extractContactSync(value: WhatsAppWebhookPayload['entry'][number]['changes'][number]['value']): WhatsAppRawContact[] {
  return value.smb_app_state_sync?.contacts ?? value.contacts ?? []
}

// Mesa's own shared Instagram inbox (mirrors the shared WhatsApp number) —
// every merchant's reply to Mesa lands here, on a channelAccountId that
// belongs to no single merchant. There's no per-merchant channelAccountId to
// key off like the shop-account webhook below, so a merchant is identified
// either by referral.ref on their one-time activation DM, or by a reverse
// lookup on merchantRecipientId for any later message.
export async function handlePlatformAccountEntry(
  app: FastifyInstance,
  redis: Redis,
  nats: MesaNatsClient,
  entry: InstagramWebhookPayload['entry'][number],
  channelAccountId: string,
): Promise<void> {
  const messageIds = (entry.messaging ?? [])
    .map(msg => msg.message?.mid)
    .filter((mid): mid is string => Boolean(mid))

  const acceptedMessageIds = await dedupeInstagramMessageIds(redis, 'platform', messageIds)
  const db = getDb(config.DATABASE_URL)

  for (const msg of entry.messaging ?? []) {
    const message = msg.message
    if (!message?.mid || !acceptedMessageIds.has(message.mid)) continue
    // Mesa's own sends to a merchant echo back here too — already known, skip.
    if (message.is_echo) continue

    if (msg.timestamp && !isPayloadTimestampFresh(msg.timestamp)) {
      app.log.warn({
        channelAccountId,
        messageId: message.mid,
        messageTs: msg.timestamp,
        skew: Date.now() - msg.timestamp,
      }, 'Stale Instagram platform-inbox message rejected (outside replay window)')
      continue
    }

    const senderId = msg.sender?.id
    if (!senderId) continue

    // Merchant's own one-time verification DM (see instagramRoutes'
    // ig.me/m/{platform username}?ref={channelRowId} deep link) — capture
    // their IGSID as the recipient Mesa notifies them at. The activation DM
    // is always a brand-new thread, so Meta nests referral under
    // message.referral, not top-level msg.referral (that only fires for
    // messaging_referral events on an existing thread) — check both.
    const referralRef = message.referral?.ref ?? msg.referral?.ref
    if (referralRef) {
      const claimed = await db.update(merchantChannels)
        .set({ merchantRecipientId: senderId, merchantLastMessageAt: new Date() })
        .where(and(
          eq(merchantChannels.id, referralRef),
          eq(merchantChannels.channel, 'instagram'),
        ))
        .returning({ id: merchantChannels.id, merchantId: merchantChannels.merchantId })
      if (claimed.length > 0) {
        app.log.info({ merchantId: claimed[0].merchantId, channelRowId: referralRef }, 'Instagram merchant recipient ID captured (platform inbox)')
      } else {
        app.log.warn({ channelRowId: referralRef }, 'Instagram platform-inbox referral did not match any merchant channel')
      }
      continue
    }

    // Any later message from the same IGSID — this is a merchant replying to
    // Mesa (e.g. ACCEPT/BOOK RIDER, or a correction), not a customer, since
    // customers never message this account. No referral field is present
    // past the very first activation DM, so this reverse lookup is the only
    // way to identify which merchant is messaging.
    const merchantChannelRow = await db.query.merchantChannels.findFirst({
      where: and(eq(merchantChannels.channel, 'instagram'), eq(merchantChannels.merchantRecipientId, senderId)),
      columns: { id: true, merchantId: true },
    })
    if (!merchantChannelRow) {
      app.log.warn({ senderId }, 'Unknown sender on Mesa platform Instagram inbox — ignored')
      continue
    }

    await db.update(merchantChannels)
      .set({ merchantLastMessageAt: new Date() })
      .where(eq(merchantChannels.id, merchantChannelRow.id))

    const attachment = message.attachments?.[0]
    const inferredType = attachment?.type === 'image'
      ? 'image'
      : attachment
        ? 'document'
        : 'text'

    const vendorMessage: InboundMessage = {
      channel: 'instagram',
      channelAccountId,
      customerId: senderId,
      messageId: message.mid,
      timestamp: msg.timestamp ?? Date.now(),
      type: inferredType,
      text: message.text,
      mediaUrl: attachment?.payload?.url,
      caption: message.text,
      direction: 'vendor',
    }

    const event: InboundMessageEvent = {
      subject: SUBJECTS.INBOUND_MESSAGE,
      merchantId: merchantChannelRow.merchantId,
      message: vendorMessage,
    }
    await nats.publish(event)
    app.log.info({ merchantId: merchantChannelRow.merchantId, messageId: message.mid }, 'Instagram merchant reply (platform inbox) queued')
  }
}

export async function webhookRoutes(app: FastifyInstance) {
  const { nats, redis } = (app as FastifyInstance & { nats: MesaNatsClient; redis: Redis })

  // WhatsApp webhook verification (GET)
  app.get('/', {
    config: {
      rateLimit: {
        max: 20,
        timeWindow: '1 minute',
      },
    },
  }, async (req: FastifyRequest, reply: FastifyReply) => {
    const query = req.query as Record<string, string>
    const mode = query['hub.mode']
    const token = query['hub.verify_token']
    const challenge = query['hub.challenge']

    if (mode === 'subscribe' && token === config.WHATSAPP_WEBHOOK_VERIFY_TOKEN) {
      return reply.send(challenge)
    }
    return reply.status(403).send({ error: 'Forbidden' })
  })

  // Instagram webhook verification (GET)
  app.get('/instagram', {
    config: {
      rateLimit: {
        max: 20,
        timeWindow: '1 minute',
      },
    },
  }, async (req: FastifyRequest, reply: FastifyReply) => {
    const query = req.query as Record<string, string>
    const mode = query['hub.mode']
    const token = query['hub.verify_token']
    const challenge = query['hub.challenge']

    const expectedToken = config.INSTAGRAM_WEBHOOK_VERIFY_TOKEN ?? config.WHATSAPP_WEBHOOK_VERIFY_TOKEN
    if (mode === 'subscribe' && token === expectedToken) {
      return reply.send(challenge)
    }
    return reply.status(403).send({ error: 'Forbidden' })
  })

  // Inbound WhatsApp messages (POST)
  app.post('/', {
    config: {
      rateLimit: {
        max: 120,
        timeWindow: '1 minute',
      },
    },
  }, async (req: FastifyRequest, reply: FastifyReply) => {
    // Verify signature
    const signature = req.headers['x-hub-signature-256'] as string
    if (!signature) {
      return reply.status(401).send({ error: 'Missing signature' })
    }

    const rawBody = (req as FastifyRequest & { rawBody?: string }).rawBody ?? JSON.stringify(req.body)
    if (!verifyWebhookSignature(rawBody, signature)) {
      return reply.status(401).send({ error: 'Invalid signature' })
    }

    if (!await enforceReplayProtection(req, redis)) {
      return reply.status(401).send({ error: 'Replay protection failed' })
    }

    // Respond to WhatsApp immediately — processing happens async via NATS
    reply.status(200).send({ status: 'ok' })

    const payload = req.body as WhatsAppWebhookPayload
    if (payload.object !== 'whatsapp_business_account') return

    for (const entry of payload.entry) {
      for (const change of entry.changes) {
        const { metadata } = change.value

        let merchantId = await getMerchantIdByChannelAccountId(redis, 'whatsapp', metadata.phone_number_id)
        if (!merchantId && metadata.phone_number_id === config.WHATSAPP_PHONE_NUMBER_ID) {
          const sender = change.value.messages?.find(message => message.from)?.from
          if (sender) merchantId = await getMerchantIdByPhone(redis, sender)
        }
        if (!merchantId) {
          app.log.warn({ phoneNumberId: metadata.phone_number_id }, 'No merchant found for phone_number_id')
          continue
        }

        app.log.info({
          merchantId,
          phoneNumberId: metadata.phone_number_id,
          field: change.field,
          valueKeys: Object.keys(change.value).sort(),
          messages: change.value.messages?.map(summarizeRawMessage),
          messageEchoes: change.value.message_echoes?.map(summarizeRawMessage),
          smbMessageEchoes: change.value.smb_message_echoes?.map(summarizeRawMessage),
          statusCount: change.value.statuses?.length ?? 0,
        }, 'WhatsApp webhook change received')

        const echoes = extractMessageEchoes(change.field, change.value)
        if (echoes.length) {
          const acceptedMessageIds = await dedupeMessageIds(redis, merchantId, echoes, 'wa:echo')

          for (const msg of echoes) {
            if (!acceptedMessageIds.has(msg.id)) {
              app.log.warn({ merchantId, messageId: msg.id }, 'Duplicate WhatsApp message echo ignored')
              continue
            }

            const customerId = getMessageCustomerId(msg, 'vendor')
            if (!customerId) {
              app.log.warn({ merchantId, messageId: msg.id }, 'WhatsApp message echo missing customer id')
              continue
            }

            const event: WhatsAppMessageEchoEvent = {
              subject: SUBJECTS.WHATSAPP_MESSAGE_ECHO,
              merchantId,
              message: toInboundMessage(msg, metadata.phone_number_id, customerId),
            }
            await nats.publish(event)
            app.log.info({
              merchantId,
              messageId: msg.id,
              rawType: msg.type,
              type: event.message.type,
              hasText: Boolean(event.message.text),
            }, 'Message echo queued')
          }
          continue
        }

        if (change.field === 'history') {
          const historyMessages = extractHistoryMessages(change.value)
          if (!historyMessages.length) continue

          const eventMessages = historyMessages
            .map(msg => {
              const direction = isVendorHistoryMessage(msg, metadata.display_phone_number) ? 'vendor' as const : 'customer' as const
              const customerId = getMessageCustomerId(msg, direction)
              if (!customerId) return null
              return {
                ...toInboundMessage(msg, metadata.phone_number_id, customerId),
                direction,
                historical: true as const,
              }
            })
            .filter((msg): msg is NonNullable<typeof msg> => msg !== null)

          if (!eventMessages.length) continue

          const event: WhatsAppHistorySyncEvent = {
            subject: SUBJECTS.WHATSAPP_HISTORY_SYNC,
            merchantId,
            channelAccountId: metadata.phone_number_id,
            messages: eventMessages,
          }
          await nats.publish(event)
          app.log.info({ merchantId, count: eventMessages.length }, 'WhatsApp history sync queued')
          continue
        }

        if (change.field === 'smb_app_state_sync') {
          const contacts = extractContactSync(change.value)
            .map(contact => ({
              customerId: contact.wa_id ?? contact.input ?? contact.phone_number ?? contact.id ?? '',
              name: contact.profile?.name ?? contact.name,
              updatedAt: contact.updated_at,
            }))
            .filter(contact => contact.customerId.length > 0)

          if (!contacts.length) continue

          const event: WhatsAppContactSyncEvent = {
            subject: SUBJECTS.WHATSAPP_CONTACT_SYNC,
            merchantId,
            channelAccountId: metadata.phone_number_id,
            contacts,
          }
          await nats.publish(event)
          app.log.info({ merchantId, count: contacts.length }, 'WhatsApp contact sync queued')
          continue
        }

        if (change.field !== 'messages') continue
        const { messages } = change.value
        if (!messages?.length) continue

        const acceptedMessageIds = await dedupeMessageIds(redis, merchantId, messages)

        for (const msg of messages) {
          if (!acceptedMessageIds.has(msg.id)) {
            app.log.warn({ merchantId, messageId: msg.id }, 'Duplicate WhatsApp message ignored')
            continue
          }
          // Meta sends message.timestamp as Unix seconds (string). Reject any
          // message older than the 5-minute replay window — Meta-side replay
          // defense beyond the long-window message-ID dedup.
          const tsMs = parseInt(msg.timestamp, 10) * 1000
          if (!isPayloadTimestampFresh(tsMs)) {
            app.log.warn({
              merchantId,
              messageId: msg.id,
              messageTs: msg.timestamp,
              skew: Date.now() - tsMs,
            }, 'Stale WhatsApp message rejected (outside replay window)')
            continue
          }
          const customerId = getMessageCustomerId(msg, 'customer')
          if (!customerId) continue
          const message = toInboundMessage(msg, metadata.phone_number_id, customerId)

          const event: InboundMessageEvent = {
            subject: SUBJECTS.INBOUND_MESSAGE,
            merchantId,
            message,
          }

          if (msg.type === 'unsupported') {
            app.log.warn({
              merchantId,
              messageId: msg.id,
              phoneNumberId: metadata.phone_number_id,
              from: msg.from,
              rawMsg: msg,
            }, 'Unsupported inbound message — raw payload logged for diagnosis')
          }

          await nats.publish(event)
          app.log.info({
            merchantId,
            messageId: msg.id,
            rawType: msg.type,
            type: message.type,
            hasText: Boolean(message.text),
          }, 'Message queued')
        }
      }
    }
  })

  // Instagram DM webhook (POST)
  app.post('/instagram', {
    config: {
      rateLimit: {
        max: 120,
        timeWindow: '1 minute',
      },
    },
  }, async (req: FastifyRequest, reply: FastifyReply) => {
    const signature = req.headers['x-hub-signature-256'] as string
    if (!signature) {
      return reply.status(401).send({ error: 'Missing signature' })
    }

    const rawBody = (req as FastifyRequest & { rawBody?: string }).rawBody ?? JSON.stringify(req.body)
    if (!verifyMetaSignature(rawBody, signature)) {
      return reply.status(401).send({ error: 'Invalid signature' })
    }

    if (!await enforceReplayProtection(req, redis)) {
      return reply.status(401).send({ error: 'Replay protection failed' })
    }

    reply.status(200).send({ status: 'ok' })

    const payload = req.body as InstagramWebhookPayload
    if (payload.object !== 'instagram') return

    for (const entry of payload.entry) {
      const channelAccountId = entry.id
      if (!channelAccountId || !entry.messaging?.length) continue

      // Instagram entry.time is in milliseconds. Reject the whole entry if
      // its outer timestamp is older than the replay window.
      if (entry.time && !isPayloadTimestampFresh(entry.time)) {
        app.log.warn({
          channelAccountId,
          entryTime: entry.time,
          skew: Date.now() - entry.time,
        }, 'Stale Instagram entry rejected (outside replay window)')
        continue
      }

      // Mesa's own shared Instagram inbox (mirrors the shared WhatsApp
      // number) — every merchant's reply to Mesa lands here, on a
      // channelAccountId that belongs to no single merchant, so it's handled
      // on a separate path rather than falling into the per-merchant lookup.
      const platformAccountId = await getPlatformInstagramAccountId(redis)
      if (platformAccountId && channelAccountId === platformAccountId) {
        await handlePlatformAccountEntry(app, redis, nats, entry, channelAccountId)
        continue
      }

      const merchantId = await getMerchantIdByChannelAccountId(redis, 'instagram', channelAccountId)
      if (!merchantId) {
        app.log.warn({ channelAccountId }, 'No merchant found for instagram account id')
        continue
      }

      // Fetched once per entry (not per message) — used below to recognize
      // the merchant messaging Mesa's business account again after their
      // initial referral-tagged activation tap, which carries no `referral`
      // field and would otherwise fall through to customer-message handling.
      const merchantChannelRow = await getDb(config.DATABASE_URL).query.merchantChannels.findFirst({
        where: and(eq(merchantChannels.merchantId, merchantId), eq(merchantChannels.channel, 'instagram')),
        columns: { id: true, merchantRecipientId: true },
      })

      const messageIds = entry.messaging
        .map(msg => msg.message?.mid)
        .filter((mid): mid is string => Boolean(mid))

      const acceptedMessageIds = await dedupeInstagramMessageIds(redis, merchantId, messageIds)

      for (const msg of entry.messaging) {
        const message = msg.message
        if (!message?.mid || !acceptedMessageIds.has(message.mid)) continue

        if (message.is_echo) {
          // Every message this shop account sends echoes back here,
          // including Mesa's own Send API calls — told apart from the
          // merchant's own native reply (typed directly in their Instagram
          // app) by app_id: present and matching Mesa's own app when Mesa
          // sent it, absent or different when the merchant did. Closes the
          // negotiation-visibility gap WhatsApp already has via Business App
          // coexistence echoes.
          if (message.app_id === config.INSTAGRAM_APP_ID) continue

          if (msg.timestamp && !isPayloadTimestampFresh(msg.timestamp)) {
            app.log.warn({
              merchantId,
              messageId: message.mid,
              messageTs: msg.timestamp,
              skew: Date.now() - msg.timestamp,
            }, 'Stale Instagram merchant echo rejected (outside replay window)')
            continue
          }

          // On an echo, the business account is the sender — the customer
          // being messaged is the recipient, the reverse of a normal inbound message.
          const customerRecipientId = msg.recipient?.id
          if (!customerRecipientId) {
            app.log.warn({ merchantId, messageId: message.mid }, 'Instagram merchant echo missing recipient id')
            continue
          }

          const attachment = message.attachments?.[0]
          const inferredType = attachment?.type === 'image'
            ? 'image'
            : attachment
              ? 'document'
              : 'text'

          const vendorMessage: InboundMessage = {
            channel: 'instagram',
            channelAccountId,
            customerId: customerRecipientId,
            messageId: message.mid,
            timestamp: msg.timestamp ?? Date.now(),
            type: inferredType,
            text: message.text,
            mediaUrl: attachment?.payload?.url,
            caption: message.text,
            direction: 'vendor',
          }

          const event: InboundMessageEvent = {
            subject: SUBJECTS.INBOUND_MESSAGE,
            merchantId,
            message: vendorMessage,
          }
          await nats.publish(event)
          app.log.info({ merchantId, messageId: message.mid }, 'Instagram merchant echo (native reply to customer) queued')
          continue
        }
        // Per-message timestamp (ms) when present — finer-grained replay reject.
        if (msg.timestamp && !isPayloadTimestampFresh(msg.timestamp)) {
          app.log.warn({
            merchantId,
            messageId: message.mid,
            messageTs: msg.timestamp,
            skew: Date.now() - msg.timestamp,
          }, 'Stale Instagram message rejected (outside replay window)')
          continue
        }

        const senderId = msg.sender?.id
        if (!senderId) continue

        // Merchant's own one-time verification DM (see instagramRoutes'
        // ig.me/m/{username}?ref={channelRowId} deep link) — capture their
        // IGSID as the recipient Mesa notifies them at, and don't treat this
        // as a customer message. A brand-new thread's referral is nested
        // under message.referral, not top-level msg.referral — check both.
        const referralRef = message.referral?.ref ?? msg.referral?.ref
        if (referralRef) {
          const db = getDb(config.DATABASE_URL)
          const claimed = await db.update(merchantChannels)
            .set({ merchantRecipientId: senderId, merchantLastMessageAt: new Date() })
            .where(and(
              eq(merchantChannels.id, referralRef),
              eq(merchantChannels.channel, 'instagram'),
              eq(merchantChannels.merchantId, merchantId),
            ))
            .returning({ id: merchantChannels.id })
          if (claimed.length > 0) {
            app.log.info({ merchantId, channelRowId: referralRef }, 'Instagram merchant recipient ID captured')
            continue
          }
        }

        // Any later message from the same IGSID — the `referral` field is
        // only present on the message triggered by the deep link itself, so
        // this is the only way to recognize the merchant messaging Mesa
        // again (needed to keep the 24h messaging window open for
        // merchant-facing notifications, and to avoid treating the merchant
        // as a customer).
        if (merchantChannelRow?.merchantRecipientId && senderId === merchantChannelRow.merchantRecipientId) {
          const db = getDb(config.DATABASE_URL)
          await db.update(merchantChannels)
            .set({ merchantLastMessageAt: new Date() })
            .where(eq(merchantChannels.id, merchantChannelRow.id))
          continue
        }

        const attachment = message.attachments?.[0]
        const inferredType = attachment?.type === 'image'
          ? 'image'
          : attachment
            ? 'document'
            : 'text'

        const normalized: InboundMessage = {
          channel: 'instagram',
          channelAccountId,
          customerId: senderId,
          messageId: message.mid,
          timestamp: msg.timestamp ?? Date.now(),
          type: inferredType,
          text: message.text,
          // Instagram attachments carry a directly-fetchable CDN URL, not a
          // WhatsApp-style opaque Graph media ID — keep these distinct so
          // downstream code knows whether it can fetch directly or needs
          // downloadMedia()'s two-step Graph API resolution.
          mediaUrl: attachment?.payload?.url,
          caption: message.text,
        }

        const event: InboundMessageEvent = {
          subject: SUBJECTS.INBOUND_MESSAGE,
          merchantId,
          message: normalized,
        }

        await nats.publish(event)
        app.log.info({ merchantId, messageId: message.mid, type: normalized.type }, 'Instagram message queued')
      }
    }
  })
}
