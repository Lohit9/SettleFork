# Known Issues

Log of intermittent or environmental issues that don't block development but should be tracked. Each entry has an environment-specific reproduction note + recommended posture.

## eval-runner.test.ts env-var guard flake

**Test:** `tests/eval/runner.test.ts > runEval — env-var guard > throws when EVAL_ORG_ID is unset`
**First observed:** PR 12.1.5 / Path 2 PR 1 verification windows (worktree B's terminal)
**Reproduction rate:**
- Worktree B's terminal: ~1/3 failure rate
- Worktree A's terminal: 10/10 PASS in isolation
- Worktree A under simulated background-process load: 10/10 PASS
**Likely cause:** `vi.resetModules()` followed by dynamic `await import()` inside the test body. As [`lib/eval/runner.ts`](../lib/eval/runner.ts) grows (Path 2 PR 1 added ~378 LOC, Path 2 PR 2 added ~388 LOC), the cold-cache import time approaches vitest's 5000ms default timeout. Worktree B's terminal apparently has a tighter timing window.
**Status:** Environmental, not blocking. Punted.
**Posture:** Re-run on flake. Don't gate CI on this test. If it becomes persistent (e.g., >50% failure rate locally), revisit with `vi.hoisted()` setup or static import + dependency injection.
**Reference:** Path 2 PR 2 B-1 + B-2 verification reports.

## tests/components/toast.test.tsx context error

**Symptom:** First vitest run after a long idle session occasionally surfaces a "Toast must be used within a ToastProvider" error in the toast-related test file. Re-run is clean.
**First observed:** PR 12.1.5 / Path 2 PR 1 / Path 2 PR 2 verification windows
**Reproduction rate:** ~1/4 first runs in fresh terminal sessions; 0/N re-runs
**Likely cause:** test isolation / provider-mount race during cold worker spawn (jsdom environment startup).
**Status:** Environmental, not blocking.
**Posture:** Re-run on flake. Do not gate CI. If it becomes persistent, investigate test setup ordering for `ToastProvider`.

## extracted-patterns flag-ON smoke deferral (TODO: re-measure)

**Status:** Path 2 PR 2 B-2's extracted-patterns flag-ON smoke was deferred due to an Anthropic grammar-compilation 503 transient error during the verification window (4 retries, `x-should-retry: false`). Dispatch + scorer + fixture are correct (proven via tsc + pre-flight + unit tests).
**Action:** Re-measure when Anthropic's grammar-compilation service has recovered. Run `pnpm eval extracted-patterns --max-cost 0.10 --dataset _fixture` under `AI_PHASE_2_ENABLED=1` and document the baseline score in this section.
**Expected score:** 0.85-1.0 (similar profile to other Hard tools given the description-embedded canonical vocabulary).
**Cost:** ~$0.05-0.07 expected.
**Reference:** PR #34 (Path 2 PR 2 B-2). Strict-mode constraint #6 in [`docs/anthropic-strict-mode-constraints.md`](anthropic-strict-mode-constraints.md) catalogs the underlying 503 mode.
