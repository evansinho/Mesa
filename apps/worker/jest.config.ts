import { createJestConfig } from '../../jest.base'

const runIntegration = process.env.MESA_RUN_INTEGRATION === '1'
const runNlpEvals = process.env.MESA_RUN_NLP_EVALS === '1'

export default createJestConfig(__dirname, {
  displayName: '@mesa/worker',
  testMatch: [
    '<rootDir>/test/**/*.test.ts',
    ...(runIntegration ? ['<rootDir>/test/evals/conversation.eval.ts'] : []),
    ...(runNlpEvals ? ['<rootDir>/test/evals/nlp.eval.ts'] : []),
  ],
})
