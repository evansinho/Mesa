import { createJestConfig } from '../../jest.base.ts'
import { dirname } from 'path'
import { fileURLToPath } from 'url'

const __dirname = dirname(fileURLToPath(import.meta.url))

export default createJestConfig(__dirname, {
  displayName: '@mesa/messaging',
})
