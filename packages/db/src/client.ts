import { drizzle } from 'drizzle-orm/node-postgres'
import { Pool } from 'pg'
import * as schema from './schema/index'

let pool: Pool | null = null
let db: ReturnType<typeof drizzle<typeof schema>> | null = null

export function getDb(databaseUrl: string) {
  if (db) return db

  pool = new Pool({
    connectionString: databaseUrl,
    max: 3,                    // was 20 — 20 open connections prevent Neon from ever suspending
    idleTimeoutMillis: 10_000, // release idle connections quickly so Neon can sleep
    connectionTimeoutMillis: 5_000,
  })

  db = drizzle(pool, { schema })
  return db
}

export async function closeDb() {
  if (pool) {
    await pool.end()
    pool = null
    db = null
  }
}

export type Db = ReturnType<typeof getDb>