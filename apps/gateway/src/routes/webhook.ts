import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify'
import { createHmac, timingSafeEqual } from 'crypto'
import { config } from '@mesa/config'
import type { MesaNatsClient } from '@mesa/nats'
import { SUBJECTS, type InboundMessageEvent, type InboundMessage } from '@mesa/types'
import type { Redis } from 'ioredis'
import { getDb } from '@mesa/db'
import { merchantChannels } from '@mesa/db'
import { and, eq } from 'drizzle-orm'

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
        messages?: Array<{
          id: string
          from: string
          timestamp: string
          type: string
          text?: { body: string }
          image?: { id: string; mime_type: string; caption?: string }
          document?: { id: string; mime_type: string }
        }>
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
        attachments?: Array<{
          type: string
          payload?: { id?: string; url?: string }
        }>
      }
    }>
  }>
}

function verifyWebhookSignature(payload: string, signature: string): boolean {
  const secret = config.WHATSAPP_APP_SECRET
  // If no app secret configured (e.g. 360dialog setup), skip verification
  if (!secret) return true
  const expected = createHmac('sha256', secret)
    .update(payload)
    .digest('hex')
  const expectedBuffer = Buffer.from(`sha256=${expected}`, 'utf8')
  const sigBuffer = Buffer.from(signature, 'utf8')
  if (expectedBuffer.length !== sigBuffer.length) return false
  return timingSafeEqual(expectedBuffer, sigBuffer)
}

function verifyMetaSignature(payload: string, signature: string): boolean {
  const metaSecret = config.META_APP_SECRET
  if (!metaSecret) return false
  const expected = createHmac('sha256', metaSecret)
    .update(payload)
    .digest('hex')
  const expectedBuffer = Buffer.from(`sha256=${expected}`, 'utf8')
  const sigBuffer = Buffer.from(signature, 'utf8')
  if (expectedBuffer.length !== sigBuffer.length) return false
  return timingSafeEqual(expectedBuffer, sigBuffer)
}

const REPLAY_WINDOW_MS = 5 * 60 * 1000

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

async function dedupeMessageIds(
  redis: Redis,
  merchantId: string,
  messages: Array<{ id: string }>
): Promise<Set<string>> {
  const accepted = new Set<string>()
  for (const msg of messages) {
    const key = `wa:msg:${merchantId}:${msg.id}`
    const set = await redis.set(key, '1', 'EX', 60 * 60 * 24, 'NX')
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
    const set = await redis.set(key, '1', 'EX', 60 * 60 * 24, 'NX')
    if (set === 'OK') accepted.add(id)
  }
  return accepted
}

// Look up merchantId from channel account id in the database.
async function getMerchantIdByChannelAccountId(channel: string, channelAccountId: string): Promise<string | null> {
  const db = getDb(config.DATABASE_URL)
  const channelRow = await db.query.merchantChannels.findFirst({
    where: and(
      eq(merchantChannels.channel, channel),
      eq(merchantChannels.channelAccountId, channelAccountId)
    ),
    columns: { merchantId: true },
  })

  return channelRow?.merchantId ?? null
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

    if (mode === 'subscribe' && token === config.WHATSAPP_WEBHOOK_VERIFY_TOKEN) {
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
        if (change.field !== 'messages') continue
        const { metadata, messages } = change.value
        if (!messages?.length) continue

        const merchantId = await getMerchantIdByChannelAccountId('whatsapp', metadata.phone_number_id)
        if (!merchantId) {
          app.log.warn({ phoneNumberId: metadata.phone_number_id }, 'No merchant found for phone_number_id')
          continue
        }

        const acceptedMessageIds = await dedupeMessageIds(redis, merchantId, messages)

        for (const msg of messages) {
          if (!acceptedMessageIds.has(msg.id)) {
            app.log.warn({ merchantId, messageId: msg.id }, 'Duplicate WhatsApp message ignored')
            continue
          }
          const message: InboundMessage = {
            channel: 'whatsapp',
            channelAccountId: metadata.phone_number_id,
            customerId: msg.from,
            messageId: msg.id,
            timestamp: parseInt(msg.timestamp, 10),
            type: msg.type as InboundMessage['type'],
            text: msg.text?.body,
            mediaId: msg.image?.id ?? msg.document?.id,
            mimeType: msg.image?.mime_type ?? msg.document?.mime_type,
            caption: msg.image?.caption,
          }

          const event: InboundMessageEvent = {
            subject: SUBJECTS.INBOUND_MESSAGE,
            merchantId,
            message,
          }

          await nats.publish(event)
          app.log.info({ merchantId, messageId: msg.id, type: msg.type }, 'Message queued')
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

      const merchantId = await getMerchantIdByChannelAccountId('instagram', channelAccountId)
      if (!merchantId) {
        app.log.warn({ channelAccountId }, 'No merchant found for instagram account id')
        continue
      }

      const messageIds = entry.messaging
        .map(msg => msg.message?.mid)
        .filter((mid): mid is string => Boolean(mid))

      const acceptedMessageIds = await dedupeInstagramMessageIds(redis, merchantId, messageIds)

      for (const msg of entry.messaging) {
        const message = msg.message
        if (!message?.mid || !acceptedMessageIds.has(message.mid)) continue
        if (message.is_echo) continue

        const senderId = msg.sender?.id
        if (!senderId) continue

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
          mediaId: attachment?.payload?.id ?? attachment?.payload?.url,
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
