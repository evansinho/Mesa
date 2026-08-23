import type { Config } from 'jest'

// Root Jest config uses the `projects` pattern so each workspace runs with
// its own config (and its own moduleNameMapper, setup files, etc.) while
// `pnpm test` at root runs everything.
//
// Integration tests live in `**/*.integration.test.ts` and are skipped unless
// MESA_RUN_INTEGRATION=1 is set. Unit tests (`**/*.test.ts`) always run.
//
// Integration tests share a single Postgres + Redis instance. Running suites
// from different projects in parallel causes beforeEach TRUNCATEs to collide,
// producing FK violations and deadlocks. Force serial execution when the
// integration flag is on; unit tests are fast enough to stay parallel.
const runIntegration = process.env.MESA_RUN_INTEGRATION === '1'

const config: Config = {
  ...(runIntegration ? { maxWorkers: 1 } : {}),
  projects: [
    '<rootDir>/apps/worker',
    '<rootDir>/apps/gateway',
    '<rootDir>/apps/api',
    '<rootDir>/packages/ai',
    '<rootDir>/packages/whatsapp',
    '<rootDir>/packages/messaging',
    '<rootDir>/packages/nats',
  ],
}

export default config