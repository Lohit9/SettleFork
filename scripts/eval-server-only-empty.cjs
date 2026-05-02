// Phase 1 PR 10.4 — empty CJS stub used by `eval-stub-server-only.cjs`
// to stand in for the published `server-only` package when the eval
// CLI runs. Intentionally empty: `import 'server-only'` is a marker
// directive, not a real import; satisfying the resolution with an
// empty module is correct behavior outside Next.js's bundler.
