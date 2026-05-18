import type { Db } from '@mesa/db'
import { aiUsage } from '@mesa/db'
import type { Redis } from 'ioredis'

export type SubscriptionTier = 'starter' | 'growth' | 'business'
export type AiModel = 'haiku' | 'sonnet'

// Per-merchant per-day call limits. Spend ceiling is implicit: limit ×
// per-call cost. With current rates that's roughly $0.10/day (starter),
// $1/day (growth), $10/day (business) for NLP-heavy workloads.
const DAILY_LIMITS: Record<SubscriptionTier, number> = {
  starter: 500,
  growth: 5_000,
  business: 50_000,
}

// Rough cost-per-call in USD micros (1 USD = 1_000_000 micros). Used for
// spend dashboards and not for billing. Pair with Anthropic's billing export
// for accurate reconciliation.
const COST_USD_MICROS: Record<AiModel, number> = {
  haiku: 200,
  sonnet: 5_000,
}

const NOTIFY_TTL_SECONDS = 60 * 60 * 24

export interface QuotaResult {
  allowed: boolean
  used: number
  limit: number
  resetAt: Date
}

// Lagos is UTC+1 with no DST. Use that as the "merchant day" boundary so the
// limits roll over at midnight local time, not midnight UTC.
export function lagosDateKey(now = new Date()): string {
  const lagosMs = now.getTime() + 60 * 60 * 1000
  return new Date(lagosMs).toISOString().slice(0, 10)
}

export function nextLagosMidnight(now = new Date()): Date {
  const lagos = new Date(now.getTime() + 60 * 60 * 1000)
  const tomorrow = new Date(Date.UTC(
    lagos.getUTCFullYear(),
    lagos.getUTCMonth(),
    lagos.getUTCDate() + 1,
  ))
  return new Date(tomorrow.getTime() - 60 * 60 * 1000)
}

export class AiQuota {
  constructor(
    private db: Db,
    private redis: Redis,
    private log: Pick<Console, 'info' | 'warn' | 'error'> = console,
  ) {}

  // Reserve one AI call against the merchant's daily quota. Returns the
  // post-increment counter and whether the call is allowed. The counter
  // continues to grow past the limit so the rejection rate is observable.
  async checkAndConsume(merchantId: string, tier: SubscriptionTier): Promise<QuotaResult> {
    const limit = DAILY_LIMITS[tier]
    const key = `ai_quota:${merchantId}:${lagosDateKey()}`
    const used = await this.redis.incr(key)
    if (used === 1) {
      // 48h TTL covers timezone slop and gives ops a one-day grace window
      // for reconciliation queries.
      await this.redis.expire(key, 60 * 60 * 48)
    }
    return {
      allowed: used <= limit,
      used,
      limit,
      resetAt: nextLagosMidnight(),
    }
  }

  // Append an ai_usage row. Best-effort — never throws back to the caller,
  // since logging usage should not block the AI workflow.
  async recordUsage(
    merchantId: string,
    model: AiModel,
    meta?: { inputTokens?: number; outputTokens?: number },
  ): Promise<void> {
    try {
      await this.db.insert(aiUsage).values({
        merchantId,
        model,
        costUsdMicros: COST_USD_MICROS[model],
        inputTokens: meta?.inputTokens,
        outputTokens: meta?.outputTokens,
      })
    } catch (err) {
      this.log.warn(JSON.stringify({
        level: 'warn',
        msg: 'ai_usage log failed',
        merchantId,
        model,
        err: err instanceof Error ? err.message : String(err),
      }))
    }
  }

  // Returns true once per merchant per day. Used to debounce the
  // "quota exhausted" notification so we don't spam the merchant.
  async shouldNotifyExhaustion(merchantId: string): Promise<boolean> {
    const key = `ai_quota_notified:${merchantId}:${lagosDateKey()}`
    const set = await this.redis.set(key, '1', 'EX', NOTIFY_TTL_SECONDS, 'NX')
    return set === 'OK'
  }
}