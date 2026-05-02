/**
 * Phase 1 PR 10.4 — CJS preload that stubs `server-only` for the eval CLI.
 *
 * Why this file exists (and why the ESM-only loader was insufficient):
 *
 *   The first attempt was an ESM `module.register()` resolve hook
 *   (scripts/eval-loader.mjs + scripts/eval-register.mjs). That works
 *   for pure-ESM import chains but does NOT intercept the CJS
 *   `require()` chain that tsx 4.x produces when transforming TS
 *   files without a `"type": "module"` declaration in package.json.
 *
 *   The production import chain in this codebase goes:
 *       lib/auth/mapping-writes.ts
 *           → import 'server-only'
 *
 *   tsx transforms `mapping-writes.ts` into CJS, which means
 *   `import 'server-only'` becomes `require('server-only')`. CJS
 *   require() goes through Node's classic CJS loader
 *   (`internal/modules/cjs/loader`), NOT through ESM hooks. The
 *   server-only package's CJS entry throws unconditionally — that's
 *   the package's whole point — so without intercepting at the CJS
 *   layer, the import explodes.
 *
 *   This file patches `Module._resolveFilename` (Node's CJS resolution
 *   entry point) to redirect any `require('server-only')` to a tiny
 *   empty stub file in this directory. Loaded via Node's `--require`
 *   flag BEFORE tsx so the patch is in place before any production
 *   code imports `server-only`.
 *
 *   Production builds are unaffected: this file is only loaded when
 *   the eval CLI is invoked via `pnpm eval`. Next.js's bundler
 *   continues to virtual-resolve `server-only` exactly as before
 *   for production server / client component builds.
 *
 * Why CJS not ESM for this stub:
 *
 *   - `Module._resolveFilename` is part of Node's classic CJS loader.
 *     The patch must run in CJS context to be effective.
 *   - Node's `--require` flag accepts CJS-only modules. The modern
 *     ESM equivalent (`--import`) doesn't give us a hook into
 *     `Module._resolveFilename`.
 */

const path = require('node:path')
const Module = require('node:module')

const STUB_PATH = path.resolve(__dirname, 'eval-server-only-empty.cjs')

const originalResolveFilename = Module._resolveFilename
Module._resolveFilename = function patchedResolveFilename(
  request,
  parent,
  ...rest
) {
  if (request === 'server-only') {
    return STUB_PATH
  }
  return originalResolveFilename.call(this, request, parent, ...rest)
}
