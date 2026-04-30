import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'
import path from 'node:path'

// Vitest config for live-data integration tests.
//
// The default `vitest.config.ts` excludes `tests/integration/**` so the
// CI Tests workflow (and `npm test` locally) skip the env-gated heritage
// suites. This config is the inverse: it scopes `include` to the
// integration directory only, so `npm run test:integration` runs only
// those suites.
//
// Each integration test still self-gates on its own `RUN_*_INTEGRATION`
// flag plus Supabase env vars, so even via this config a developer who
// hasn't set the relevant flags will see the suites auto-skip rather
// than hit a live Supabase project unintentionally.
//
// NOTE: We don't use `mergeConfig` here because Vitest's array merge
// concatenates rather than replaces — the base `include`/`exclude`
// patterns would leak in and undo the integration scoping. A standalone
// config is the only way to fully override.

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './'),
    },
  },
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./tests/setup.ts'],
    include: ['tests/integration/**/*.test.{ts,tsx}'],
    exclude: ['node_modules/**', '.next/**', 'figma/**', 'supabase/**'],
  },
})
