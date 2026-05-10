// @vitest-environment node
//
// Phase 4b-1 — source-level invariant tests for the MappingDrawer
// edit-mode state machine.
//
// The full-render Drawer behavior (closed/open, header, subheader, A11y,
// approve/reject) is exhaustively covered by `mapping-drawer.test.tsx`.
// These tests lock in the founder-decision-driven additions:
//
//   D1.  Edit button is rendered (rightmost in the
//        ApproveRejectButtons footer) with the documented test-id.
//   D2.  Edit visibility gate hides the affordance on rejected /
//        unmapped / custom_sql rows (founder §3.2-§3.3).
//   D3.  `handleEditClick` builds `editInitialState` from the row's
//        sources (selectedIds in ordinal order; joinAnnotations
//        recovered from each cross-table source's `joinSpec.viaFkField`,
//        founder §5.2).
//   D4.  Setting `editFormActive=true` switches the drawer body to the
//        form (mode='edit') and routes the footer through the edit
//        branch.
//   D5.  `EditFooterButtons` renders Cancel + Save changes with the
//        documented test-ids and a shared "inflight" disable rule
//        (preview OR save in flight → both disabled).
//   D6.  `handleEditSavePrecheck` runs `previewEditInvalidation`
//        before save; if the preview reports a transform with
//        staged rows, populates `editInvalidationPreview` so the
//        EditInvalidationDialog renders. Otherwise calls
//        `formRef.current.triggerSave()` directly (founder §6.1).

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const DRAWER_PATH = resolve(
  __dirname,
  '../../app/app/projects/[projectId]/mapping/redesign/components/MappingDrawer.tsx',
)
const SRC = readFileSync(DRAWER_PATH, 'utf8')

function sliceBetween(src: string, startMarker: string, endMarker: string): string {
  const a = src.indexOf(startMarker)
  if (a < 0) throw new Error(`marker not found: ${startMarker}`)
  const b = src.indexOf(endMarker, a + startMarker.length)
  if (b < 0)
    throw new Error(`end marker not found after ${startMarker}: ${endMarker}`)
  return src.slice(a, b)
}

// ─────────────────────────────────────────────────────────────────────
// D1 — Edit pencil presence (drawer-redesign Q11.A lock)
// ─────────────────────────────────────────────────────────────────────
//
// The drawer redesign relocated the legacy footer "Edit" button to an
// inline pencil affordance in the Sources section header (Q11.A lock).
// The pencil reads as a section-scoped action ("edit these sources"),
// which scopes the verb correctly and frees footer real estate at
// 480px drawer width. The legacy `mapping-drawer-edit-button` test-id
// is regression-guarded as gone.

describe('[mapping-drawer-edit] D1 — Edit pencil presence', () => {
  it('D1a: renders the Edit pencil with `mapping-drawer-edit-pencil` test-id', () => {
    expect(SRC).toMatch(/data-testid="mapping-drawer-edit-pencil"/)
    expect(SRC).toMatch(/aria-label="Edit mapping sources"/)
  })

  it('D1b: legacy footer Edit button (`mapping-drawer-edit-button`) is REMOVED', () => {
    expect(SRC).not.toMatch(/data-testid="mapping-drawer-edit-button"/)
    // Legacy aria-label is gone too (the new pencil uses a different
    // label so the surface reads as "edit these sources" rather than
    // a generic row-level verb).
    expect(SRC).not.toMatch(/aria-label="Edit mapping"\s/)
  })

  it('D1c: pencil mounts inside MappedBody as Sources section headerAside (Q11.A — section-scoped affordance)', () => {
    // The pencil is rendered as `headerAside` of the Sources DrawerSection
    // by MappedBody; ApproveRejectButtons no longer carries any
    // Edit-button slot.
    const fnMatch = SRC.match(
      /function ApproveRejectButtons[\s\S]+?\n\}\n/,
    )
    expect(fnMatch).not.toBeNull()
    expect(fnMatch![0]).not.toMatch(/showEditButton/)
    expect(fnMatch![0]).not.toMatch(/mapping-drawer-edit-button/)
  })
})

