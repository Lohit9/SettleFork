// @vitest-environment node
//
// Phase 4b-1 — source-level invariant tests for the `mode='edit'`
// parameterization of `CreateMappingForm`.
//
// The full create-mode behavior is covered by
// `tests/components/create-mapping-form.test.tsx` (full RTL render with
// mocked actions). The edit-mode wiring re-uses that same component;
// these tests lock the founder-decision-driven differences in place
// without spinning up another RTL harness:
//
//   F1.  `mode` prop is `'create' | 'edit'` with `'create'` default.
//   F2.  `editInitialState` prop carries tfmId + selectedIds +
//        combinationType + joinAnnotations.
//   F3.  `EditMappingInitialState` does NOT carry provenance fields
//        (laundering is server-side, founder §1.f).
//   F4.  `EditSaveMeta` carries mode + tfmId + transformReset +
//        stagedRowsReverted + nextStatus.
//   F5.  Form hydrates `selectedIds`, `combinationType`, and
//        `joinAnnotations` from `editInitialState` when in edit mode.
//   F6.  `isDirty` in edit mode compares against `editInitialState`,
//        not against an empty selection.
//   F7.  `canSave` in edit mode requires `isDirty` (no-op edits
//        cannot save).
//   F8.  `handleSave` dispatches to `handleEditSave` when in edit
//        mode.
//   F9.  `handleEditSave` calls `editMappingSources` with the
//        documented input shape (no aiSuggested/provenance flags).
//  F10.  Server-side error codes are mapped via `EDIT_ERROR_CODE_COPY`
//        with VALIDATION-flavored generic copy.
//  F11.  AI Suggest UI is hidden in edit mode (founder §3 — defer to
//        4-extras).
//  F12.  `onSaveSuccess` is invoked with `EditSaveMeta` on a
//        successful edit save (mode='edit', nextStatus='needs_review').

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const FORM_PATH = resolve(
  __dirname,
  '../../app/app/projects/[projectId]/mapping/redesign/components/CreateMappingForm.tsx',
)
const SRC = readFileSync(FORM_PATH, 'utf8')

function sliceBetween(src: string, startMarker: string, endMarker: string): string {
  const a = src.indexOf(startMarker)
  if (a < 0) throw new Error(`marker not found: ${startMarker}`)
  const b = src.indexOf(endMarker, a + startMarker.length)
  if (b < 0)
    throw new Error(`end marker not found after ${startMarker}: ${endMarker}`)
  return src.slice(a, b)
}

// ─────────────────────────────────────────────────────────────────────
// F1-F4 — type-level shape
// ─────────────────────────────────────────────────────────────────────

