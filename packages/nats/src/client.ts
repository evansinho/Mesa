import {
  connect,
  NatsConnection,
  JetStreamClient,
  JetStreamManager,
  StringCodec,
  AckPolicy,
  DeliverPolicy,
  RetentionPolicy,
  StorageType,
} from 'nats'

const sc = StringCodec()

const STREAM_NAME = 'MESA'
const STREAM_SUBJECTS = ['mesa.>']
const MESSAGE_TTL_NS = 7 * 24 * 60 * 60 * 1e9

const DLQ_STREAM_NAME = 'MESA_DLQ'
const DLQ_SUBJECT_PREFIX = 'mesa.dlq'
const DLQ_TTL_NS = 30 * 24 * 60 * 60 * 1e9

const MAX_DELIVER = 5

export class MesaNatsClient {
  private nc!: NatsConnection
  private js!: JetStreamClient
  private jsm!: JetStreamManager

  async connect(url: string): Promise<void> {
    this.nc = await connect({ servers: url })
    this.js = this.nc.jetstream()
    this.jsm = await this.nc.jetstreamManager()

    await this.ensureStream()

    // Drain handler for graceful shutdown
    this.nc.closed().then(() => {
      console.log('NATS connection closed')
    })
  }

  private async ensureStream(): Promise<void> {
    try {
      await this.jsm.streams.info(STREAM_NAME)
    } catch {
      await this.jsm.streams.add({
        name: STREAM_NAME,
        subjects: STREAM_SUBJECTS,
        retention: RetentionPolicy.Limits,
        storage: StorageType.File,
        max_age: MESSAGE_TTL_NS,
        num_replicas: 1,
      })
      console.log(`Created NATS stream: ${STREAM_NAME}`)
    }

    try {
      await this.jsm.streams.info(DLQ_STREAM_NAME)
    } catch {
      await this.jsm.streams.add({
        name: DLQ_STREAM_NAME,
        subjects: [`${DLQ_SUBJECT_PREFIX}.>`],
        retention: RetentionPolicy.Limits,
        storage: StorageType.File,
        max_age: DLQ_TTL_NS,
        num_replicas: 1,
      })
      console.log(`Created NATS stream: ${DLQ_STREAM_NAME}`)
    }
  }

  async publish<T extends { subject: string }>(event: T): Promise<void> {
    const { subject, ...payload } = event
    await this.js.publish(subject, sc.encode(JSON.stringify(payload)))
  }

  async subscribe<T>(
    subject: string,
    durableName: string,
    handler: (data: T, subject: string) => Promise<void>
  ): Promise<void> {
    // Create or bind to durable consumer
    try {
      await this.jsm.consumers.info(STREAM_NAME, durableName)
    } catch {
      await this.jsm.consumers.add(STREAM_NAME, {
        durable_name: durableName,
        filter_subject: subject,
        ack_policy: AckPolicy.Explicit,
        deliver_policy: DeliverPolicy.All,
        max_deliver: MAX_DELIVER,
        ack_wait: 30 * 1e9,
      })
    }

    const consumer = await this.js.consumers.get(STREAM_NAME, durableName)
    const messages = await consumer.consume()

    for await (const msg of messages) {
      try {
        const data = JSON.parse(sc.decode(msg.data)) as T
        await handler(data, msg.subject)
        msg.ack()
      } catch (err) {
        const deliveryCount = msg.info.deliveryCount
        const isLastAttempt = deliveryCount >= MAX_DELIVER

        if (isLastAttempt) {
          try {
            const dlqPayload = {
              _originalSubject: msg.subject,
              _error: err instanceof Error ? err.message : String(err),
              _failedAt: new Date().toISOString(),
              _deliveryCount: deliveryCount,
              ...JSON.parse(sc.decode(msg.data)),
            }
            await this.js.publish(
              `${DLQ_SUBJECT_PREFIX}.${msg.subject}`,
              sc.encode(JSON.stringify(dlqPayload)),
            )
          } catch (dlqErr) {
            console.error(`Failed to publish to DLQ for ${msg.subject}:`, dlqErr)
          }
          msg.ack()
        } else {
          console.error(`Error processing message on ${msg.subject} (attempt ${deliveryCount}/${MAX_DELIVER}):`, err)
          msg.nak(30_000)
        }
      }
    }
  }

  async drain(): Promise<void> {
    await this.nc.drain()
  }

  async close(): Promise<void> {
    await this.nc.close()
  }

  get isConnected(): boolean {
    return !this.nc.isClosed()
  }
}
