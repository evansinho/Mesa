function createJestConfig(rootDir, overrides = {}) {
  const runIntegration = process.env.MESA_RUN_INTEGRATION === '1'

  return {
    rootDir,
    testEnvironment: 'node',
    setupFiles: ['<rootDir>/../../test-helpers/env.ts'],
    // Always closes the cached Postgres/Redis clients after each test file.
    // A file that forgets leaves the event loop alive, and jest then hangs
    // after every test has passed rather than failing — see the note in
    // close-connections.ts.
    setupFilesAfterEnv: ['<rootDir>/../../test-helpers/close-connections.ts'],
    testMatch: ['<rootDir>/test/**/*.test.ts'],
    testPathIgnorePatterns: [
      '/node_modules/',
      '/dist/',
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
    moduleNameMapper: {
      '^@mesa/(.+)$': '<rootDir>/../../packages/$1/src',
      '^@test-helpers/(.+)$': '<rootDir>/../../test-helpers/$1',
    },
    moduleFileExtensions: ['ts', 'tsx', 'js', 'mjs', 'cjs', 'json'],
    clearMocks: true,
    testTimeout: runIntegration ? 30000 : 5000,
    ...overrides,
  }
}

module.exports = { createJestConfig }
