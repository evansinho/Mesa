import type { Db } from '@mesa/db'
import { domainEvents } from '@mesa/db'
import type { MesaNatsClient } from '@mesa/nats'
import type { Redis } from 'ioredis'
import { asc, eq, isNull } from 'drizzle-orm'
import { EVENT_TYPE_META } from './event-meta'
import type { OutboxMode } from './event-store'

export type { OutboxMode } from './event-store'

// Adaptive polling: poll fast right after finding work, back off when idle.
// Idle ticks do a single cheap indexed Postgres query and ZERO Redis commands
// (the lock is only touched once there's actual work), so an idle worker
// barely registers on the Redis quota.
const POLL_MIN_MS = 5_000
const POLL_MAX_MS = 60_000
const BATCH_SIZE = 100
const LOCK_KEY = 'outbox:publisher:lock'
const LOCK_TTL_SECONDS = 60

export class OutboxPublisher {
  private timer: NodeJS.Timeout | null = null
  private stopping = false
  private running = false
  private currentInterval = POLL_MIN_MS

  constructor(
    private db: Db,
    private nats: MesaNatsClient,
    private redis: Redis,
    private mode: OutboxMode,
    private log: Pick<Console, 'info' | 'warn' | 'error'> = console,
  ) {}

  start(): void {
    if (this.mode === 'off') {
      this.log.info(JSON.stringify({ level: 'info', msg: 'Outbox publisher disabled', mode: this.mode }))
      return
    }
    this.log.info(JSON.stringify({
      level: 'info',
      msg: 'Outbox publisher started',
      mode: this.mode,
      pollMinMs: POLL_MIN_MS,
      pollMaxMs: POLL_MAX_MS,
      batchSize: BATCH_SIZE,
    }))
    this.scheduleNext()
  }

  async stop(): Promise<void> {
    this.stopping = true
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = null
    }
    // Wait briefly for an in-flight tick to finish so we don't tear down mid-publish.
    for (let i = 0; i < 30 && this.running; i++) {
      await new Promise(resolve => setTimeout(resolve, 100))
    }
  }

  private scheduleNext(): void {
    if (this.stopping) return
    this.timer = setTimeout(() => {
      this.tick()
        .then(published => {
          // Found work → poll fast again. Idle → back off toward POLL_MAX_MS.
          this.currentInterval = published > 0
            ? POLL_MIN_MS
            : Math.min(this.currentInterval * 2, POLL_MAX_MS)
        })
        .catch(err => {
          this.log.error(JSON.stringify({
            level: 'error',
            msg: 'Outbox publisher tick failed',
            err: err instanceof Error ? err.message : String(err),
          }))
        })
        .finally(() => this.scheduleNext())
    }, this.currentInterval)
  }

  private async tick(): Promise<number> {
    // Cheap pre-check in Postgres (indexed by domain_events_unpublished_idx).
    // When there's nothing to publish we skip the Redis lock entirely, so an
    // idle worker spends zero Redis commands per tick.
    const pending = await this.db.query.domainEvents.findFirst({
      where: isNull(domainEvents.publishedAt),
      columns: { id: true },
    })
    if (!pending) return 0

    // Work exists — now take the lock so concurrent replicas don't double-publish.
    const acquired = await this.redis.set(LOCK_KEY, '1', 'EX', LOCK_TTL_SECONDS, 'NX')
    if (acquired !== 'OK') return 0

    this.running = true
    try {
      const rows = await this.db.query.domainEvents.findMany({
        where: isNull(domainEvents.publishedAt),
        orderBy: [asc(domainEvents.createdAt)],
        limit: BATCH_SIZE,
      })

      for (const row of rows) {
        await this.processRow(row)
      }

      if (rows.length > 0) {
        this.log.info(JSON.stringify({
          level: 'info',
          msg: 'Outbox tick complete',
          mode: this.mode,
          batchSize: rows.length,
        }))
      }
      return rows.length
    } finally {
      this.running = false
      await this.redis.del(LOCK_KEY)
    }
  }

  private async processRow(row: typeof domainEvents.$inferSelect): Promise<void> {
    const meta = EVENT_TYPE_META[row.eventType]

    // Event types without a NATS subject (e.g. STATE_CHANGED audit rows) are
    // marked published so the scan doesn't keep returning them. Done in both
    // shadow and active modes — these never publish either way.
    if (!meta) {
      await this.db
        .update(domainEvents)
        .set({ publishedAt: new Date() })
        .where(eq(domainEvents.id, row.id))
      return
    }

    if (this.mode === 'shadow') {
      // Log but do not publish and do not mark published. This lets the
      // operator observe the publisher's view of the world for a verification
      // window before flipping to active. When active is enabled, all rows
      // accumulated during shadow will be published in order.
      this.log.info(JSON.stringify({
        level: 'info',
        msg: 'Outbox shadow: would publish',
        domainEventId: row.id,
        subject: meta.subject,
        aggregateId: row.aggregateId,
        eventType: row.eventType,
      }))
      return
    }

    // Active mode: build the NATS event and publish.
    const stored = row.payload as { v?: number; data?: Record<string, unknown> } | null
    const data = (stored?.data ?? {}) as Record<string, unknown>
    const event = {
      subject: meta.subject,
      ...data,
      // Reconstruct the aggregate-id field from the stored aggregateId so the
      // downstream consumer's event payload matches the direct-publish shape.
      [meta.aggregateField]: data[meta.aggregateField] ?? row.aggregateId,
    } as { subject: string }

    try {
      await this.nats.publish(event)
      await this.db
        .update(domainEvents)
        .set({ publishedAt: new Date() })
        .where(eq(domainEvents.id, row.id))
      this.log.info(JSON.stringify({
        level: 'info',
        msg: 'Outbox published',
        domainEventId: row.id,
        subject: meta.subject,
        aggregateId: row.aggregateId,
      }))
    } catch (err) {
      await this.db
        .update(domainEvents)
        .set({
          publishAttempts: row.publishAttempts + 1,
          lastPublishError: (err instanceof Error ? err.message : String(err)).slice(0, 1000),
        })
        .where(eq(domainEvents.id, row.id))
      this.log.warn(JSON.stringify({
        level: 'warn',
        msg: 'Outbox publish failed',
        domainEventId: row.id,
        subject: meta.subject,
        attempts: row.publishAttempts + 1,
        err: err instanceof Error ? err.message : String(err),
      }))
    }
  }
}