describe('[edit-mapping-form] type-level shape', () => {
  it("F1: `mode` prop is 'create' | 'edit' with 'create' default", () => {
    expect(SRC).toMatch(/mode\?:\s*['"]create['"]\s*\|\s*['"]edit['"]/)
    // Default is 'create' — matches existing 4a-* call sites without
    // requiring a mode prop.
    expect(SRC).toMatch(/mode\s*=\s*['"]create['"]/)
  })

  it('F2: `editInitialState` prop carries the documented hydration payload', () => {
    expect(SRC).toMatch(/export interface EditMappingInitialState/)
    const def = sliceBetween(
      SRC,
      'export interface EditMappingInitialState',
      '\n}',
    )
    expect(def).toMatch(/tfmId:\s*string/)
    expect(def).toMatch(/selectedIds:\s*string\[\]/)
    expect(def).toMatch(
      /combinationType:\s*CreateFieldMappingCombinationType/,
    )
    expect(def).toMatch(/joinAnnotations:\s*Record<string,\s*string>/)
  })

  it('F3: `EditMappingInitialState` does NOT carry provenance fields (laundering is server-side, founder §1.f)', () => {
    const def = sliceBetween(
      SRC,
      'export interface EditMappingInitialState',
      '\n}',
    )
    expect(def).not.toMatch(/aiSuggested/)
    expect(def).not.toMatch(/originalSuggestedIds/)
  })

  it('F4: `EditSaveMeta` carries mode/tfmId/transformReset/stagedRowsReverted/nextStatus', () => {
    expect(SRC).toMatch(/export interface EditSaveMeta/)
    const def = sliceBetween(SRC, 'export interface EditSaveMeta', '\n}')
    expect(def).toMatch(/mode:\s*['"]edit['"]/)
    expect(def).toMatch(/tfmId:\s*string/)
    expect(def).toMatch(/transformReset:\s*boolean/)
    expect(def).toMatch(/stagedRowsReverted:\s*number/)
    expect(def).toMatch(/nextStatus:\s*['"]needs_review['"]/)
  })
})

// ─────────────────────────────────────────────────────────────────────
// F5-F7 — hydration + isDirty + canSave wiring
// ─────────────────────────────────────────────────────────────────────

describe('[edit-mapping-form] hydration + dirty/save semantics', () => {
  it('F5: hydrates selectedIds / combinationType / joinAnnotations from editInitialState in edit mode', () => {
    expect(SRC).toMatch(
      /isEditMode\s*&&\s*editInitialState\s*\?\s*\[\s*\.\.\.editInitialState\.selectedIds\s*\]/,
    )
    expect(SRC).toMatch(
      /isEditMode\s*&&\s*editInitialState[\s\S]{0,200}editInitialState\.combinationType/,
    )
    expect(SRC).toMatch(
      /isEditMode\s*&&\s*editInitialState[\s\S]{0,200}\.\.\.editInitialState\.joinAnnotations/,
    )
  })

  it('F6: isDirty in edit mode compares against editInitialState (set + ordering + combination + joinAnnotations)', () => {
    // Set difference: length OR per-index id mismatch.
    expect(SRC).toMatch(
      /selectedIds\.length\s*!==\s*editInitialState\.selectedIds\.length/,
    )
    expect(SRC).toMatch(
      /selectedIds\[i\]\s*!==\s*editInitialState\.selectedIds\[i\]/,
    )
    // Combination type change is dirty.
    expect(SRC).toMatch(
      /combinationType\s*!==\s*editInitialState\.combinationType/,
    )
    // joinAnnotations comparison.
    expect(SRC).toMatch(/editInitialState\.joinAnnotations/)
  })

  it('F7: canSave in edit mode requires isDirty (no-op edits cannot save)', () => {
    expect(SRC).toMatch(/!isEditMode\s*\|\|\s*isDirty/)
  })
})

// ─────────────────────────────────────────────────────────────────────
// F8-F9 — save handler routing
// ─────────────────────────────────────────────────────────────────────

describe('[edit-mapping-form] save handler routing', () => {
  it('F8: handleSave dispatches to handleEditSave when isEditMode is true', () => {
    expect(SRC).toMatch(/if\s*\(isEditMode\)\s*\{[\s\S]{0,200}handleEditSave\(\)/)
  })

  it('F9a: handleEditSave calls editMappingSources with tfmId + sourceFieldIds + combinationType + joinAnnotations', () => {
    expect(SRC).toMatch(
      /editMappingSources\(\s*\{[\s\S]{0,400}tfmId:\s*editInitialState\.tfmId[\s\S]{0,400}sourceFieldIds:\s*selectedIds[\s\S]{0,400}combinationType:\s*effectiveCombinationType[\s\S]{0,400}joinAnnotations,?/,
    )
  })

  it('F9b: handleEditSave does NOT thread aiSuggested/provenance flags (server handles laundering)', () => {
    const handlerBody = sliceBetween(SRC, 'const handleEditSave', 'const handleRefreshOnExistingTfm')
    expect(handlerBody).not.toMatch(/aiSuggested:/)
    expect(handlerBody).not.toMatch(/originalSuggestedIds:/)
  })

  it('F9c: handleEditSave handles CROSS_TABLE_AMBIGUOUS by populating ambiguousCandidates (parallel to create-mode)', () => {
    const handlerBody = sliceBetween(SRC, 'const handleEditSave', 'const handleRefreshOnExistingTfm')
    expect(handlerBody).toMatch(
      /errorCode\s*===\s*['"]CROSS_TABLE_AMBIGUOUS['"]/,
    )
    expect(handlerBody).toMatch(/setAmbiguousCandidates/)
  })
})

// ─────────────────────────────────────────────────────────────────────
// F10 — error code mapping
// ─────────────────────────────────────────────────────────────────────

describe('[edit-mapping-form] error code mapping', () => {
  it('F10a: EDIT_ERROR_CODE_COPY exists and maps every EditMappingErrorCode key', () => {
    expect(SRC).toMatch(/EDIT_ERROR_CODE_COPY:\s*Record<EditMappingErrorCode,\s*string>/)
  })

  it('F10b: EDIT_ERROR_CODE_COPY surfaces TFM_REJECTED + TFM_ACKNOWLEDGED + DOMINANT_TABLE_CHANGED with intent-revealing copy', () => {
    const copyMap = sliceBetween(SRC, 'EDIT_ERROR_CODE_COPY', '\n}\n\n')
    expect(copyMap).toMatch(/TFM_REJECTED:/)
    expect(copyMap).toMatch(/TFM_ACKNOWLEDGED:/)
    expect(copyMap).toMatch(/DOMINANT_TABLE_CHANGED:/)
  })

  it('F10c: catches editMappingSources throws and falls back to INTERNAL copy', () => {
    const handlerBody = sliceBetween(SRC, 'const handleEditSave', 'const handleRefreshOnExistingTfm')
    expect(handlerBody).toMatch(/setErrorCode\(['"]INTERNAL['"]\)/)
    expect(handlerBody).toMatch(/EDIT_ERROR_CODE_COPY\.INTERNAL/)
  })
})

// ─────────────────────────────────────────────────────────────────────
// F11 — AI Suggest hidden in edit mode (founder §3)
// ─────────────────────────────────────────────────────────────────────

describe('[edit-mapping-form] AI Suggest hidden in edit mode', () => {
  it('F11a: showAISuggestRow gate references isEditMode (hides the AI Suggest row in edit mode)', () => {
    expect(SRC).toMatch(/showAISuggestRow[\s\S]{0,400}!isEditMode/)
  })

  it('F11b: auto-suggest mount-time effect short-circuits in edit mode', () => {
    expect(SRC).toMatch(/if\s*\(isEditMode\)\s*return/)
  })
})

// ─────────────────────────────────────────────────────────────────────
// F12 — onSaveSuccess invocation with EditSaveMeta
// ─────────────────────────────────────────────────────────────────────

describe('[edit-mapping-form] onSaveSuccess threading', () => {
  it('F12a: onSaveSuccess invoked with (tfmId, EditSaveMeta) on successful edit', () => {
    const handlerBody = sliceBetween(SRC, 'const handleEditSave', 'const handleRefreshOnExistingTfm')
    expect(handlerBody).toMatch(
      /onSaveSuccess\(\s*result\.tfmId\s*,\s*\{[\s\S]{0,400}mode:\s*['"]edit['"]/,
    )
  })

  it('F12b: EditSaveMeta carries tfmId + transformReset + stagedRowsReverted + nextStatus from result', () => {
    const handlerBody = sliceBetween(SRC, 'const handleEditSave', 'const handleRefreshOnExistingTfm')
    expect(handlerBody).toMatch(/tfmId:\s*result\.tfmId/)
    expect(handlerBody).toMatch(/transformReset:\s*result\.transformReset/)
    expect(handlerBody).toMatch(/stagedRowsReverted:\s*result\.stagedRowsReverted/)
    expect(handlerBody).toMatch(/nextStatus:\s*['"]needs_review['"]/)
  })
})
