import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'
import path from 'node:path'

// Minimal Vitest config for the mapping-redesign test harness.
//
// - jsdom for hook/component tests (no browser required in CI)
// - tsconfig `@/*` alias reproduced explicitly; Vitest does not consume
//   tsconfig.json paths by default.
// - setupFiles wires up @testing-library/jest-dom matchers.
// - Tests live under `tests/` and alongside sources as `*.test.ts(x)`.
//
// Expands in later phases to cover server-action and integration tests.

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
    include: [
      'tests/**/*.test.{ts,tsx}',
      'lib/**/*.test.{ts,tsx}',
      'components/**/*.test.{ts,tsx}',
      'app/**/*.test.{ts,tsx}',
    ],
    exclude: [
      'node_modules/**',
      '.next/**',
      'figma/**',
      'supabase/**',
      // Live-data / Heritage integration tests are env-gated (see each
      // file for its `RUN_*_INTEGRATION` opt-in flag). Excluded from the
      // default `npm test` run so CI doesn't try to load them; run them
      // explicitly via `npm run test:integration` with the per-file
      // RUN_*_INTEGRATION flag and Supabase env vars set locally.
      'tests/integration/**',
    ],
  },
})
