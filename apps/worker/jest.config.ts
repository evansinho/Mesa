import type { Config } from 'jest'
// @ts-ignore - Jest loads this CommonJS wrapper before SWC handles TypeScript.
import base from '../../jest.base.js'

const { createJestConfig } = base as {
  createJestConfig: (rootDir: string, overrides?: Config) => Config
}

const runIntegration = process.env.MESA_RUN_INTEGRATION === '1'
const runNlpEvals = process.env.MESA_RUN_NLP_EVALS === '1'
const runE2eEvals = process.env.MESA_RUN_E2E_EVALS === '1'

export default createJestConfig(`${process.cwd()}/apps/worker`, {
  displayName: '@mesa/worker',
  testMatch: [
    '<rootDir>/test/**/*.test.ts',
    ...(runIntegration ? ['<rootDir>/test/evals/conversation.eval.ts'] : []),
    ...(runNlpEvals ? ['<rootDir>/test/evals/nlp.eval.ts'] : []),
    ...(runE2eEvals ? ['<rootDir>/test/evals/e2e.eval.ts'] : []),
  ],
})
