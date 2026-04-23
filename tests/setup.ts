import '@testing-library/jest-dom/vitest'
import { cleanup } from '@testing-library/react'
import { afterEach } from 'vitest'
import { config as loadEnv } from 'dotenv'
import { existsSync } from 'node:fs'
import path from 'node:path'

// Load .env.local for env-gated integration tests (heritage tests, etc).
// Vitest does not auto-load .env files the way Next.js does, so we do it
// explicitly here before any test imports run.
const envLocalPath = path.resolve(__dirname, '..', '.env.local')
if (existsSync(envLocalPath)) {
  loadEnv({ path: envLocalPath })
}

// Every test gets a clean DOM. Prevents cross-test leakage in jsdom.
afterEach(() => {
  cleanup()
})
