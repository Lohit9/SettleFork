// @vitest-environment node
//
// PR Ω.3.x.1 — Disambiguation intercept wiring in MappingContent.tsx.
//
// Source-grep tests pinning that the two cross-table intercepts are
// present at the documented handlers (`handleInlineSourceCommit` and
// `handlePromoteSource`) and that the dialog is mounted at the page
// level. Component-level behavioural tests for the dialog itself live
// in `tests/components/source-disambiguation-dialog.test.tsx`.

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const CONTENT_PATH = resolve(
  __dirname,
  '../../app/app/projects/[projectId]/mapping/redesign/MappingContent.tsx',
)
const CONTENT_SRC = readFileSync(CONTENT_PATH, 'utf8')

function sliceBetween(src: string, start: string, end: string): string {
  const a = src.indexOf(start)
  if (a < 0) throw new Error(`start marker not found: ${start}`)
  const b = src.indexOf(end, a + start.length)
  if (b < 0) throw new Error(`end marker not found after start: ${end}`)
  return src.slice(a, b)
}

describe('[Ω.3.x.1] MappingContent imports + dialog mount', () => {
  it('imports SourceDisambiguationDialog from the components directory', () => {
    expect(CONTENT_SRC).toMatch(
      /from '\.\/components\/SourceDisambiguationDialog'/,
    )
    expect(CONTENT_SRC).toMatch(
      /import \{ SourceDisambiguationDialog \}/,
    )
  })

  it('mounts <SourceDisambiguationDialog/> with mutations.pending/confirm/cancel wiring', () => {
    expect(CONTENT_SRC).toMatch(
      /<SourceDisambiguationDialog[\s\S]*?pending=\{mutations\.pendingDisambiguation\}/,
    )
    expect(CONTENT_SRC).toMatch(
      /isPending=\{mutations\.isDisambiguationPending\}/,
    )
    expect(CONTENT_SRC).toMatch(
      /onCreateSeparate=\{mutations\.confirmDisambiguatedCreate\}/,
    )
    expect(CONTENT_SRC).toMatch(
      /onReplace=\{mutations\.confirmDisambiguatedReplace\}/,
    )
    expect(CONTENT_SRC).toMatch(
      /onCancel=\{mutations\.cancelPendingDisambiguation\}/,
    )
  })
})

describe('[Ω.3.x.1] handleInlineSourceCommit intercept', () => {
  const handler = sliceBetween(
    CONTENT_SRC,
    'const handleInlineSourceCommit = useCallback',
    'const handleDrawerActionComplete',
  )

  it('detects newly-added cross-table source before falling through to silent combine', () => {
    expect(handler).toMatch(/cross-table disambiguation intercept/)
    // The intercept iterates the finalIds against (a) existing source
    // fields (to find what's new) and (b) existing source-table ids
    // (to detect the cross-table case).
    expect(handler).toMatch(/existingSourceFieldIds/)
    expect(handler).toMatch(/existingTableIds/)
    expect(handler).toMatch(/newSourceFieldIds/)
    expect(handler).toMatch(/newCrossTableSource/)
  })

  it('parks the popup via mutations.openPendingDisambiguation', () => {
    expect(handler).toMatch(/mutations\.openPendingDisambiguation\(\{/)
    // Payload carries the four locked fields plus the existing-sources
    // and incoming-source descriptors.
    expect(handler).toMatch(/rowId,/)
    expect(handler).toMatch(/existingTfmId: row\.id/)
    expect(handler).toMatch(/targetFieldId: row\.targetField\.id/)
    expect(handler).toMatch(/incomingSource: \{/)
  })

  it('only intercepts when the row is mapped (unmapped rows skip)', () => {
    expect(handler).toMatch(/if \(row\.kind === 'mapped'\)/)
  })

  it('returns success: true so the picker closes on intercept', () => {
    // The picker's commit contract: success=true → close. We want the
    // dialog to take over the surface cleanly.
    const intercept = handler.split(
      'mutations.openPendingDisambiguation({',
    )[1]
    expect(intercept).toContain('return { success: true }')
  })
})

// PR Ω.3.x.1 v1.1 — `handlePromoteSource`'s host-level intercept moved
// into the hook (`mutations.promoteUnmappedSource`) so the flat view's
// target picker — which calls the hook directly without going through
// the host handler — is protected too. The hook-side intercept is
// covered by
// `tests/hooks/use-mapping-list-mutations-disambiguation.test.tsx`.
describe('[Ω.3.x.1] handlePromoteSource — intercept relocated to hook', () => {
  const handler = sliceBetween(
    CONTENT_SRC,
    'const handlePromoteSource = useCallback',
    'const handleNavigateTarget',
  )

  it('delegates to mutations.promoteUnmappedSource (hook owns the intercept)', () => {
    expect(handler).toMatch(/mutations\.promoteUnmappedSource\(\{/)
    // The handler must NOT carry its own openPendingDisambiguation call —
    // that would double-park the popup on a single gesture from the
    // drawer.
    expect(handler).not.toMatch(/openPendingDisambiguation/)
  })

  it('documents the relocation in a doc comment', () => {
    expect(handler).toMatch(/cross-table intercept now lives inside/)
  })
})

describe('[Ω.3.x.1] MappingContent — lookups threaded to the hook', () => {
  it('memoises rowsByTargetFieldId + mappedRowsByTfmId + sourceFieldsById', () => {
    expect(CONTENT_SRC).toMatch(/rowsByTargetFieldId/)
    expect(CONTENT_SRC).toMatch(/mappedRowsByTfmId/)
    expect(CONTENT_SRC).toMatch(/sourceFieldsById/)
  })

  it('passes the lookups into useMappingListMutations', () => {
    expect(CONTENT_SRC).toMatch(
      /useMappingListMutations\(\{[\s\S]*?lookups: mutationLookups/,
    )
  })
})
