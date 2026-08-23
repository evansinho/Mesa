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

const DLQ_SUBJECT_PREFIX = 'mesa.dlq'

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

    // DLQ messages use mesa.dlq.* subjects, which are already captured by
    // the MESA stream's mesa.> subject. A separate DLQ stream would overlap
    // and JetStream rejects overlapping stream subjects.
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
          const dlqPayload = {
            _originalSubject: msg.subject,
            _error: err instanceof Error ? err.message : String(err),
            _failedAt: new Date().toISOString(),
            _deliveryCount: deliveryCount,
            ...JSON.parse(sc.decode(msg.data)),
          }
          try {
            await this.js.publish(
              `${DLQ_SUBJECT_PREFIX}.${msg.subject}`,
              sc.encode(JSON.stringify(dlqPayload)),
            )
            msg.ack()
          } catch (dlqErr) {
            // If the DLQ publish itself fails, acking anyway means this
            // message is gone forever with no DLQ copy and no successful
            // handler — total, silent, unrecoverable loss. Leaving it
            // un-acked keeps it visible in the consumer's pending/ack-floor
            // stats instead — a follow-up deploy or manual nak can still
            // recover it, whereas an ack cannot be undone.
            console.error(JSON.stringify({
              level: 'error',
              msg: 'Failed to publish to DLQ — leaving message un-acked rather than losing it silently',
              subject: msg.subject,
              deliveryCount,
              dlqErr: dlqErr instanceof Error ? dlqErr.message : String(dlqErr),
              originalErr: err instanceof Error ? err.message : String(err),
            }))
          }
        } else {
          console.error(`Error processing message on ${msg.subject} (attempt ${deliveryCount}/${MAX_DELIVER}):`, err)
          msg.nak(30_000)
        }
      }
    }
  }

  // Non-destructive peek at how many messages currently sit in the dead
  // letter queue. A DLQ entry means a message already exhausted all
  // MAX_DELIVER retries and will never process on its own — the only way
  // anyone finds out otherwise is by noticing a symptom downstream (a
  // merchant reporting "Mesa didn't respond") and manually connecting to
  // JetStream to look, which is how a 5-day, 49-message backlog went
  // unnoticed. Uses a durable consumer that's never actually consumed from
  // (no .consume()/.fetch() call anywhere) purely so num_pending reflects
  // the full DLQ backlog rather than "since last check".
  private static readonly DLQ_MONITOR_CONSUMER = 'dlq-monitor'

  async getDlqDepth(): Promise<number> {
    try {
      await this.jsm.consumers.info(STREAM_NAME, MesaNatsClient.DLQ_MONITOR_CONSUMER)
    } catch {
      await this.jsm.consumers.add(STREAM_NAME, {
        durable_name: MesaNatsClient.DLQ_MONITOR_CONSUMER,
        filter_subjects: [`${DLQ_SUBJECT_PREFIX}.>`],
        ack_policy: AckPolicy.None,
        deliver_policy: DeliverPolicy.All,
      })
    }
    const info = await this.jsm.consumers.info(STREAM_NAME, MesaNatsClient.DLQ_MONITOR_CONSUMER)
    return info.num_pending
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
