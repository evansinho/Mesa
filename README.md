# Mesa

Financial operating system for African SMEs, starting with WhatsApp commerce automation.

## What This Repo Contains
- **Gateway**: WhatsApp webhook ingestion + routing (`apps/gateway`)
- **Worker**: NLP, order/payment handling, event processing (`apps/worker`)
- **API**: Merchant/order/analytics APIs (`apps/api`)
- **Dashboard**: Merchant web UI (`apps/dashboard`)
- **Packages**: shared config, DB schema, NATS client, AI utils

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

## Env
Create a `.env` with at least:
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

Optional:
- `SENTRY_DSN`
- `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_BUCKET_NAME`
- `MONO_SECRET_KEY`

## Ops
- Health checks: `/health` and `/ready`
- Metrics:
  - Gateway: `:9464/metrics`
  - API: `:9465/metrics`
  - Worker: `:9466/metrics`

## Docs
- `idea/mesa_design_doc.md`
- `idea/tasks.md`
- `idea/runbook.md`
- `idea/observability.md`
- `idea/db-backup.md`
