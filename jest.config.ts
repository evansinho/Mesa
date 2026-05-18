import type { Config } from 'jest'

// Root Jest config uses the `projects` pattern so each workspace runs with
// its own config (and its own moduleNameMapper, setup files, etc.) while
// `pnpm test` at root runs everything.
//
// Integration tests live in `**/*.integration.test.ts` and are skipped unless
// MESA_RUN_INTEGRATION=1 is set. Unit tests (`**/*.test.ts`) always run.
const config: Config = {
  projects: [
    '<rootDir>/apps/worker',
    '<rootDir>/apps/gateway',
    '<rootDir>/apps/api',
    '<rootDir>/packages/ai',
    '<rootDir>/packages/whatsapp',
    '<rootDir>/packages/messaging',
  ],
}

export default config