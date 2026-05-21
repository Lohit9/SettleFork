// @vitest-environment node
//
// Source-level invariant tests for the Migration Center "Mapping
// Coverage" card (feat/mc-mapping-coverage-two-figure).
//
// OutputsContent.tsx is a large client component fed by a server
// action; the established pattern in this repo for pinning its render
// shape is readFileSync + regex (see decisions-log-identity.test.ts,
// fix-history-identity.test.ts, popover-migrations-e1.test.ts) rather
// than mounting the component. These invariants catch a refactor that
// silently reverts the two-figure headline or breaks the shared-counter
// data flow.
//
// Invariants:
//   MC1.  OutputsContent destructures `mappingFlatCounts` from `data`.
//   MC2.  Headline renders `mappingFlatCounts.approved` under testid
//         `mc-mapping-approved`.
//   MC3.  Headline renders `mappingFlatCounts.needsReview` under testid
//         `mc-mapping-needs-review`.
//   MC4.  Both "Approved" and "Needs Review" labels are present.
//   MC5.  The `{approved}/{total}` ratio headline and its progress bar
//         are gone — no `Math.round(... target.approved / target.total
//         ...)` width expression remains.
//   MC6.  The source/target coverage sub-line is UNCHANGED — testids
//         `mc-mapping-source-decided` and `mc-mapping-target-approved`
//         still render the `projectStats` ratios.
//   MC7.  `_outputs-core.ts` exposes `mappingFlatCounts` on
//         `OutputsPageData` and computes it via `getMappingsForRedesignCore`
//         + `flattenRowsForListView` + `countFlatRowStatuses`.
//   MC8.  `emptyOutputsPageData` defaults `mappingFlatCounts` to zeroes.
//   MC9.  `flatten-rows-for-list-view.ts` exports `countFlatRowStatuses`.
//   MC10. `MappingContent.tsx` consumes the shared `countFlatRowStatuses`
//         helper (no duplicated inline tally) — pins the single counter
//         definition.

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const ROOT = resolve(__dirname, '../..')
const read = (rel: string) => readFileSync(resolve(ROOT, rel), 'utf8')

const OUTPUTS_CONTENT = read(
  'app/app/projects/[projectId]/outputs/OutputsContent.tsx',
)
const OUTPUTS_CORE = read('lib/actions/_outputs-core.ts')
const FLATTEN = read('lib/utils/flatten-rows-for-list-view.ts')
const MAPPING_CONTENT = read(
  'app/app/projects/[projectId]/mapping/redesign/MappingContent.tsx',
)

describe('[Migration Center] Mapping Coverage card — two-figure layout', () => {
  it('MC1 — OutputsContent destructures mappingFlatCounts from data', () => {
    expect(OUTPUTS_CONTENT).toMatch(
      /const\s+\{[^}]*\bmappingFlatCounts\b[^}]*\}\s*=\s*data/,
    )
  })

  it('MC2 — headline renders mappingFlatCounts.approved under mc-mapping-approved', () => {
    expect(OUTPUTS_CONTENT).toMatch(/data-testid="mc-mapping-approved"/)
    expect(OUTPUTS_CONTENT).toMatch(/\{mappingFlatCounts\.approved\}/)
  })

  it('MC3 — headline renders mappingFlatCounts.needsReview under mc-mapping-needs-review', () => {
    expect(OUTPUTS_CONTENT).toMatch(/data-testid="mc-mapping-needs-review"/)
    expect(OUTPUTS_CONTENT).toMatch(/\{mappingFlatCounts\.needsReview\}/)
  })

  it('MC4 — both Approved and Needs Review labels are present', () => {
    expect(OUTPUTS_CONTENT).toMatch(/>\s*Approved\s*</)
    expect(OUTPUTS_CONTENT).toMatch(/>\s*Needs Review\s*</)
  })

  it('MC5 — the old ratio headline + progress bar are gone', () => {
    // The progress bar width was the only consumer of this expression.
    expect(OUTPUTS_CONTENT).not.toMatch(
      /Math\.round\(\(projectStats\.target\.approved\s*\/\s*projectStats\.target\.total\)/,
    )
  })

  it('MC6 — source/target coverage sub-line testids are unchanged', () => {
    expect(OUTPUTS_CONTENT).toMatch(/data-testid="mc-mapping-source-decided"/)
    expect(OUTPUTS_CONTENT).toMatch(/data-testid="mc-mapping-target-approved"/)
    expect(OUTPUTS_CONTENT).toMatch(
      /\{projectStats\.source\.decided\}\/\{projectStats\.source\.total\}/,
    )
    expect(OUTPUTS_CONTENT).toMatch(
      /\{projectStats\.target\.approved\}\/\{projectStats\.target\.total\}/,
    )
  })

  it('MC7 — _outputs-core exposes mappingFlatCounts and computes it via the shared counter', () => {
    expect(OUTPUTS_CORE).toMatch(
      /mappingFlatCounts:\s*\{\s*approved:\s*number;\s*needsReview:\s*number\s*\}/,
    )
    expect(OUTPUTS_CORE).toMatch(/getMappingsForRedesignCore\(client,\s*projectId\)/)
    expect(OUTPUTS_CORE).toMatch(
      /countFlatRowStatuses\(flattenRowsForListView\(mappingResult\)\)/,
    )
  })

  it('MC8 — emptyOutputsPageData defaults mappingFlatCounts to zeroes', () => {
    expect(OUTPUTS_CORE).toMatch(
      /mappingFlatCounts:\s*\{\s*approved:\s*0,\s*needsReview:\s*0\s*\}/,
    )
  })

  it('MC9 — flatten-rows-for-list-view exports countFlatRowStatuses', () => {
    expect(FLATTEN).toMatch(/export function countFlatRowStatuses\(/)
  })

  it('MC10 — MappingContent consumes the shared countFlatRowStatuses helper', () => {
    expect(MAPPING_CONTENT).toMatch(/\bcountFlatRowStatuses\b/)
    // The pre-extraction inline tally is gone.
    expect(MAPPING_CONTENT).not.toMatch(
      /let\s+approved\s*=\s*0\s*\n\s*let\s+needsReview\s*=\s*0/,
    )
  })
})
