import type { Config } from 'jest'

// Shared base config consumed by each workspace's jest.config.ts.
// Keeps moduleNameMapper + transform consistent so behavior is identical
// across packages.
export function createJestConfig(rootDir: string, overrides: Config = {}): Config {
  const runIntegration = process.env.MESA_RUN_INTEGRATION === '1'

  return {
    rootDir,
    testEnvironment: 'node',
    // Load .env.test before any module is imported — must run before
    // @mesa/config picks up the default .env.
    setupFiles: ['<rootDir>/../../test-helpers/env.ts'],
    testMatch: ['<rootDir>/test/**/*.test.ts'],
    testPathIgnorePatterns: [
      '/node_modules/',
      '/dist/',
      // Integration tests are excluded unless MESA_RUN_INTEGRATION=1.
      ...(runIntegration ? [] : ['\\.integration\\.test\\.ts$']),
    ],
    transform: {
      '^.+\\.tsx?$': [
        '@swc/jest',
        {
          jsc: {
            parser: { syntax: 'typescript', tsx: true },
            target: 'es2022',
          },
          module: { type: 'commonjs' },
        },
      ],
    },
    // Tests import packages by their workspace name (@mesa/foo) but resolve
    // to source, not built dist, so a stale `pnpm build` doesn't hide a real
    // regression. Each workspace overrides if it needs additional aliases.
    moduleNameMapper: {
      '^@mesa/(.+)$': '<rootDir>/../../packages/$1/src',
      // Shared test helpers (factories, DB reset, Redis flush). Lives at
      // <repo>/test-helpers — accessible from any workspace's test files.
      '^@test-helpers/(.+)$': '<rootDir>/../../test-helpers/$1',
    },
    moduleFileExtensions: ['ts', 'tsx', 'js', 'mjs', 'cjs', 'json'],
    clearMocks: true,
    testTimeout: runIntegration ? 30000 : 5000,
    ...overrides,
  }
}