// Load .env.test from the repo root before any other imports that may read
// process.env (e.g. @mesa/config). Test files should import this FIRST when
// they need the test environment loaded.
import path from 'path'
import dotenv from 'dotenv'

// This file lives at <repo>/test-helpers/env.ts so the repo root is one
// directory up.
dotenv.config({ path: path.join(__dirname, '../.env.test') })