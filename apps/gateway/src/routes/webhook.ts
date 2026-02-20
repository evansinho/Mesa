import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify'
import { createHmac, timingSafeEqual } from 'crypto'
import { config } from '@mesa/config'
import type { MesaNatsClient } from '@mesa/nats'
import { SUBJECTS, type WhatsAppInboundEvent, type WhatsAppMessage } from '@mesa/types'

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

function verifyWebhookSignature(payload: string, signature: string): boolean {
  const expected = createHmac('sha256', config.WHATSAPP_APP_SECRET)
    .update(payload)
    .digest('hex')
  const expectedBuffer = Buffer.from(`sha256=${expected}`, 'utf8')
  const sigBuffer = Buffer.from(signature, 'utf8')
  if (expectedBuffer.length !== sigBuffer.length) return false
  return timingSafeEqual(expectedBuffer, sigBuffer)
}

// In production, look up merchantId from whatsapp_number_id in the database.
// This is a placeholder — replace with a real DB lookup.
async function getMerchantIdByPhoneNumberId(phoneNumberId: string): Promise<string | null> {
  // TODO: replace with: db.query.merchants.findFirst({ where: eq(merchants.whatsappNumberId, phoneNumberId) })
  return `merchant_${phoneNumberId}`
}

export async function webhookRoutes(app: FastifyInstance) {
  const nats = (app as FastifyInstance & { nats: MesaNatsClient }).nats

  // WhatsApp webhook verification (GET)
  app.get('/', async (req: FastifyRequest, reply: FastifyReply) => {
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
    config: { rawBody: true },
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

    // Respond to WhatsApp immediately — processing happens async via NATS
    reply.status(200).send({ status: 'ok' })

    const payload = req.body as WhatsAppWebhookPayload
    if (payload.object !== 'whatsapp_business_account') return

    for (const entry of payload.entry) {
      for (const change of entry.changes) {
        if (change.field !== 'messages') continue
        const { metadata, messages } = change.value
        if (!messages?.length) continue

        const merchantId = await getMerchantIdByPhoneNumberId(metadata.phone_number_id)
        if (!merchantId) {
          app.log.warn(`No merchant found for phone_number_id: ${metadata.phone_number_id}`)
          continue
        }

        for (const msg of messages) {
          const message: WhatsAppMessage = {
            messageId: msg.id,
            from: msg.from,
            timestamp: parseInt(msg.timestamp, 10),
            type: msg.type as WhatsAppMessage['type'],
            text: msg.text?.body,
            mediaId: msg.image?.id ?? msg.document?.id,
            mimeType: msg.image?.mime_type ?? msg.document?.mime_type,
            caption: msg.image?.caption,
          }

          const event: WhatsAppInboundEvent = {
            subject: SUBJECTS.WHATSAPP_INBOUND,
            merchantId,
            message,
          }

          await nats.publish(event)
          app.log.info({ merchantId, messageId: msg.id, type: msg.type }, 'Message queued')
        }
      }
    }
  })
}