// ─────────────────────────────────────────────────────────────────────
// D2 — Edit visibility gate (drawer-redesign Q11.A lock)
// ─────────────────────────────────────────────────────────────────────

describe('[mapping-drawer-edit] D2 — Edit visibility gate', () => {
  it('D2a: pencil renders inside MappedBody + UnmappedBody (Phase E PR α expansion); VA does NOT mount it', () => {
    // Phase E PR α: the pencil affordance also mounts inside
    // UnmappedBody — mirrors the grid's source-cell pencil and gives
    // the drawer parity with the inline grid for no-source rows.
    // INF-57 cleanup (2026-05-10) folded AcknowledgedBody into
    // UnmappedBody, so coverage-approved no-source rows pick up the
    // pencil affordance for free as collateral effect of the body
    // unification (locked design decision 3). VA still doesn't mount
    // the pencil — VA expression authoring lives on the Transform tab.
    const mappedBody = sliceBetween(SRC, 'function MappedBody', '\n}\n')
    expect(mappedBody).toMatch(/<EditPencilButton/)
    const unmappedBody = sliceBetween(SRC, 'function UnmappedBody', '\n}\n')
    expect(unmappedBody).toMatch(/<EditPencilButton/)
    const vaBody = sliceBetween(SRC, 'function ValueAssignmentBody', '\n}\n')
    expect(vaBody).not.toMatch(/<EditPencilButton/)
  })

  it('D2b: pencil hidden on rejected status (Q11.A — only needs_review / approved show it)', () => {
    const mappedBody = sliceBetween(SRC, 'function MappedBody', '\n}\n')
    expect(mappedBody).toMatch(
      /showEditPencil\s*=\s*[\s\S]{0,300}row\.status\s*===\s*['"]needs_review['"]\s*\|\|\s*row\.status\s*===\s*['"]approved['"]/,
    )
  })

  it('D2c: pencil hidden on custom_sql combinations (Transform-tab concern, not source-list)', () => {
    const mappedBody = sliceBetween(SRC, 'function MappedBody', '\n}\n')
    expect(mappedBody).toMatch(
      /showEditPencil\s*=\s*[\s\S]{0,400}row\.combinationType\s*!==\s*['"]custom_sql['"]/,
    )
  })

  it('D2d: handleEditClick defensively bails on custom_sql (defense in depth)', () => {
    const handler = sliceBetween(SRC, 'const handleEditClick', 'const handleEditFormCancel')
    expect(handler).toMatch(/row\.combinationType\s*===\s*['"]custom_sql['"]/)
  })

  it('D2e: handleEditClick defensively bails on non-mapped rows AND non-{needs_review,approved} statuses', () => {
    const handler = sliceBetween(SRC, 'const handleEditClick', 'const handleEditFormCancel')
    expect(handler).toMatch(/row\.kind\s*!==\s*['"]mapped['"]/)
    expect(handler).toMatch(
      /row\.status\s*!==\s*['"]approved['"]\s*&&\s*row\.status\s*!==\s*['"]needs_review['"]/,
    )
  })
})

// ─────────────────────────────────────────────────────────────────────
// D3 — handleEditClick builds editInitialState
// ─────────────────────────────────────────────────────────────────────

describe('[mapping-drawer-edit] D3 — handleEditClick builds editInitialState', () => {
  it('D3a: extracts selectedIds from row.sources in ordinal order (no client sort — server emits ordinal-asc)', () => {
    const handler = sliceBetween(SRC, 'const handleEditClick', 'const handleEditFormCancel')
    expect(handler).toMatch(
      /sourceFieldIds\s*=\s*row\.sources\.map\(\s*\(\s*s\s*\)\s*=>\s*s\.sourceField\.id\s*\)/,
    )
  })

  it('D3b: recovers joinAnnotations from each cross-table source\'s joinSpec.viaFkField (founder §5.2)', () => {
    const handler = sliceBetween(SRC, 'const handleEditClick', 'const handleEditFormCancel')
    expect(handler).toMatch(/joinAnnotations:\s*Record<string,\s*string>\s*=\s*\{\}/)
    expect(handler).toMatch(/if\s*\(\s*src\.joinSpec\s*\)/)
    expect(handler).toMatch(
      /joinAnnotations\[\s*src\.sourceTable\.id\s*\]\s*=\s*src\.joinSpec\.viaFkField/,
    )
  })

  it('D3c: setEditInitialState payload carries tfmId + selectedIds + combinationType + joinAnnotations', () => {
    const handler = sliceBetween(SRC, 'const handleEditClick', 'const handleEditFormCancel')
    expect(handler).toMatch(/setEditInitialState\(\s*\{[\s\S]{0,400}tfmId:\s*row\.id/)
    expect(handler).toMatch(/selectedIds:\s*sourceFieldIds/)
    expect(handler).toMatch(/combinationType:\s*row\.combinationType/)
    expect(handler).toMatch(/joinAnnotations,?/)
  })

  it('D3d: handleEditClick flips editFormActive=true at the end (after state is populated)', () => {
    const handler = sliceBetween(SRC, 'const handleEditClick', 'const handleEditFormCancel')
    const setStateIdx = handler.indexOf('setEditInitialState(')
    const flipIdx = handler.indexOf('setEditFormActive(true)')
    expect(setStateIdx).toBeGreaterThan(0)
    expect(flipIdx).toBeGreaterThan(setStateIdx)
  })
})

// ─────────────────────────────────────────────────────────────────────
// D4 — body + footer mode switch
// ─────────────────────────────────────────────────────────────────────

describe('[mapping-drawer-edit] D4 — body + footer mode switch', () => {
  it('D4a: footer dispatches to EditFooterButtons when editFormActive && row.kind === "mapped"', () => {
    expect(SRC).toMatch(
      /if\s*\(\s*editFormActive\s*&&\s*row\.kind\s*===\s*['"]mapped['"]\s*\)/,
    )
    expect(SRC).toMatch(/<EditFooterButtons/)
  })

  it('D4b: drawer body threads editFormActive into MappedBody/Footer for the mode switch', () => {
    // Both DrawerBody and DrawerFooter receive `editFormActive`.
    expect(SRC).toMatch(/editFormActive\?:\s*boolean|editFormActive:\s*boolean/)
    const bodyProp = SRC.match(/editFormActive=\{editFormActive\}/g)
    expect(bodyProp).not.toBeNull()
    // DrawerBody + DrawerFooter both receive it (≥ 2 occurrences).
    expect((bodyProp ?? []).length).toBeGreaterThanOrEqual(2)
  })

  it('D4c: handleEditFormCancel clears all edit-mode state (returns the body to MappedBody)', () => {
    const handler = sliceBetween(SRC, 'const handleEditFormCancel', 'const handleEditSavePrecheck')
    expect(handler).toMatch(/setEditFormActive\(false\)/)
    expect(handler).toMatch(/setEditInitialState\(null\)/)
    expect(handler).toMatch(/setEditInvalidationPreview\(null\)/)
    expect(handler).toMatch(/setEditPreviewError\(null\)/)
  })
})

// ─────────────────────────────────────────────────────────────────────
// D5 — EditFooterButtons rendering
// ─────────────────────────────────────────────────────────────────────

describe('[mapping-drawer-edit] D5 — EditFooterButtons rendering', () => {
  it('D5a: renders a [Cancel] button with `mapping-drawer-edit-cancel-button` test-id', () => {
    expect(SRC).toMatch(/data-testid="mapping-drawer-edit-cancel-button"/)
    expect(SRC).toMatch(/aria-label="Cancel editing mapping"/)
  })

  it('D5b: renders a [Save changes] button with `mapping-drawer-edit-save-button` test-id', () => {
    expect(SRC).toMatch(/data-testid="mapping-drawer-edit-save-button"/)
    expect(SRC).toMatch(/aria-label="Save mapping changes"/)
    expect(SRC).toMatch(/Save changes/)
  })

  it('D5c: shared "inflight" rule disables Cancel and Save while preview OR save is in flight', () => {
    const fn = sliceBetween(SRC, 'function EditFooterButtons', '\n}\n')
    expect(fn).toMatch(/inflight\s*=\s*formIsSavePending\s*\|\|\s*isEditPreviewPending/)
    // Cancel disabled by `inflight`.
    expect(fn).toMatch(/disabled=\{inflight\}/)
    // Save disabled by `!formCanSave || inflight`.
    expect(fn).toMatch(/disabled=\{\s*!formCanSave\s*\|\|\s*inflight\s*\}/)
  })

  it('D5d: Save button shows a spinner with `mapping-drawer-edit-save-spinner` test-id while inflight', () => {
    expect(SRC).toMatch(/data-testid="mapping-drawer-edit-save-spinner"/)
  })
})

// ─────────────────────────────────────────────────────────────────────
// D6 — preview-then-save flow
// ─────────────────────────────────────────────────────────────────────

describe('[mapping-drawer-edit] D6 — preview-then-save flow', () => {
  it('D6a: handleEditSavePrecheck calls previewEditInvalidation with the editing TFM id', () => {
    const handler = sliceBetween(
      SRC,
      'const handleEditSavePrecheck',
      'const handleEditInvalidationConfirm',
    )
    expect(handler).toMatch(
      /previewEditInvalidation\(\s*editInitialState\.tfmId\s*\)/,
    )
  })

  it('D6b: when preview reports `hasTransform && stagedRowCount > 0`, populates editInvalidationPreview and short-circuits before triggerSave', () => {
    const handler = sliceBetween(
      SRC,
      'const handleEditSavePrecheck',
      'const handleEditInvalidationConfirm',
    )
    expect(handler).toMatch(
      /shouldWarn\s*=\s*result\.hasTransform\s*&&\s*result\.stagedRowCount\s*>\s*0/,
    )
    expect(handler).toMatch(/setEditInvalidationPreview\(\s*\{[\s\S]{0,300}hasTransform:/)
    // Early-return after populating the preview (so the dialog
    // controls the next step).
    expect(handler).toMatch(/if\s*\(shouldWarn\)\s*\{[\s\S]{0,400}return/)
  })

  it('D6c: when no warn condition, calls formRef.current?.triggerSave() directly', () => {
    const handler = sliceBetween(
      SRC,
      'const handleEditSavePrecheck',
      'const handleEditInvalidationConfirm',
    )
    expect(handler).toMatch(/formRef\.current\?\.triggerSave\(\)/)
  })

  it('D6d: handleEditInvalidationConfirm clears the preview AND triggers the save', () => {
    const handler = sliceBetween(
      SRC,
      'const handleEditInvalidationConfirm',
      'const handleEditInvalidationCancel',
    )
    expect(handler).toMatch(/setEditInvalidationPreview\(null\)/)
    expect(handler).toMatch(/formRef\.current\?\.triggerSave\(\)/)
  })

  it('D6e: handleEditInvalidationCancel clears the preview and stays in edit mode', () => {
    const handler = sliceBetween(
      SRC,
      'const handleEditInvalidationCancel',
      'const handleEditFormSaveSuccess',
    )
    expect(handler).toMatch(/setEditInvalidationPreview\(null\)/)
    // Does NOT flip editFormActive=false (user remains in edit mode).
    expect(handler).not.toMatch(/setEditFormActive\(false\)/)
    expect(handler).not.toMatch(/triggerSave\(/)
  })

  it('D6f: handleEditSavePrecheck guards against double-fire (formState.isSavePending || isEditPreviewPending → no-op)', () => {
    const handler = sliceBetween(
      SRC,
      'const handleEditSavePrecheck',
      'const handleEditInvalidationConfirm',
    )
    expect(handler).toMatch(
      /if\s*\(formState\.isSavePending\s*\|\|\s*isEditPreviewPending\)\s*return/,
    )
  })

  it('D6g: EditInvalidationDialog is rendered with the preview state and the matching confirm/cancel handlers', () => {
    expect(SRC).toMatch(/<EditInvalidationDialog/)
    expect(SRC).toMatch(/preview=\{editInvalidationPreview\}/)
    expect(SRC).toMatch(/onConfirm=\{handleEditInvalidationConfirm\}/)
    expect(SRC).toMatch(/onCancel=\{handleEditInvalidationCancel\}/)
  })
})
