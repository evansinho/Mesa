import type { Config } from 'jest'
// @ts-ignore - Jest loads this CommonJS wrapper before SWC handles TypeScript.
import base from '../../jest.base.js'

const { createJestConfig } = base as {
  createJestConfig: (rootDir: string, overrides?: Config) => Config
}

export default createJestConfig(`${process.cwd()}/apps/internal`, {
  displayName: '@mesa/internal',
  // The only project in the workspace that renders components, so it is the
  // only one that needs a DOM.
  testEnvironment: 'jsdom',
  testMatch: ['<rootDir>/test/**/*.test.tsx'],
  // Appends to the base config's entry rather than replacing it, so the
  // shared connection teardown still runs.
  setupFilesAfterEnv: [
    '<rootDir>/../../test-helpers/close-connections.ts',
    '<rootDir>/test/setup.ts',
  ],
  moduleNameMapper: {
    '^@mesa/(.+)$': '<rootDir>/../../packages/$1/src',
    // Vite handles CSS; jest does not need to.
    '\\.css$': '<rootDir>/test/style-stub.ts',
  },
  // The shared base emits classic JSX, which needs React in scope. This is the
  // only project that renders components, and its source uses the automatic
  // runtime like the Vite build does, so it overrides the transform rather
  // than making every file import React.
  transform: {
    '^.+\\.tsx?$': [
      '@swc/jest',
      {
        jsc: {
          parser: { syntax: 'typescript', tsx: true },
          target: 'es2022',
          transform: { react: { runtime: 'automatic' } },
        },
        module: { type: 'commonjs' },
      },
    ],
  },
})
