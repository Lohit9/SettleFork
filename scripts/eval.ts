#!/usr/bin/env tsx

/**
 * Phase 1 PR 10.4 — eval CLI entry.
 *
 * Usage:
 *   pnpm eval                                          → all tasks, all datasets
 *   pnpm eval mapping                                  → mapping task, all datasets
 *   pnpm eval mapping --dataset _fixture               → mapping, single dataset
 *   pnpm eval --smoke                                  → 1 example per task
 *   pnpm eval --max-cost 5                             → cost cap override (in USD)
 *   pnpm eval --format json --out results.json         → JSON output to file
 *   pnpm eval --example _fixture/mapping/001-fixture   → single-example debug
 *
 * Exit codes:
 *   0 — success (preflight + cleanup both passed; cost cap respected)
 *   1 — eval ran but had a failure (preflight failed, cleanup failed,
 *       cost cap aborted, or an example errored)
 *   2 — argv parsing failure
 *
 * Loads .env.local before invoking the runner so EVAL_ORG_ID and
 * EVAL_USER_ID are visible.
 */

// Polyfill: tsx loads .env.local automatically when run via `tsx`,
// but for explicit clarity we also import dotenv if present. This
// is the only "production" code path that runs `node` outside Next.js.
import { config as loadDotenv } from 'dotenv'
import { writeFileSync } from 'node:fs'
import { resolve } from 'node:path'

loadDotenv({ path: resolve(process.cwd(), '.env.local') })

import { runEval, type RunOptions } from '@/lib/eval/runner'
import { reportStdout } from '@/lib/eval/reporters/stdout'
import { reportJson } from '@/lib/eval/reporters/json'

interface ParsedArgs {
  options: RunOptions
  format: 'stdout' | 'json'
  out: string | null
}

function parseArgs(argv: string[]): ParsedArgs {
  const options: RunOptions = {}
  let format: 'stdout' | 'json' = 'stdout'
  let out: string | null = null

  // First positional arg (if not starting with --) is the task filter.
  let i = 0
  if (argv[i] && !argv[i]!.startsWith('--')) {
    const t = argv[i]!
    if (t !== 'mapping' && t !== 'validation-rule' && t !== 'all') {
      throw new Error(`Unknown task "${t}". Use 'mapping', 'validation-rule', or 'all'.`)
    }
    options.task = t
    i++
  }

  for (; i < argv.length; i++) {
    const a = argv[i]!
    switch (a) {
      case '--smoke':
        options.smoke = true
        break
      case '--max-cost': {
        const v = argv[++i]
        if (v === undefined) throw new Error('--max-cost requires a value')
        const n = Number(v)
        if (!Number.isFinite(n) || n < 0) throw new Error(`Invalid --max-cost: ${v}`)
        options.maxCostUsd = n
        break
      }
      case '--dataset': {
        const v = argv[++i]
        if (v === undefined) throw new Error('--dataset requires a value')
        options.dataset = v
        break
      }
      case '--example': {
        const v = argv[++i]
        if (v === undefined) throw new Error('--example requires a value')
        options.example = v
        break
      }
      case '--format': {
        const v = argv[++i]
        if (v !== 'stdout' && v !== 'json') {
          throw new Error(`Invalid --format value "${v}"; use 'stdout' or 'json'`)
        }
        format = v
        break
      }
      case '--out': {
        const v = argv[++i]
        if (v === undefined) throw new Error('--out requires a value')
        out = v
        break
      }
      default:
        throw new Error(`Unknown flag: ${a}`)
    }
  }

  return { options, format, out }
}

async function main() {
  let parsed: ParsedArgs
  try {
    parsed = parseArgs(process.argv.slice(2))
  } catch (err) {
    console.error('argv parsing failed:', err instanceof Error ? err.message : String(err))
    process.exit(2)
  }

  let output
  try {
    output = await runEval(parsed.options)
  } catch (err) {
    console.error('eval run threw:', err instanceof Error ? err.message : String(err))
    process.exit(1)
  }

  const rendered = parsed.format === 'json' ? reportJson(output) : reportStdout(output)

  if (parsed.out) {
    writeFileSync(parsed.out, rendered, 'utf-8')
    console.log(`wrote ${parsed.out}`)
  } else {
    console.log(rendered)
  }

  // Exit non-zero on any signal of trouble: preflight, cleanup, or
  // any errored examples.
  const anyErrors = output.datasets.some((d) =>
    Object.values(d.scorers).some((s) => s.errorCount > 0),
  )
  if (!output.preflightPassed || !output.cleanupOk || anyErrors) {
    process.exit(1)
  }
  process.exit(0)
}

main().catch((err) => {
  console.error('Unhandled error in eval CLI:', err)
  process.exit(1)
})
