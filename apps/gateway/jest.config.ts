import type { Config } from 'jest'
// @ts-ignore - Jest loads this CommonJS wrapper before SWC handles TypeScript.
import base from '../../jest.base.js'

const { createJestConfig } = base as {
  createJestConfig: (rootDir: string, overrides?: Config) => Config
}

export default createJestConfig(`${process.cwd()}/apps/gateway`, {
  displayName: '@mesa/gateway',
})
