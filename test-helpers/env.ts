// Load .env.test from the repo root before any other imports that may read
// process.env (e.g. @mesa/config). Test files should import this FIRST when
// they need the test environment loaded.
import path from 'path'
import dotenv from 'dotenv'

// This file lives at <repo>/test-helpers/env.ts so the repo root is one
// directory up.
dotenv.config({ path: path.join(__dirname, '../.env.test') })

// Fallback values for every env key @mesa/config requires. Applied only when
// the key isn't already set (so .env.test and CI's env: block win). Keeps
// pure-unit tests passing on CI runners and fresh checkouts without anyone
// needing to populate .env.test.
const TEST_FALLBACKS: Record<string, string> = {
  NODE_ENV: 'test',
  DATABASE_URL: 'postgres://mesa:mesa@localhost:5433/mesa_test',
  REDIS_URL: 'redis://localhost:6380',
  NATS_URL: 'nats://localhost:4223',
  ANTHROPIC_API_KEY: 'test-anthropic-key',
  WHATSAPP_ACCESS_TOKEN: 'test-wa-token',
  WHATSAPP_PHONE_NUMBER_ID: 'test-phone-id',
  WHATSAPP_WEBHOOK_VERIFY_TOKEN: 'test-verify-token',
  WHATSAPP_APP_SECRET: 'test-app-secret',
  PAYSTACK_SECRET_KEY: 'test-paystack',
  INTERNAL_API_KEY: 'test-internal',
}

for (const [key, value] of Object.entries(TEST_FALLBACKS)) {
  if (!process.env[key]) {
    process.env[key] = value
  }
}