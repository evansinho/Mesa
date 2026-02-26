import dotenv from 'dotenv'
import fs from 'fs'
import path from 'path'

let loaded = false

export function loadEnv() {
  if (loaded) return
  let dir = process.env.INIT_CWD || process.cwd()
  while (true) {
    const candidate = path.join(dir, '.env')
    if (fs.existsSync(candidate)) {
      dotenv.config({ path: candidate })
      loaded = true
      return
    }
    const parent = path.dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  dotenv.config()
  loaded = true
}

loadEnv()
