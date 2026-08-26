import './env'
import { sql } from 'drizzle-orm'
import { getDb, closeDb, type Db } from '@mesa/db'

let cached: Db | null = null

export function getTestDb(): Db {
  if (!cached) {
    if (!process.env.DATABASE_URL) {
      throw new Error('DATABASE_URL not set — load .env.test or set MESA_RUN_INTEGRATION manually')
    }
    cached = getDb(process.env.DATABASE_URL)
  }
  return cached
}

// Order matters: child tables before parent so FK CASCADE does the work.
// TRUNCATE ... RESTART IDENTITY CASCADE wipes all the listed tables in one
// command; faster than per-table deletes and resets sequences.
const ALL_TABLES = [
  'ai_usage',
  'billing_events',
  'subscriptions',
  'notification_failures',
  'agent_tasks',
  'message_templates',
  'inventory_events',
  'payments',
  'order_items',
  'orders',
  'conversations',
  'status_posts',
  'products',
  'merchant_channels',
  'platform_instagram_account',
  'auth_sessions',
  'auth_magic_links',
  'domain_events',
  // Commercial layer — truncated before merchants because prospects
  // references it (CASCADE would handle it, but ordering keeps intent clear).
  'staff_notifications',
  'merchant_lifecycle_events',
  'staff_audit_log',
  'prospect_activities',
  'prospects',
  'staff_sessions',
  'staff',
  'merchants',
]

export async function resetDb(): Promise<void> {
  const db = getTestDb()
  for (const table of ALL_TABLES) {
    await db.execute(sql.raw(`TRUNCATE TABLE ${table} RESTART IDENTITY CASCADE`))
  }
}

export async function closeTestDb(): Promise<void> {
  if (cached) {
    await closeDb()
    cached = null
  }
}
