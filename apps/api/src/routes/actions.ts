import type { FastifyInstance } from 'fastify'
import type { Db } from '@mesa/db'
import {
  agentTasks,
  orders,
  orderItems,
  payments,
  domainEvents,
  merchantChannels,
  conversations,
} from '@mesa/db'
import { eq, and, sql } from 'drizzle-orm'
import { createHash } from 'crypto'
import { sendText } from '@mesa/whatsapp'

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex')
}

// Instagram's customerPhone is really the customer's IGSID — conversations.
// customerName carries the actual name/username Mesa fetched from Instagram
// at first contact (see message.handler.ts). Only used as a fallback: an
// explicit name typed on the action page always wins.
async function fetchConversationCustomerName(db: Db, conversationId: string | undefined | null): Promise<string | undefined> {
  if (!conversationId) return undefined
  const conv = await db.query.conversations.findFirst({
    where: eq(conversations.id, conversationId),
    columns: { customerName: true },
  })
  return conv?.customerName ?? undefined
}

type TaskStatus = 'OPEN' | 'DONE' | 'CANCELLED'

// Payload shapes for task types
interface PendingOrderPayload {
  conversationId?: string
  customerPhone: string
  items: Array<{
    productName: string
    quantity: number
    unitPrice?: number
    agreedPrice?: number
  }>
  agreedTotal: number
  prompt?: string
  createdAt?: string
}

interface PendingPaymentPayload {
  orderId: string
  reason: string
  received?: number
  expected?: number
  screenshotUrl?: string
  reference?: string
  createdAt?: string
}

class AlreadyActionedError extends Error {}

function paymentRetryDelayMs(count: number): number | null {
  if (count <= 1) return 10 * 60 * 1000
  if (count === 2) return 30 * 60 * 1000
  if (count === 3) return 2 * 60 * 60 * 1000
  return null
}

