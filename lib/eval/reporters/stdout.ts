/**
 * Phase 1 PR 10.4 — stdout reporter.
 *
 * Renders an `RunOutput` as a human-readable multi-line string. Used
 * by the CLI when `--format=stdout` (the default).
 */

import type { RunOutput } from '@/lib/eval/runner'

export function reportStdout(output: RunOutput): string {
  const lines: string[] = []
  const startedAt = output.runId
  lines.push(
    `Eval run @ ${startedAt} (commit ${output.commitSha}, model ${output.model})`,
  )
  lines.push(`Pre-flight: ${output.preflightPassed ? '✅' : '❌'}`)
  lines.push(`Cleanup:    ${output.cleanupOk ? '✅' : '❌'}`)
  lines.push('')

  if (!output.preflightPassed) {
    lines.push('Pre-flight failed; no examples were run.')
    return lines.join('\n')
  }

  if (output.datasets.length === 0) {
    lines.push('No examples processed.')
  } else {
    for (const dm of output.datasets) {
      lines.push(`${dm.dataset} / ${dm.task} (${dm.examples} example${dm.examples === 1 ? '' : 's'})`)
      const scorerNames = Object.keys(dm.scorers).sort()
      if (scorerNames.length === 0) {
        lines.push('  (no scorer results)')
      } else {
        for (const name of scorerNames) {
          const s = dm.scorers[name]!
          if (s.count === 0) {
            lines.push(`  ${name}: no successful scores (errors=${s.errorCount})`)
            continue
          }
          const meanStr = s.mean.toFixed(3)
          const minStr = s.min.toFixed(3)
          const maxStr = s.max.toFixed(3)
          const errStr = s.errorCount > 0 ? `, errors=${s.errorCount}` : ''
          lines.push(`  ${name}: mean=${meanStr}, min=${minStr}, max=${maxStr}${errStr}`)
        }
      }
      lines.push(
        `  cost: $${dm.costUsd.toFixed(4)}, cached: ${dm.cachedCount}/${dm.examples}, duration: ${(dm.durationMs / 1000).toFixed(1)}s`,
      )
      lines.push('')
    }
  }

  lines.push(
    `Totals: $${output.totalCostUsd.toFixed(4)}, ${output.totalCachedCount} cached, ${(output.totalDurationMs / 1000).toFixed(1)}s`,
  )
  return lines.join('\n')
}
