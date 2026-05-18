import './env'
import Redis from 'ioredis'

let cached: Redis | null = null

export function getTestRedis(): Redis {
  if (!cached) {
    if (!process.env.REDIS_URL) {
      throw new Error('REDIS_URL not set — load .env.test or set MESA_RUN_INTEGRATION manually')
    }
    cached = new Redis(process.env.REDIS_URL, { lazyConnect: false })
  }
  return cached
}

export async function flushTestRedis(): Promise<void> {
  await getTestRedis().flushdb()
}

export async function closeTestRedis(): Promise<void> {
  if (cached) {
    cached.disconnect()
    cached = null
  }
}