import { createHash } from 'crypto'
import type { Db } from '@mesa/db'
import { agentTasks, conversations, merchants, orders, payments } from '@mesa/db'
import type { MesaNatsClient } from '@mesa/nats'
import { SUBJECTS, type NotificationSendEvent } from '@mesa/types'
import type { Redis } from 'ioredis'
import { eq } from 'drizzle-orm'
import type { ConversationStateMachine } from '../conversation/state-machine'
import type { OrderHandler } from '../handlers/order.handler'
import type { PendingDecisions } from '../handlers/pending-decisions'
import { config as appConfig } from '@mesa/config'
import type { BotDecision, CartItem } from './types'
import { activeCartHash } from './runtime-context'

type ConversationRecord = Awaited<ReturnType<ConversationStateMachine['getOrCreate']>>

function hash(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

function orderCreateKey(conversationId: string, cart: CartItem[], total: number): string {
  return `order_create:${conversationId}:${hash(activeCartHash(cart))}:${total}`
}

function primaryIdempotencyKey(conv: ConversationRecord, messageId: string, decision: BotDecision): string | undefined {
  switch (decision.type) {
    case 'SEND_CUSTOMER_REPLY':
      return `reply:${conv.id}:${messageId}:${decision.type}:${hash(decision.message)}`
    case 'SEND_MERCHANT_ALERT':
      return `merchant_alert:${conv.id}:${hash(decision.message)}:${hash(activeCartHash(decision.contextPatch?.botRuntime?.cart ?? []))}`
    case 'CREATE_ORDER':
      return orderCreateKey(conv.id, decision.items, decision.total)
    case 'REQUEST_PAYMENT':
      return `payment_request:${decision.orderId}`
    case 'START_PAYMENT_REVIEW':
      return `payment_review:${decision.orderId}:${hash(decision.proofHashOrDone ?? decision.proofUrl ?? 'done')}`
    case 'START_FULFILLMENT':
      return `fulfillment_start:${decision.orderId}`
    case 'NOOP':
      return undefined
  }
}

export class SideEffectExecutor {
  constructor(
    private db: Db,
    private redis: Redis,
    private nats: MesaNatsClient,
    private stateMachine: ConversationStateMachine,
    private orderHandler?: OrderHandler,
    private pending?: PendingDecisions,
  ) {}

  async execute(
    conv: ConversationRecord,
    messageId: string,
    decision: BotDecision,
    metadata: { checkoutStageBefore?: string; intentType?: string } = {},
  ): Promise<void> {
    const decisionHash = hash(JSON.stringify(decision.contextPatch?.botRuntime ?? decision.type))
    const basePatch = {
      ...decision.contextPatch,
      botRuntime: decision.contextPatch?.botRuntime
        ? { ...decision.contextPatch.botRuntime, lastBotDecisionKey: `${decision.type}:${decisionHash}` }
        : decision.contextPatch?.botRuntime,
    }

    if (decision.contextPatch) {
      conv = await this.stateMachine.updateContext(conv, basePatch)
    }

    console.info(JSON.stringify({
      level: 'info',
      msg: 'bot_orchestrator_decision',
      conversationId: conv.id,
      checkoutStageBefore: metadata.checkoutStageBefore,
      checkoutStageAfter: decision.contextPatch?.botRuntime?.checkoutStage ?? decision.contextPatch?.checkoutStage,
      intentType: metadata.intentType,
      decisionType: decision.type,
      decisionKey: `${decision.type}:${decisionHash}`,
      idempotencyKey: primaryIdempotencyKey(conv, messageId, decision),
      guardReason: decision.type === 'NOOP' ? decision.reason : undefined,
      cartHash: decision.contextPatch?.botRuntime ? activeCartHash(decision.contextPatch.botRuntime.cart) : undefined,
      handoffReason: decision.contextPatch?.botRuntime?.escalationReason,
    }))

    switch (decision.type) {
      case 'NOOP':
        return

      case 'SEND_CUSTOMER_REPLY':
        await this.sendCustomerReply(conv, messageId, decision.type, decision.message)
        return

      case 'SEND_MERCHANT_ALERT':
        await this.sendMerchantAlert(conv, decision.message, decision.contextPatch?.botRuntime?.cart ?? [])
        if (decision.customerReply) await this.sendCustomerReply(conv, messageId, decision.type, decision.customerReply)
        return

      case 'CREATE_ORDER': {
        if (!this.orderHandler) return
        const key = orderCreateKey(conv.id, decision.items, decision.total)
        const acquired = await this.redis.set(key, '1', 'EX', 24 * 60 * 60, 'NX')
        if (!acquired) return
        try {
          await this.orderHandler.handleConfirmed(conv.merchantId, conv.id, decision.total)
          const orderConv = await this.db.query.conversations.findFirst({ where: eq(conversations.id, conv.id) })
          if (orderConv?.state === 'ORDER_CREATED') {
            await this.stateMachine.reset(conv.merchantId, conv.channel, conv.customerPhone)
            const fresh = await this.stateMachine.getOrCreate(conv.merchantId, conv.channel, conv.customerPhone, conv.id)
            conv = await this.stateMachine.transition(fresh, 'AWAITING_PAYMENT', {
              checkoutStage: 'payment_pending',
              orderId: (orderConv.context as { orderId?: string }).orderId,
            })
          }
          await this.sendCustomerReply(conv, messageId, decision.type, decision.customerReply)
        } catch (err) {
          await this.redis.del(key)
          throw err
        }
        return
      }

      case 'REQUEST_PAYMENT':
        await this.sendCustomerReply(conv, messageId, decision.type, decision.customerReply)
        return

      case 'START_PAYMENT_REVIEW':
        await this.startPaymentReview(conv, decision)
        await this.sendCustomerReply(conv, messageId, decision.type, decision.customerReply)
        return

      case 'START_FULFILLMENT':
        await this.sendCustomerReply(conv, messageId, decision.type, decision.customerReply)
        return
    }
  }

  private async sendCustomerReply(conv: ConversationRecord, messageId: string, decisionType: string, message: string): Promise<void> {
    const key = `reply:${conv.id}:${messageId}:${decisionType}:${hash(message)}`
    const acquired = await this.redis.set(key, '1', 'EX', 24 * 60 * 60, 'NX')
    if (!acquired) return
    await this.stateMachine.updateContext(conv, { recentBotReply: message })
    await this.nats.publish({
      subject: SUBJECTS.NOTIFICATION_SEND,
      merchantId: conv.merchantId,
      to: conv.customerPhone,
      channel: conv.channel as 'whatsapp',
      message,
    } satisfies NotificationSendEvent)
  }

  private async sendMerchantAlert(conv: ConversationRecord, message: string, cart: CartItem[]): Promise<void> {
    const key = `merchant_alert:${conv.id}:${hash(message)}:${hash(activeCartHash(cart))}`
    const acquired = await this.redis.set(key, '1', 'EX', 30 * 60, 'NX')
    if (!acquired) return
    const merchant = await this.db.query.merchants.findFirst({
      where: eq(merchants.id, conv.merchantId),
      columns: { phone: true },
    })
    if (!merchant?.phone) return
    await this.nats.publish({
      subject: SUBJECTS.NOTIFICATION_SEND,
      merchantId: conv.merchantId,
      to: merchant.phone,
      channel: 'whatsapp',
      message,
    } satisfies NotificationSendEvent)
  }

  private async startPaymentReview(conv: ConversationRecord, decision: Extract<BotDecision, { type: 'START_PAYMENT_REVIEW' }>): Promise<void> {
    const proofKey = decision.proofHashOrDone ?? decision.proofUrl ?? 'done'
    const key = `payment_review:${decision.orderId}:${hash(proofKey)}`
    const acquired = await this.redis.set(key, '1', 'EX', 24 * 60 * 60, 'NX')
    if (!acquired) return

    const order = await this.db.query.orders.findFirst({
      where: eq(orders.id, decision.orderId),
      columns: { total: true },
    })
    if (!order) return

    await this.db.insert(payments).values({
      orderId: decision.orderId,
      merchantId: conv.merchantId,
      amount: order.total,
      status: 'PENDING',
      screenshotUrl: decision.proofUrl,
      screenshotHash: decision.proofHashOrDone === 'done' ? undefined : decision.proofHashOrDone,
      rawOcrData: { source: decision.proofHashOrDone === 'done' ? 'customer_done_reply' : 'orchestrator' },
    })

    const merchant = await this.db.query.merchants.findFirst({
      where: eq(merchants.id, conv.merchantId),
      columns: { phone: true, config: true },
    })
    if (!merchant?.phone) return
    const taskId = await this.pending?.upsert(conv.merchantId, 'PENDING_PAYMENT_REVIEW', {
      orderId: decision.orderId,
      reason: 'mono_required',
      received: parseFloat(order.total),
      expected: parseFloat(order.total),
    })
    if (taskId) {
      const token = createHash('sha256').update(`${taskId}:${Date.now()}`).digest('hex')
      const tokenHash = hash(token)
      const actionUrl = `${appConfig.DASHBOARD_URL}/actions/payment/${token}`
      await this.db.update(agentTasks)
        .set({ actionTokenHash: tokenHash, expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000) })
        .where(eq(agentTasks.id, taskId))
      await this.pending?.update(conv.merchantId, 'PENDING_PAYMENT_REVIEW', { actionToken: token, actionUrl })
    }

    await this.nats.publish({
      subject: SUBJECTS.NOTIFICATION_SEND,
      merchantId: conv.merchantId,
      to: merchant.phone,
      channel: 'whatsapp',
      message: `Customer says payment is done for order ${decision.orderId.slice(-8).toUpperCase()}. Please review.`,
    } satisfies NotificationSendEvent)
  }
}
