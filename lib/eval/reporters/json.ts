/**
 * Phase 1 PR 10.4 — JSON reporter.
 *
 * Returns the full RunOutput as pretty-printed JSON. Used by:
 *   - `--format=json` flag (machine-readable output)
 *   - PR 10.6 baseline write to tests/eval/baselines/main.json
 *   - PR 12 CI integration (PR comment generation)
 */

import type { RunOutput } from '@/lib/eval/runner'

export function reportJson(output: RunOutput): string {
  return JSON.stringify(output, null, 2)
}
