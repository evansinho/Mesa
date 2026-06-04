import { createHash, randomBytes } from 'crypto'
import type { Db } from '@mesa/db'
import { authSessions } from '@mesa/db'
import { config } from '@mesa/config'

export async function createSessionHeaders(db: Db, merchantId: string): Promise<Record<string, string>> {
  const token = randomBytes(32).toString('hex')
  await db.insert(authSessions).values({
    merchantId,
    sessionHash: createHash('sha256').update(token).digest('hex'),
    expiresAt: new Date(Date.now() + 60 * 60 * 1000),
  })
  return { Authorization: `Bearer ${token}` }
}

export function internalAuthHeaders(): Record<string, string> {
  return { 'x-mesa-api-key': config.INTERNAL_API_KEY }
}
