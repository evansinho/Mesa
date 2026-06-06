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
  'products',
  'merchant_channels',
  'auth_sessions',
  'auth_magic_links',
  'domain_events',
  'merchants',
]

export async function resetDb(): Promise<void> {
  const db = getTestDb()
  await db.execute(sql.raw(`TRUNCATE ${ALL_TABLES.join(', ')} RESTART IDENTITY CASCADE`))
}

export async function closeTestDb(): Promise<void> {
  if (cached) {
    await closeDb()
    cached = null
  }
}
