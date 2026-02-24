# Migrations

Workflow:
1. Update schema in `packages/db/src/schema/index.ts`.
2. Generate migration: `pnpm db:generate`.
3. Apply migration: `pnpm db:migrate`.

Baseline migration is `0000_initial.sql`.
