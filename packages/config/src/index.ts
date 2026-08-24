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
  WHATSAPP_WABA_ID: z.string().optional(),
  WHATSAPP_WEBHOOK_VERIFY_TOKEN: z.string(),
  WHATSAPP_APP_SECRET: z.string(),
  WHATSAPP_LOGIN_TEMPLATE_NAME: z.string().optional(),
  WHATSAPP_LOGIN_TEMPLATE_LANGUAGE: z.string().default('en_US'),
  WHATSAPP_WELCOME_TEMPLATE_NAME: z.string().optional(),

  META_APP_ID: z.string().optional(),
  META_APP_SECRET: z.string().optional(),
  META_REDIRECT_URI: z.string().optional(),
  META_INSTAGRAM_REDIRECT_URI: z.string().optional(),
  // Falls back to WHATSAPP_WEBHOOK_VERIFY_TOKEN when unset — same Meta app
  // token often covers both webhook subscriptions, but a distinct one can
  // be configured.
  INSTAGRAM_WEBHOOK_VERIFY_TOKEN: z.string().optional(),
  // Instagram API with Instagram Login creates its own companion "Instagram
  // app" with a distinct ID/secret from the parent Meta app (META_APP_ID) —
  // used for the OAuth authorize/token-exchange flow and (possibly) webhook
  // signature verification. Never conflate with META_APP_ID/META_APP_SECRET.
  INSTAGRAM_APP_ID: z.string().optional(),
  INSTAGRAM_APP_SECRET: z.string().optional(),

  PAYSTACK_SECRET_KEY: z.string(),
  PAYSTACK_STARTER_PLAN_CODE: z.string().optional(),
  PAYSTACK_GROWTH_PLAN_CODE: z.string().optional(),
  PAYSTACK_BUSINESS_PLAN_CODE: z.string().optional(),
  PAYSTACK_CALLBACK_URL: z.string().url().optional(),

  INTERNAL_API_KEY: z.string(),

  SENTRY_DSN: z.string().optional(),

  MONO_SECRET_KEY: z.string().optional(),
  MONO_WEBHOOK_SECRET: z.string().optional(),

  // Delivery dispatch. Mesa owns one platform-level account per provider —
  // not per-merchant credentials, unlike Mono — so these are optional and
  // gated by DELIVERY_INTEGRATIONS_ENABLED rather than tied to any single
  // merchant's setup. FEZ covers nationwide/interstate; Kwik is same-city
  // (Lagos/Abuja) on-demand only. See resolveProvider in
  // apps/worker/src/delivery/resolver.ts for the selection rule.
  FEZ_API_BASE_URL: z.string().url().default('https://apisandbox.fezdelivery.co/v1'),
  FEZ_AUTH_TOKEN: z.string().optional(),
  // Also used to verify inbound webhook signatures (HMAC-SHA256 of
  // orderNumber+status+timestamp) — FEZ has no separate webhook secret.
  FEZ_SECRET_KEY: z.string().optional(),
  // Kwik has no static API key — auth is a session login (email+password)
  // that returns a short-lived access token, cached and refreshed by the
  // adapter itself rather than configured directly.
  KWIK_API_BASE_URL: z.string().url().optional(),
  KWIK_VENDOR_EMAIL: z.string().optional(),
  KWIK_VENDOR_PASSWORD: z.string().optional(),
  // Optional (not defaulted) so fulfilment.handler.ts's call-time
  // `config.X ?? process.env.X` check — the same pattern used for
  // FEZ/Kwik credentials above — lets tests toggle this per-test via
  // process.env without needing to reload the config module.
  DELIVERY_INTEGRATIONS_ENABLED: z.enum(['true', 'false']).optional(),

  R2_ACCOUNT_ID: z.string().optional(),
  R2_ACCESS_KEY_ID: z.string().optional(),
  R2_SECRET_ACCESS_KEY: z.string().optional(),
  R2_BUCKET_NAME: z.string().optional(),
  R2_ENDPOINT: z.string().optional(),
  R2_PUBLIC_URL: z.string().url().optional(),

  DASHBOARD_URL: z.string().url().default('http://localhost:3000'),
  // Public host for merchant tracking links (GET /l/:slug) — needs an
  // absolute, publicly-reachable domain since these links are published on
  // TikTok/Instagram/Facebook bios, not just used internally.
  API_PUBLIC_URL: z.string().url().default('http://localhost:3002'),
GATEWAY_PORT: z.coerce.number().default(3001),
  API_PORT: z.coerce.number().default(3002),
  WORKER_PORT: z.coerce.number().default(3003),

  // outbox publisher. 'off' = publisher does not run (default; preserves
  // existing behavior). 'shadow' = polls and logs what it would publish but
  // does not mark rows published or emit to NATS — used to verify writes are
  // accumulating correctly. 'active' = polls, publishes to NATS, marks rows
  // published. ACTIVE mode requires removing the direct nats.publish calls in
  // handlers first; otherwise events fire twice. See idea/runbook.md §5.
  OUTBOX_MODE: z.enum(['off', 'shadow', 'active']).default('active'),

  // Lets a Meta App Review reviewer log into a dedicated, real (but
  // otherwise-empty) test merchant without receiving a WhatsApp OTP —
  // reviewers can't retrieve a code sent to a number they don't hold.
  // Scoped to exactly one phone+code pair; unset in every environment
  // where reviewer access isn't needed, which disables the path entirely.
  APP_REVIEW_TEST_PHONE: z.string().optional(),
  APP_REVIEW_TEST_CODE: z.string().optional(),
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
