import { z } from 'zod'
import dotenv from 'dotenv'
import path from 'path'
import fs from 'fs'

function findEnvRoot(startDir: string): string | null {
  let dir = startDir
  while (true) {
    const candidate = path.join(dir, '.env')
    if (fs.existsSync(candidate)) return dir
    const parent = path.dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  return null
}

const startDir = process.env.INIT_CWD || process.cwd()
const envRoot = findEnvRoot(startDir)

const candidates = envRoot
  ? [
      path.join(envRoot, '.env.local'),
      path.join(envRoot, '.env'),
      path.join(envRoot, `.env.${process.env.NODE_ENV ?? 'development'}`),
    ]
  : []

let loaded = false
for (const p of candidates) {
  if (fs.existsSync(p)) {
    dotenv.config({ path: p })
    loaded = true
    break
  }
}

if (!loaded) {
  dotenv.config()
}

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),

  DATABASE_URL: z.string().url(),
  REDIS_URL: z.string().url(),
  NATS_URL: z.string(),

  ANTHROPIC_API_KEY: z.string(),

  WHATSAPP_ACCESS_TOKEN: z.string(),
  WHATSAPP_PHONE_NUMBER_ID: z.string(),
  WHATSAPP_WEBHOOK_VERIFY_TOKEN: z.string(),
  WHATSAPP_APP_SECRET: z.string(),

  META_APP_ID: z.string().optional(),
  META_APP_SECRET: z.string().optional(),
  META_REDIRECT_URI: z.string().optional(),
  META_INSTAGRAM_REDIRECT_URI: z.string().optional(),

  PAYSTACK_SECRET_KEY: z.string(),

  INTERNAL_API_KEY: z.string(),

  SENTRY_DSN: z.string().optional(),

  MONO_SECRET_KEY: z.string().optional(),

  R2_ACCOUNT_ID: z.string().optional(),
  R2_ACCESS_KEY_ID: z.string().optional(),
  R2_SECRET_ACCESS_KEY: z.string().optional(),
  R2_BUCKET_NAME: z.string().optional(),
  R2_ENDPOINT: z.string().optional(),

  DASHBOARD_URL: z.string().url().default('http://localhost:3000'),

  GATEWAY_PORT: z.coerce.number().default(3001),
  API_PORT: z.coerce.number().default(3002),
  WORKER_PORT: z.coerce.number().default(3003),
})

export type Config = z.infer<typeof envSchema>

function loadConfig(): Config {
  const result = envSchema.safeParse(process.env)
  if (!result.success) {
    const issues = result.error.errors
      .map(e => `  ${e.path.join('.')}: ${e.message}`)
      .join('\n')
    throw new Error(`Invalid environment configuration:\n${issues}`)
  }
  return result.data
}

export const config = loadConfig()
