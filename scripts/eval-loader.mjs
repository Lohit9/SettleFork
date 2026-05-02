/**
 * Phase 1 PR 10.4 — Node ESM loader for the eval CLI.
 *
 * ─── Why this file exists ─────────────────────────────────────────────────────
 *
 * The production codebase uses `import 'server-only'` at the top of
 * server-only modules (e.g. `lib/auth/mapping-writes.ts`). The directive
 * is a Next.js convention: at production build time, Next's bundler
 * uses Node's `react-server` export condition to swap the package's
 * `default` (CJS) entry — which throws unconditionally on import — for
 * its `react-server` entry, which is an empty no-op.
 *
 * The eval CLI runs via `tsx`, NOT through Next.js's bundler. That
 * means:
 *   1. Without server-only installed, `import 'server-only'` fails with
 *      MODULE_NOT_FOUND. (Fixed by `pnpm add server-only` in PR 10.4.)
 *   2. With server-only installed, the package's `default` entry throws
 *      its design-by-construction error: "This module cannot be imported
 *      from a Client Component module."
 *   3. Setting `NODE_OPTIONS=--conditions=react-server` globally picks
 *      the empty entry for server-only ✅ but ALSO picks React's
 *      `react.shared-subset.development.js`, which throws "not yet
 *      supported outside of experimental channels" ❌.
 *
 * This loader is the surgical fix: it intercepts the `server-only`
 * specifier ONLY and returns an empty module. Every other resolution
 * (React, the production code, supabase, anthropic, …) falls through
 * to default resolution unchanged.
 *
 * ─── Why a loader (Option 1B) and not a file refactor (Option 2) ─────────────
 *
 * Phase 1 will eventually import 5 production AI entry points from the
 * eval CLI: mapping, suggest, transform, nl_to_sql, validation_rule.
 * Each of those production callsites in turn pulls in
 * `lib/auth/mapping-writes.ts` (or peers that use `import 'server-only'`).
 *
 * Refactoring each production file to remove the directive — one of
 * the proposed alternatives — would scale linearly with the number of
 * imports the eval CLI adds. This loader scales O(1): one rule covers
 * every current and future use of `import 'server-only'` from the eval
 * CLI runtime.
 *
 * Production builds are unaffected. Next.js continues to virtual-resolve
 * `server-only` exactly as before; this loader is only registered when
 * the eval CLI is invoked via `pnpm eval`.
 *
 * ─── How it works ─────────────────────────────────────────────────────────────
 *
 * Node's ESM loader hooks API (stable on Node 20.6+; project is on
 * Node 24). The `resolve` hook intercepts every import specifier; we
 * short-circuit on `server-only` and forward the rest. The empty
 * `data:text/javascript,` URL produces a no-op ESM module that
 * satisfies the `import 'server-only'` statement without executing
 * anything.
 *
 * Composes with tsx's own loader (registered via `--import tsx`).
 * tsx handles TypeScript transformation; this loader only handles
 * specifier resolution. Different concerns; the hooks chain in order
 * and don't conflict.
 */

export async function resolve(specifier, context, nextResolve) {
  if (specifier === 'server-only') {
    return {
      url: 'data:text/javascript,',
      shortCircuit: true,
      format: 'module',
    }
  }
  return nextResolve(specifier, context)
}
