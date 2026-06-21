import type { Db } from '@mesa/db'
import { products } from '@mesa/db'
import type { MesaNatsClient } from '@mesa/nats'
import type { Redis } from 'ioredis'
import { and, eq } from 'drizzle-orm'
import type { ConversationStateMachine } from '../conversation/state-machine'
import type { OrderHandler } from '../handlers/order.handler'
import type { PendingDecisions } from '../handlers/pending-decisions'
import { legacyContextToBotRuntime } from './runtime-context'
import { IntentExtractor } from './intent-extractor'
import { CheckoutEngine } from './checkout-engine'
import { SideEffectExecutor } from './side-effect-executor'

type ConversationRecord = Awaited<ReturnType<ConversationStateMachine['getOrCreate']>>

export class BotOrchestrator {
  private extractor = new IntentExtractor()
  private engine = new CheckoutEngine()
  private executor: SideEffectExecutor

  constructor(
    private db: Db,
    redis: Redis,
    nats: MesaNatsClient,
    private stateMachine: ConversationStateMachine,
    orderHandler?: OrderHandler,
    pending?: PendingDecisions,
  ) {
    this.executor = new SideEffectExecutor(db, redis, nats, stateMachine, orderHandler, pending)
  }

  async handleCustomerText(input: {
    conv: ConversationRecord
    text: string
    messageId: string
    merchantName?: string | null
  }): Promise<void> {
    let conv = await this.stateMachine.appendMessage(input.conv, 'customer', input.text)
    const catalog = await this.db.query.products.findMany({
      where: and(eq(products.merchantId, conv.merchantId), eq(products.active, true)),
    })
    const runtime = legacyContextToBotRuntime(conv.context)
    const intent = this.extractor.extract(input.text, catalog)
    const decision = this.engine.decide({
      runtime,
      intent,
      catalog,
      merchantName: input.merchantName,
      messageId: input.messageId,
    })
    await this.executor.execute(conv, input.messageId, decision, {
      checkoutStageBefore: runtime.checkoutStage,
      intentType: intent.type,
    })
  }
}
