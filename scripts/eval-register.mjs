/**
 * Phase 1 PR 10.4 — register the eval-loader hooks via the modern
 * `module.register()` API.
 *
 * Why this file exists separately from `eval-loader.mjs`:
 *
 *   Node's `--import` flag wants to import a registration script that
 *   calls `module.register()` to load the actual hooks file. Splitting
 *   the registration call from the hooks themselves keeps both files
 *   small and matches the pattern Node's deprecation notice for
 *   `--experimental-loader` recommends.
 *
 *   The register() API (stable on Node 20.6+) intercepts BOTH ESM
 *   imports and CJS require() calls — important here because the
 *   `import 'server-only'` directive in production code is transformed
 *   to a CJS require() by tsx before this loader gets a chance to
 *   intercept it.
 */

import { register } from 'node:module'

// import.meta.url is already a file:// URL; pass directly as the
// parent reference for resolving the relative './eval-loader.mjs'.
register('./eval-loader.mjs', import.meta.url)
