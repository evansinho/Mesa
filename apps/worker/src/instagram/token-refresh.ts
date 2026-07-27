import type { Db } from '@mesa/db'
import { merchantChannels } from '@mesa/db'
import { eq } from 'drizzle-orm'

// Instagram API with Instagram Login tokens are long-lived (60 days) but not
// permanent. Meta requires a token be at least 24h old before it can be
// refreshed, so 50 days leaves a wide safety margin on both sides.
const REFRESH_AFTER_MS = 50 * 24 * 60 * 60 * 1000

export function isInstagramTokenRefreshDue(tokenRefreshedAt: Date | null, now: Date): boolean {
  if (!tokenRefreshedAt) return true
  return now.getTime() - tokenRefreshedAt.getTime() > REFRESH_AFTER_MS
}

export async function refreshInstagramToken(
  db: Db,
  channel: { id: string; accessToken: string },
  now: Date,
): Promise<void> {
  const url = new URL('https://graph.instagram.com/refresh_access_token')
  url.searchParams.set('grant_type', 'ig_refresh_token')
  url.searchParams.set('access_token', channel.accessToken)

  const res = await fetch(url.toString())
  if (!res.ok) {
    const text = await res.text()
    throw new Error(`Instagram token refresh failed: ${res.status} ${text}`)
  }
  const data = await res.json() as { access_token?: string }
  if (!data.access_token) {
    throw new Error('Instagram token refresh returned no access_token')
  }

  await db.update(merchantChannels)
    .set({ accessToken: data.access_token, tokenRefreshedAt: now })
    .where(eq(merchantChannels.id, channel.id))
}
