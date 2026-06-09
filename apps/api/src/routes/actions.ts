import type { FastifyInstance } from 'fastify'
import type { Db } from '@mesa/db'
import {
  agentTasks,
  orders,
  orderItems,
  payments,
  domainEvents,
} from '@mesa/db'
import { eq, and, sql } from 'drizzle-orm'
import { createHash } from 'crypto'

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex')
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

    if (!total || total <= 0) {
      return reply.status(422).send({ error: 'Invalid order total in task payload' })
    }

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
            where: sql`event_type IN ('ORDER_DETECTED', 'ORDER_CONFIRMED', 'PAYMENT_SCREENSHOT_RECEIVED', 'PAYMENT_CONFIRMED')`,
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
            customerName: req.body.customerName ?? null,
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
            where: sql`event_type IN ('ORDER_DETECTED', 'ORDER_CONFIRMED', 'PAYMENT_SCREENSHOT_RECEIVED', 'PAYMENT_CONFIRMED')`,
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
              where: sql`event_type IN ('ORDER_DETECTED', 'ORDER_CONFIRMED', 'PAYMENT_SCREENSHOT_RECEIVED', 'PAYMENT_CONFIRMED')`,
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

  app.post<{ Params: { token: string } }>('/payment/:token/request-balance', {
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

    const [claimed] = await db
      .update(agentTasks)
      .set({ status: 'DONE' as TaskStatus, resolvedAt: new Date(), resolvedBy: 'action_page' })
      .where(and(eq(agentTasks.id, task.id), eq(agentTasks.status, 'OPEN')))
      .returning({ id: agentTasks.id })
    if (!claimed) {
      const current = await db.query.agentTasks.findFirst({ where: eq(agentTasks.id, task.id) })
      return reply.status(409).send({ error: 'Already actioned', resolvedBy: current?.resolvedBy, resolvedAt: current?.resolvedAt })
    }

    return reply.status(200).send({ ok: true })
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

    const [claimed] = await db
      .update(agentTasks)
      .set({ status: 'CANCELLED' as TaskStatus, resolvedAt: new Date(), resolvedBy: 'action_page' })
      .where(and(eq(agentTasks.id, task.id), eq(agentTasks.status, 'OPEN')))
      .returning({ id: agentTasks.id })
    if (!claimed) {
      const current = await db.query.agentTasks.findFirst({ where: eq(agentTasks.id, task.id) })
      return reply.status(409).send({ error: 'Already actioned', resolvedBy: current?.resolvedBy, resolvedAt: current?.resolvedAt })
    }

    // Mark the PENDING payment as DISPUTED
    const payment = await db.query.payments.findFirst({
      where: and(eq(payments.orderId, p.orderId), eq(payments.status, 'PENDING')),
    })
    if (payment) {
      await db
        .update(payments)
        .set({ status: 'DISPUTED' })
        .where(eq(payments.id, payment.id))
    }

    return reply.status(200).send({ ok: true })
  })
}
