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

## PR safety patterns from May 4 retrospective

Three process patterns surfaced from the May 4 reject-flash arc (PRs #58 → #60 → #62) and the merge-sequence slip (PR #61 → #62 recovery). These are general rules, not specific bug entries — they govern future PRs that touch similar surfaces.

### 1. Browser-based UX verification required for optimistic-update PRs

**Rule:** Any PR introducing or modifying optimistic UI updates, fade-in/out animations, or interactions between state changes and CSS visibility properties (`opacity`, `display`, `visibility`, `transform` with positioning) requires browser-based manual verification on `pnpm dev` before commit. Source-level invariants + `pnpm vitest run` + `pnpm tsc --noEmit` are necessary but not sufficient.

**Why:** Source-level invariants verify "code does X" but cannot verify "the user can see X happening correctly." CSS animations that interact with state changes (e.g., `setOptimistic('rejecting')` applying `opacity-0`) can render the optimistic state invisible even though all structural pins pass.

**Concrete example:** PR #58 introduced the optimistic-data override mechanism for reject-mapping. Source-level invariants RF1-RF9 all passed. The override was correctly written, threaded through props, consumed by `FieldMappingRow`, and cleaned up by `useEffect`. But the override rendered behind `opacity-0` (triggered by `setOptimistic('rejecting')` fade-out) the entire time, so the user saw the same blank flash the PR was meant to fix. Required PR #60 hotfix to drop the `opacity-0` class. RF10 was added in #60 to lock the specific regression.

**Enforcement:** Cursor implementing optimistic-update PRs MUST stop and ask the user to verify on localhost before commit. Cursor cannot perform browser verification (code-only agent); attempting to claim "manual UX verification passed" without an actual browser session is the failure mode that caused PR #58.

### 2. Verify GitHub merge state before running propagation commands

**Rule:** When merging a PR + propagating dev + cleaning up branches, the merge must be confirmed on GitHub (purple "Merged" badge visible on the PR page) BEFORE running any local terminal commands. The sequence "click Merge → propagate dev → cleanup local + remote branches" must enforce a hard checkpoint after the merge click.

**Why:** Cleanup commands (`git push origin --delete <branch>`) succeed even if the PR was never merged. GitHub auto-closes PRs whose source branches are deleted, leaving the PR in a "closed, branch deleted, can't merge" state. Recovery requires re-pushing the commit to a new branch and opening a new PR.

**Concrete example:** PR #61 was closed mid-merge sequence on May 4. The propagation + cleanup commands were run before "Merge pull request" was clicked on GitHub. Cleanup deleted the origin branch `fix/bulk-reject-scope-filter`, GitHub auto-closed PR #61, and recovery required force-pushing commit `27087b9` to a new branch and opening PR #62 for re-clearance from worktree A. Identical content, second clearance, ~10 minutes lost.

**Enforcement:** When sending merge sequences to the user, visually separate the "GitHub action" step from terminal commands with a hard phase break. Don't bundle GUI and terminal steps in the same numbered list. Wait for terminal output confirming the merge SHA is at `origin/main` before issuing propagation commands.

### 3. Source-level invariants must encode contract semantics, not just structural presence

**Rule:** When writing source-level invariant tests for new mechanisms, the assertions must verify both:

- **Structural existence** — the code exists (helper called, prop threaded, useEffect declared)
- **Contract semantics** — the code does the right thing relative to the constraint it's enforcing (filter matches server scope, predicate handles all relevant cases)

**Why:** Structural pins catch "did we wire this up" but miss "did we wire it up correctly." A pin that asserts "function X is called" doesn't catch "function X is called with the wrong arguments" or "function X is called inside a condition that never matches the intended scope."

**Concrete example:** PR #58's RF4 invariant pinned that `writeOptimisticData` was called before `bulkRejectFieldMappingsForTargetTable` in the bulk reject handler. It did NOT pin that the override loop's filter matched the server's filter (`status === 'needs_review'`). The server filtered correctly; the client override loop didn't. Result: PR #62 hotfix needed to add the `status === 'needs_review'` filter to the client side. RF4 was extended in #62 to lock the contract semantic post-hotfix.

**Enforcement:** When writing source-level invariants for client-server-coupled behavior, include at minimum one invariant pinning the contract boundary (filter shape, status enum, scope predicate) on both sides. The pin should catch the case where the two sides drift out of sync.
