# Mesa

Financial operating system for African SMEs, starting with WhatsApp commerce automation.

## What This Repo Contains
- **Gateway**: WhatsApp webhook ingestion + routing (`apps/gateway`)
- **Worker**: NLP, order/payment handling, event processing (`apps/worker`)
- **API**: Merchant/order/analytics APIs (`apps/api`)
- **Dashboard**: Merchant web UI (`apps/dashboard`)
- **Internal**: Staff sales/ops console (`apps/internal`)
- **Packages**: shared config, DB schema, NATS client, AI utils

## Architecture

Inbound WhatsApp messages hit **Gateway**, which verifies the webhook and
publishes an event to **NATS**. **Worker** consumes that event, runs NLP/order/
payment handling against Postgres, and emits outbound WhatsApp sends. **API**
serves the reads and writes that the **Dashboard** and internal console call
directly over HTTP — it has no NATS client, so anything API-originated that
needs to reach WhatsApp goes through a DB row Worker polls, not a direct
publish. `packages/db/src/schema/index.ts` is the schema source of truth for
all four services.

## Quick Start

### 1) Install deps
```bash
pnpm install
```

### 2) Start dependencies (Postgres, Redis, NATS)
```bash
pnpm docker:up
```

### 3) Migrate + seed DB
```bash
DATABASE_URL=postgresql://mesa:mesa@localhost:5432/mesa pnpm db:migrate
DATABASE_URL=postgresql://mesa:mesa@localhost:5432/mesa pnpm db:seed
```

### 4) Run services (dev)
```bash
pnpm dev
```

## Running tests

- `pnpm test` — unit tests only (no external services needed).
- `pnpm test:integration:full` — the full integration lifecycle in one
  command: spins up Postgres/Redis/NATS via `docker-compose.test.yml`, runs
  migrations, runs the integration suite, tears the containers back down
  (even on failure). No manual `DATABASE_URL` export needed beyond this.
- `pnpm test:integration:up` / `test:integration` / `test:integration:down`
  — the same lifecycle as three separate steps, useful when iterating on a
  single test file against containers you want to keep running between runs.
- A few slower suites are opt-in via env flag and skipped otherwise:
  `MESA_RUN_NLP_EVALS=1` and `MESA_RUN_E2E_EVALS=1`.

## Env

See `.env.example` for the full list with inline comments. At minimum:
- `DATABASE_URL`
- `REDIS_URL`
- `NATS_URL`
- `ANTHROPIC_API_KEY`
- `WHATSAPP_ACCESS_TOKEN`
- `WHATSAPP_PHONE_NUMBER_ID`
- `WHATSAPP_WEBHOOK_VERIFY_TOKEN`
- `WHATSAPP_APP_SECRET`
- `PAYSTACK_SECRET_KEY`
- `INTERNAL_API_KEY`

Everything else in `.env.example` (Meta Embedded Signup, Instagram, Mono,
delivery dispatch via FEZ/Kwik, R2, Sentry, Paystack plan codes, CORS, App
Review bypass) is optional and gates the feature it backs off when unset.

## Ops
- Health checks: `/health` and `/ready`
- Metrics:
  - Gateway: `:9464/metrics`
  - API: `:9465/metrics`
  - Worker: `:9466/metrics`