export async function actionRoutes(app: FastifyInstance) {
  const db = (app as FastifyInstance & { db: Db }).db

  // ─── Order: load ────────────────────────────────────────────────────────────

  app.get<{ Params: { token: string } }>('/order/:token', {
    config: { rateLimit: { max: 60, timeWindow: '1 minute' } },
  }, async (req, reply) => {
    const task = await db.query.agentTasks.findFirst({
      where: eq(agentTasks.actionTokenHash, hashToken(req.params.token)),
    })
    if (!task) return reply.status(404).send({ error: 'Not found' })
    if (task.expiresAt && task.expiresAt < new Date()) {
      return reply.status(410).send({ error: 'Link has expired' })
    }
    if (task.status !== 'OPEN') {
      return reply.status(409).send({ error: 'Already actioned', resolvedBy: task.resolvedBy, resolvedAt: task.resolvedAt })
    }
    if (task.type !== 'PENDING_ORDER_CONFIRMATION') {
      return reply.status(404).send({ error: 'Not found' })
    }
    return reply.status(200).send({ task: { id: task.id, merchantId: task.merchantId, type: task.type, payload: task.payload } })
  })

  // ─── Order: accept ──────────────────────────────────────────────────────────

  app.post<{ Params: { token: string } }>('/order/:token/accept', {
    config: { rateLimit: { max: 30, timeWindow: '1 minute' } },
  }, async (req, reply) => {
    const task = await db.query.agentTasks.findFirst({
      where: eq(agentTasks.actionTokenHash, hashToken(req.params.token)),
    })
    if (!task) return reply.status(404).send({ error: 'Not found' })
    if (task.expiresAt && task.expiresAt < new Date()) {
      return reply.status(410).send({ error: 'Link has expired' })
    }
    if (task.type !== 'PENDING_ORDER_CONFIRMATION') {
      return reply.status(404).send({ error: 'Not found' })
    }

    const p = task.payload as unknown as PendingOrderPayload
    const total = p.agreedTotal

    if (total <= 0) {
      return reply.status(422).send({ error: 'Price not set — use Edit to set the agreed total before accepting.' })
    }

    const customerName = await fetchConversationCustomerName(db, p.conversationId)

    let orderId: string
    try {
      orderId = await db.transaction(async (tx) => {
        const [claimed] = await tx
          .update(agentTasks)
          .set({ status: 'DONE' as TaskStatus, resolvedAt: new Date(), resolvedBy: 'action_page' })
          .where(and(eq(agentTasks.id, task.id), eq(agentTasks.status, 'OPEN')))
          .returning({ id: agentTasks.id })
        if (!claimed) throw new AlreadyActionedError()

        const [order] = await tx
          .insert(orders)
          .values({
            merchantId: task.merchantId,
            conversationId: p.conversationId ?? null,
            customerPhone: p.customerPhone,
            customerName,
            status: 'CONFIRMED',
            subtotal: total.toString(),
            total: total.toString(),
          })
          .returning()

        for (const item of p.items ?? []) {
          await tx.insert(orderItems).values({
            orderId: order.id,
            productName: item.productName,
            quantity: item.quantity,
            unitPrice: (item.unitPrice ?? 0).toString(),
            agreedPrice: (item.agreedPrice ?? item.unitPrice ?? 0).toString(),
          })
        }

        const payload: Record<string, unknown> = { merchantId: task.merchantId }
        if (p.conversationId) payload.conversationId = p.conversationId
        await tx
          .insert(domainEvents)
          .values({
            aggregateId: order.id,
            aggregateType: 'order',
            eventType: 'ORDER_CONFIRMED',
            payload: { v: 1, data: payload },
          })
          .onConflictDoNothing({
            target: [domainEvents.aggregateId, domainEvents.eventType],
            where: sql`event_type IN ('ORDER_CONFIRMED', 'PAYMENT_SCREENSHOT_RECEIVED', 'PAYMENT_CONFIRMED')`,
          })

        return order.id
      })
    } catch (err) {
      if (err instanceof AlreadyActionedError) {
        const current = await db.query.agentTasks.findFirst({ where: eq(agentTasks.id, task.id) })
        return reply.status(409).send({ error: 'Already actioned', resolvedBy: current?.resolvedBy, resolvedAt: current?.resolvedAt })
      }
      throw err
    }

    return reply.status(200).send({ ok: true, orderId })
  })

  // ─── Order: reject ──────────────────────────────────────────────────────────

  app.post<{ Params: { token: string } }>('/order/:token/reject', {
    config: { rateLimit: { max: 30, timeWindow: '1 minute' } },
  }, async (req, reply) => {
    const task = await db.query.agentTasks.findFirst({
      where: eq(agentTasks.actionTokenHash, hashToken(req.params.token)),
    })
    if (!task) return reply.status(404).send({ error: 'Not found' })
    if (task.expiresAt && task.expiresAt < new Date()) {
      return reply.status(410).send({ error: 'Link has expired' })
    }
    if (task.type !== 'PENDING_ORDER_CONFIRMATION') {
      return reply.status(404).send({ error: 'Not found' })
    }

    const [claimed] = await db
      .update(agentTasks)
      .set({ status: 'CANCELLED' as TaskStatus, resolvedAt: new Date(), resolvedBy: 'action_page' })
      .where(and(eq(agentTasks.id, task.id), eq(agentTasks.status, 'OPEN')))
      .returning({ id: agentTasks.id })
    if (!claimed) {
      const current = await db.query.agentTasks.findFirst({ where: eq(agentTasks.id, task.id) })
      return reply.status(409).send({ error: 'Already actioned', resolvedBy: current?.resolvedBy, resolvedAt: current?.resolvedAt })
    }

    return reply.status(200).send({ ok: true })
  })

  // ─── Order: edit ────────────────────────────────────────────────────────────

  app.patch<{
    Params: { token: string }
    Body: {
      agreedTotal: number
      customerName?: string
      items?: Array<{
        productName: string
        quantity: number
        unitPrice?: number
        agreedPrice?: number
      }>
      notes?: string
    }
  }>('/order/:token/edit', {
    config: { rateLimit: { max: 30, timeWindow: '1 minute' } },
  }, async (req, reply) => {
    const task = await db.query.agentTasks.findFirst({
      where: eq(agentTasks.actionTokenHash, hashToken(req.params.token)),
    })
    if (!task) return reply.status(404).send({ error: 'Not found' })
    if (task.expiresAt && task.expiresAt < new Date()) {
      return reply.status(410).send({ error: 'Link has expired' })
    }
    if (task.type !== 'PENDING_ORDER_CONFIRMATION') {
      return reply.status(404).send({ error: 'Not found' })
    }

    const p = task.payload as unknown as PendingOrderPayload
    const total = req.body.agreedTotal

    if (!total || total <= 0) {
      return reply.status(422).send({ error: 'agreedTotal must be a positive number' })
    }

    const effectiveItems = req.body.items ?? p.items ?? []
    const customerName = req.body.customerName ?? await fetchConversationCustomerName(db, p.conversationId)

    let orderId: string
    try {
      orderId = await db.transaction(async (tx) => {
        const [claimed] = await tx
          .update(agentTasks)
          .set({ status: 'DONE' as TaskStatus, resolvedAt: new Date(), resolvedBy: 'action_page' })
          .where(and(eq(agentTasks.id, task.id), eq(agentTasks.status, 'OPEN')))
          .returning({ id: agentTasks.id })
        if (!claimed) throw new AlreadyActionedError()

        const [order] = await tx
          .insert(orders)
          .values({
            merchantId: task.merchantId,
            conversationId: p.conversationId ?? null,
            customerPhone: p.customerPhone,
            customerName: customerName ?? null,
            status: 'CONFIRMED',
            subtotal: total.toString(),
            total: total.toString(),
            notes: req.body.notes ?? null,
          })
          .returning()

        for (const item of effectiveItems) {
          await tx.insert(orderItems).values({
            orderId: order.id,
            productName: item.productName,
            quantity: item.quantity,
            unitPrice: (item.unitPrice ?? 0).toString(),
            agreedPrice: (item.agreedPrice ?? item.unitPrice ?? 0).toString(),
          })
        }

        const payload: Record<string, unknown> = { merchantId: task.merchantId }
        if (p.conversationId) payload.conversationId = p.conversationId
        await tx
          .insert(domainEvents)
          .values({
            aggregateId: order.id,
            aggregateType: 'order',
            eventType: 'ORDER_CONFIRMED',
            payload: { v: 1, data: payload },
          })
          .onConflictDoNothing({
            target: [domainEvents.aggregateId, domainEvents.eventType],
            where: sql`event_type IN ('ORDER_CONFIRMED', 'PAYMENT_SCREENSHOT_RECEIVED', 'PAYMENT_CONFIRMED')`,
          })

        return order.id
      })
    } catch (err) {
      if (err instanceof AlreadyActionedError) {
        const current = await db.query.agentTasks.findFirst({ where: eq(agentTasks.id, task.id) })
        return reply.status(409).send({ error: 'Already actioned', resolvedBy: current?.resolvedBy, resolvedAt: current?.resolvedAt })
      }
      throw err
    }

    return reply.status(200).send({ ok: true, orderId })
  })

  // ─── Payment: load ──────────────────────────────────────────────────────────

  app.get<{ Params: { token: string } }>('/payment/:token', {
    config: { rateLimit: { max: 60, timeWindow: '1 minute' } },
  }, async (req, reply) => {
    const task = await db.query.agentTasks.findFirst({
      where: eq(agentTasks.actionTokenHash, hashToken(req.params.token)),
    })
    if (!task) return reply.status(404).send({ error: 'Not found' })
    if (task.expiresAt && task.expiresAt < new Date()) {
      return reply.status(410).send({ error: 'Link has expired' })
    }
    if (task.status !== 'OPEN') {
      return reply.status(409).send({ error: 'Already actioned', resolvedBy: task.resolvedBy, resolvedAt: task.resolvedAt })
    }
    if (task.type !== 'PENDING_PAYMENT_REVIEW') {
      return reply.status(404).send({ error: 'Not found' })
    }
    return reply.status(200).send({ task: { id: task.id, merchantId: task.merchantId, type: task.type, payload: task.payload } })
  })

  // ─── Payment: confirm ───────────────────────────────────────────────────────

  app.post<{ Params: { token: string } }>('/payment/:token/confirm', {
    config: { rateLimit: { max: 30, timeWindow: '1 minute' } },
  }, async (req, reply) => {
    const task = await db.query.agentTasks.findFirst({
      where: eq(agentTasks.actionTokenHash, hashToken(req.params.token)),
    })
    if (!task) return reply.status(404).send({ error: 'Not found' })
    if (task.expiresAt && task.expiresAt < new Date()) {
      return reply.status(410).send({ error: 'Link has expired' })
    }
    if (task.type !== 'PENDING_PAYMENT_REVIEW') {
      return reply.status(404).send({ error: 'Not found' })
    }

    const p = task.payload as unknown as PendingPaymentPayload

    try {
      await db.transaction(async (tx) => {
        const [claimed] = await tx
          .update(agentTasks)
          .set({ status: 'DONE' as TaskStatus, resolvedAt: new Date(), resolvedBy: 'action_page' })
          .where(and(eq(agentTasks.id, task.id), eq(agentTasks.status, 'OPEN')))
          .returning({ id: agentTasks.id })
        if (!claimed) throw new AlreadyActionedError()

        const payment = await tx.query.payments.findFirst({
          where: and(eq(payments.orderId, p.orderId), eq(payments.status, 'PENDING')),
        })
        if (payment) {
          await tx
            .update(payments)
            .set({ status: 'CONFIRMED', confirmedAt: new Date() })
            .where(eq(payments.id, payment.id))

          await tx
            .insert(domainEvents)
            .values({
              aggregateId: p.orderId,
              aggregateType: 'order',
              eventType: 'PAYMENT_CONFIRMED',
              payload: {
                v: 1,
                data: {
                  merchantId: task.merchantId,
                  amount: payment.amount ? parseFloat(payment.amount) : (p.received ?? 0),
                },
              },
            })
            .onConflictDoNothing({
              target: [domainEvents.aggregateId, domainEvents.eventType],
              // Must exactly match domain_events_appendonce_idx's current WHERE
              // predicate (migration 0022 dropped ORDER_DETECTED from it so
              // repeat orders in one thread aren't suppressed) — Postgres only
              // infers a matching partial index when the predicate is
              // identical, not a superset of it. This stale copy (still
              // listing ORDER_DETECTED) made every payment confirmation
              // through the action-page link throw in production.
              where: sql`event_type IN ('ORDER_CONFIRMED', 'PAYMENT_SCREENSHOT_RECEIVED', 'PAYMENT_CONFIRMED')`,
            })
        }
      })
    } catch (err) {
      if (err instanceof AlreadyActionedError) {
        const current = await db.query.agentTasks.findFirst({ where: eq(agentTasks.id, task.id) })
        return reply.status(409).send({ error: 'Already actioned', resolvedBy: current?.resolvedBy, resolvedAt: current?.resolvedAt })
      }
      throw err
    }

    return reply.status(200).send({ ok: true })
  })

  // ─── Payment: request balance ───────────────────────────────────────────────
  // Sends the customer a message asking for their bank balance to verify the
  // payment. The task stays OPEN — the merchant still needs to confirm or
  // dispute after receiving the customer's response.

  app.post<{ Params: { token: string } }>('/payment/:token/request-balance', {
    config: { rateLimit: { max: 10, timeWindow: '1 minute' } },
  }, async (req, reply) => {
    const task = await db.query.agentTasks.findFirst({
      where: eq(agentTasks.actionTokenHash, hashToken(req.params.token)),
    })
    if (!task) return reply.status(404).send({ error: 'Not found' })
    if (task.expiresAt && task.expiresAt < new Date()) {
      return reply.status(410).send({ error: 'Link has expired' })
    }
    if (task.status !== 'OPEN') {
      const current = await db.query.agentTasks.findFirst({ where: eq(agentTasks.id, task.id) })
      return reply.status(409).send({ error: 'Already actioned', resolvedBy: current?.resolvedBy, resolvedAt: current?.resolvedAt })
    }
    if (task.type !== 'PENDING_PAYMENT_REVIEW') {
      return reply.status(404).send({ error: 'Not found' })
    }

    const p = task.payload as unknown as PendingPaymentPayload

    // Look up the order to get the customer's phone number
    const order = await db.query.orders.findFirst({
      where: eq(orders.id, p.orderId),
      columns: { customerPhone: true },
    })

    if (order?.customerPhone) {
      try {
        const channel = await db.query.merchantChannels.findFirst({
          where: and(
            eq(merchantChannels.merchantId, task.merchantId),
            eq(merchantChannels.channel, 'whatsapp'),
            eq(merchantChannels.status, 'connected'),
          ),
        })
        const hasMerchantCreds =
          channel?.accessToken &&
          channel.channelAccountId &&
          !channel.channelAccountId.startsWith('pending_')
        if (!hasMerchantCreds) {
          return reply.status(424).send({ error: 'Merchant WhatsApp credentials are not available' })
        }

        await sendText(
          order.customerPhone,
          'Please reply with a screenshot of your current bank account balance to help confirm your recent payment.',
          {
            phoneNumberId: channel.channelAccountId,
            accessToken: channel.accessToken ?? undefined,
          },
        )
      } catch (err) {
        req.log.warn({ err, taskId: task.id }, 'Failed to send customer balance request')
        // Non-fatal — the task stays open regardless
      }
    }

    return reply.status(200).send({ ok: true })
  })

  // ─── Payment: not yet ───────────────────────────────────────────────────────

  app.post<{ Params: { token: string } }>('/payment/:token/not-yet', {
    config: { rateLimit: { max: 30, timeWindow: '1 minute' } },
  }, async (req, reply) => {
    const task = await db.query.agentTasks.findFirst({
      where: eq(agentTasks.actionTokenHash, hashToken(req.params.token)),
    })
    if (!task) return reply.status(404).send({ error: 'Not found' })
    if (task.expiresAt && task.expiresAt < new Date()) {
      return reply.status(410).send({ error: 'Link has expired' })
    }
    if (task.status !== 'OPEN') {
      const current = await db.query.agentTasks.findFirst({ where: eq(agentTasks.id, task.id) })
      return reply.status(409).send({ error: 'Already actioned', resolvedBy: current?.resolvedBy, resolvedAt: current?.resolvedAt })
    }
    if (task.type !== 'PENDING_PAYMENT_REVIEW') {
      return reply.status(404).send({ error: 'Not found' })
    }

    const p = task.payload as unknown as PendingPaymentPayload & {
      notYetCount?: number
      lastNotYetAt?: string
      nextReminderAt?: string
      remindersStopped?: boolean
    }
    const nextCount = (p.notYetCount ?? 0) + 1
    const now = new Date()
    const delay = paymentRetryDelayMs(nextCount)
    await db.update(agentTasks)
      .set({
        payload: {
          ...(task.payload as Record<string, unknown>),
          notYetCount: nextCount,
          lastNotYetAt: now.toISOString(),
          nextReminderAt: delay ? new Date(now.getTime() + delay).toISOString() : undefined,
          remindersStopped: !delay,
        },
      })
      .where(eq(agentTasks.id, task.id))

    return reply.status(200).send({ ok: true, reminderScheduled: Boolean(delay) })
  })

  // ─── Payment: dispute ───────────────────────────────────────────────────────

  app.post<{ Params: { token: string } }>('/payment/:token/dispute', {
    config: { rateLimit: { max: 30, timeWindow: '1 minute' } },
  }, async (req, reply) => {
    const task = await db.query.agentTasks.findFirst({
      where: eq(agentTasks.actionTokenHash, hashToken(req.params.token)),
    })
    if (!task) return reply.status(404).send({ error: 'Not found' })
    if (task.expiresAt && task.expiresAt < new Date()) {
      return reply.status(410).send({ error: 'Link has expired' })
    }
    if (task.type !== 'PENDING_PAYMENT_REVIEW') {
      return reply.status(404).send({ error: 'Not found' })
    }

    const p = task.payload as unknown as PendingPaymentPayload

    try {
      await db.transaction(async (tx) => {
        const [claimed] = await tx
          .update(agentTasks)
          .set({ status: 'CANCELLED' as TaskStatus, resolvedAt: new Date(), resolvedBy: 'action_page' })
          .where(and(eq(agentTasks.id, task.id), eq(agentTasks.status, 'OPEN')))
          .returning({ id: agentTasks.id })
        if (!claimed) throw new AlreadyActionedError()

        const payment = await tx.query.payments.findFirst({
          where: and(eq(payments.orderId, p.orderId), eq(payments.status, 'PENDING')),
        })
        if (payment) {
          await tx
            .update(payments)
            .set({ status: 'DISPUTED' })
            .where(eq(payments.id, payment.id))
        }
      })
    } catch (err) {
      if (err instanceof AlreadyActionedError) {
        const current = await db.query.agentTasks.findFirst({ where: eq(agentTasks.id, task.id) })
        return reply.status(409).send({ error: 'Already actioned', resolvedBy: current?.resolvedBy, resolvedAt: current?.resolvedAt })
      }
      throw err
    }

    return reply.status(200).send({ ok: true })
  })
}
