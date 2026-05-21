// @vitest-environment node
//
// INF-57 cleanup — source-level invariant tests for the MappingDrawer
// un-approve state machine (replaces the prior W4 un-acknowledge surface
// after target_acknowledged collapsed into the canonical coverage-approved
// no-source path).
//
// Same source-level testing strategy as `mapping-drawer-edit.test.ts`:
// read the drawer source as a string and lock the founder-decision
// invariants via regex. The full-render Drawer behavior (open/close,
// header, subheader, A11y, approve/reject/edit) is covered by
// `mapping-drawer.test.tsx` and `mapping-drawer-edit.test.ts`; this
// file pins ONLY the additions for un-approve:
//
//   UN1.  Un-approve button is rendered inside UnmappedFooterButtons
//         (status='approved' branch) with the documented test-id and
//         copy.
//   UN2.  Visibility gate: button only renders inside the
//         `status === 'approved'` branch of UnmappedFooterButtons, NOT
//         on mapped / value_assignment / unmapped+needs_review /
//         unmapped+rejected.
//   UN3.  Click → confirm dialog opens; the actual server call fires
//         only from the dialog's confirm handler (no direct invocation
//         from the footer button).
//   UN4.  Cancel dialog → no `resetMappingStatus` call (the wrapper
//         is invoked exclusively from inside `handleUnapproveConfirm`).
//   UN5.  Confirm → invokes `resetMappingStatus({ rowId: row.id })` and
//         threads `onActionComplete?.('reset', targetRowId)` on success.
//   UN6.  Success path closes the dialog (drawer about to unmount;
//         `setConfirmUnapproveOpen(false)`) and does NOT clear the
//         in-flight flag (mirrors the reject path's "drawer is about
//         to unmount" pattern).

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
// UN1 — Un-approve button presence
// ─────────────────────────────────────────────────────────────────────

describe('[mapping-drawer-unapprove] UN1 — button presence', () => {
  it('UN1a: UnmappedFooterButtons renders the Un-approve button with the documented test-id and aria-label', () => {
    expect(SRC).toMatch(/data-testid="mapping-drawer-unapprove-button"/)
    expect(SRC).toMatch(/aria-label="Un-approve mapping"/)
  })

  it('UN1b: button copy is "Un-approve" (and "Un-approving…" in flight)', () => {
    const footer = sliceBetween(
      SRC,
      'function UnmappedFooterButtons',
      '\nfunction ',
    )
    // The button label appears as a string literal in the JSX
    // ternary (`'Un-approve'` / `'Un-approving…'`), not a text node —
    // match the literal form.
    expect(footer).toMatch(/['"]Un-approve['"]/)
    expect(footer).toMatch(/Un-approving…/)
  })

  it('UN1c: spinner renders the documented test-id while in flight', () => {
    expect(SRC).toMatch(/data-testid="mapping-drawer-unapprove-spinner"/)
  })

  it('UN1d: button is the SOLE control rendered for status=approved unmapped rows (Suggest/Create are gated to needs_review/unmapped only)', () => {
    const footer = sliceBetween(
      SRC,
      'function UnmappedFooterButtons',
      '\nfunction ',
    )
    // The status='approved' branch returns ONLY the un-approve button.
    // Suggest with AI / Create mapping live in the default needs_review/unmapped
    // branch and must NOT appear inside the approved sub-branch.
    const approvedBranchStart = footer.indexOf("status === 'approved'")
    expect(approvedBranchStart).toBeGreaterThan(0)
    const nextBranchStart = footer.indexOf("status === 'rejected'", approvedBranchStart)
    const approvedBranch = footer.slice(approvedBranchStart, nextBranchStart)
    expect(approvedBranch).toMatch(/data-testid="mapping-drawer-unapprove-button"/)
    expect(approvedBranch).not.toMatch(/data-testid="mapping-drawer-suggest-with-ai-button"/)
    expect(approvedBranch).not.toMatch(/data-testid="mapping-drawer-create-mapping-button"/)
  })
})

// ─────────────────────────────────────────────────────────────────────
// UN2 — Visibility gate
// ─────────────────────────────────────────────────────────────────────

describe('[mapping-drawer-unapprove] UN2 — visibility gate', () => {
  it("UN2a: Un-approve button is dispatched only inside the status === 'approved' branch of UnmappedFooterButtons", () => {
    const footer = sliceBetween(
      SRC,
      'function UnmappedFooterButtons',
      '\nfunction ',
    )
    // Match the dispatch shape: `if (status === 'approved') { ... <Un-approve button> ... }`
    expect(footer).toMatch(
      /status\s*===\s*['"]approved['"][\s\S]{0,1500}data-testid="mapping-drawer-unapprove-button"/,
    )
  })

  it('UN2b: ApproveRejectButtons (used for mapped/VA) does NOT render the unapprove test-id', () => {
    const approveReject = sliceBetween(
      SRC,
      'function ApproveRejectButtons',
      '\nfunction ',
    )
    expect(approveReject).not.toMatch(/mapping-drawer-unapprove-button/)
  })

  it('UN2c: the non-approved (needs_review / rejected) fall-through of UnmappedFooterButtons does NOT render the unapprove test-id', () => {
    const footer = sliceBetween(
      SRC,
      'function UnmappedFooterButtons',
      '\nfunction ',
    )
    // feat/reject-to-unmap collapsed the separate needs_review / rejected
    // branches into a single Approve-only fall-through that follows the
    // `status === 'approved'` block. Slice from the Approve-only button
    // (the fall-through) to end-of-function — it must not mention the
    // unapprove test-id, which belongs solely to the approved branch.
    const approveOnlyStart = footer.indexOf(
      'data-testid="mapping-drawer-approve-button"',
    )
    expect(approveOnlyStart).toBeGreaterThan(0)
    const tail = footer.slice(approveOnlyStart)
    expect(tail).not.toMatch(/mapping-drawer-unapprove-button/)
    // The unapprove test-id appears exactly once overall — in the
    // approved branch only.
    const occurrences =
      footer.split('mapping-drawer-unapprove-button').length - 1
    expect(occurrences).toBe(1)
  })
})

// ─────────────────────────────────────────────────────────────────────
// UN3 — Click → confirm dialog opens (NOT direct server call)
// ─────────────────────────────────────────────────────────────────────

describe('[mapping-drawer-unapprove] UN3 — confirm dialog opens', () => {
  it('UN3a: button onClick fires onUnapproveClick (does NOT call the server action directly)', () => {
    const footer = sliceBetween(
      SRC,
      'function UnmappedFooterButtons',
      '\nfunction ',
    )
    expect(footer).toMatch(/onClick=\{onUnapproveClick\}/)
    expect(footer).not.toMatch(/resetMappingStatus\(/)
  })

  it('UN3b: drawer wires onUnapproveClick → setConfirmUnapproveOpen(true)', () => {
    expect(SRC).toMatch(
      /onUnapproveClick=\{\(\)\s*=>\s*setConfirmUnapproveOpen\(true\)\}/,
    )
  })

  it('UN3c: UnapproveConfirmDialog component is mounted at the drawer root with the open state bound', () => {
    expect(SRC).toMatch(/<UnapproveConfirmDialog/)
    expect(SRC).toMatch(/open=\{confirmUnapproveOpen\}/)
  })

  it('UN3d: dialog has the documented test-id and copy', () => {
    expect(SRC).toMatch(
      /data-testid="mapping-drawer-unapprove-confirm-dialog"/,
    )
    expect(SRC).toMatch(/Un-approve this mapping\?/)
    expect(SRC).toMatch(/This will return[\s\S]{0,200}to needs review\. The mapping is unchanged\./)
  })
})

// ─────────────────────────────────────────────────────────────────────
// UN4 — Cancel dialog → no wrapper call
// ─────────────────────────────────────────────────────────────────────

describe('[mapping-drawer-unapprove] UN4 — cancel does not call wrapper', () => {
  it('UN4a: AlertDialogCancel resolves to setConfirmUnapproveOpen(false), NOT to handleUnapproveConfirm', () => {
    const dialog = sliceBetween(
      SRC,
      'function UnapproveConfirmDialog',
      '\n}\n',
    )
    // The Cancel button is the AlertDialogCancel — it does NOT call
    // resetMappingStatus. The action ONLY fires from the
    // AlertDialogAction's onConfirm handler.
    const cancelIdx = dialog.indexOf('AlertDialogCancel')
    const actionIdx = dialog.indexOf('AlertDialogAction')
    expect(cancelIdx).toBeGreaterThan(0)
    expect(actionIdx).toBeGreaterThan(cancelIdx)
    const cancelSlice = dialog.slice(cancelIdx, actionIdx)
    expect(cancelSlice).not.toMatch(/onConfirm/)
    expect(cancelSlice).not.toMatch(/resetMappingStatus/)
  })

  it('UN4b: cancel handler is gated by the in-flight flag (mirrors RejectConfirmDialog)', () => {
    const dialog = sliceBetween(
      SRC,
      'function UnapproveConfirmDialog',
      '\n}\n',
    )
    expect(dialog).toMatch(/!isUnapproving\)\s*onOpenChange\(false\)/)
  })

  it('UN4c: drawer-level onOpenChange refuses to close while a call is in flight', () => {
    expect(SRC).toMatch(
      /<UnapproveConfirmDialog[\s\S]{0,300}if\s*\(isUnapproving\)\s*return/,
    )
  })
})

// ─────────────────────────────────────────────────────────────────────
// UN5 — Confirm → server call wired correctly
// ─────────────────────────────────────────────────────────────────────

describe('[mapping-drawer-unapprove] UN5 — confirm triggers server call', () => {
  it('UN5a: drawer imports resetMappingStatus from the redesign actions module', () => {
    expect(SRC).toMatch(
      /import\s*\{[\s\S]{0,400}resetMappingStatus,?[\s\S]{0,400}\}\s*from\s*['"]@\/lib\/actions\/mappings-for-redesign['"]/,
    )
  })

  it('UN5b: handleUnapproveConfirm invokes resetMappingStatus with { rowId } recovered from the row identity', () => {
    const handler = sliceBetween(
      SRC,
      'const handleUnapproveConfirm = useCallback',
      ', [row, onActionComplete])',
    )
    // Recover targetRowId from row.id BEFORE the call.
    expect(handler).toMatch(/targetRowId\s*=\s*row\.id/)
    // Invoke resetMappingStatus with the documented input shape.
    expect(handler).toMatch(/resetMappingStatus\(\s*\{/)
    expect(handler).toMatch(/rowId:\s*targetRowId/)
  })

  it('UN5c: handler defensively no-ops on non-approved rows (status guard)', () => {
    const handler = sliceBetween(
      SRC,
      'const handleUnapproveConfirm = useCallback',
      ', [row, onActionComplete])',
    )
    expect(handler).toMatch(
      /row\.status\s*!==\s*['"]approved['"]/,
    )
  })

  it("UN5d: success path threads onActionComplete?.('reset', targetRowId) so the parent closes the drawer", () => {
    const handler = sliceBetween(
      SRC,
      'const handleUnapproveConfirm = useCallback',
      ', [row, onActionComplete])',
    )
    expect(handler).toMatch(
      /onActionComplete\?\.\(\s*['"]reset['"]\s*,\s*targetRowId\s*\)/,
    )
  })

  it("UN5e: onActionComplete prop signature widened to accept 'reset'", () => {
    // Multi-line prop signature — allow optional trailing commas after
    // each member and lenient whitespace including newlines.
    expect(SRC).toMatch(
      /onActionComplete\?:\s*\(\s*\n?\s*action:\s*['"]approve['"]\s*\|\s*['"]reject['"]\s*\|\s*['"]reset['"]\s*,\s*\n?\s*rowId:\s*string\s*,?\s*\n?\s*\)\s*=>\s*void/,
    )
  })
})

// ─────────────────────────────────────────────────────────────────────
// UN6 — Success / failure handling matches reject's shape
// ─────────────────────────────────────────────────────────────────────

describe('[mapping-drawer-unapprove] UN6 — drawer-close + error semantics', () => {
  it('UN6a: success path closes the dialog (drawer about to unmount); does NOT clear isUnapproving', () => {
    const handler = sliceBetween(
      SRC,
      'const handleUnapproveConfirm = useCallback',
      ', [row, onActionComplete])',
    )
    // After a successful server call:
    //   • setConfirmUnapproveOpen(false) → close dialog
    //   • onActionComplete?.('reset', ...)
    // We do NOT setIsUnapproving(false) on success because the
    // drawer will unmount (mirrors reject pattern).
    const successPath = handler.slice(handler.indexOf('result.success'))
    expect(successPath).toMatch(/setConfirmUnapproveOpen\(false\)/)
    expect(successPath).toMatch(
      /onActionComplete\?\.\(\s*['"]reset['"]/,
    )
    // The setIsUnapproving(false) call only appears in the !success
    // and catch branches of the handler.
    const successBlock = handler.slice(
      handler.indexOf("onActionComplete?.('reset'"),
      handler.indexOf('catch'),
    )
    expect(successBlock).not.toMatch(/setIsUnapproving\(false\)/)
  })

  it('UN6b: failure path clears in-flight + closes dialog + sets uniform error copy', () => {
    expect(SRC).toMatch(/GENERIC_UNAPPROVE_ERROR/)
    expect(SRC).toMatch(
      /Couldn't un-approve this mapping\. Please try again\./,
    )
  })

  it('UN6c: catch arm logs to console.error for ops triage', () => {
    const handler = sliceBetween(
      SRC,
      'const handleUnapproveConfirm = useCallback',
      ', [row, onActionComplete])',
    )
    expect(handler).toMatch(
      /\[MappingDrawer\] resetMappingStatus (failed|threw):/,
    )
  })

  it('UN6d: rowId reset effect clears un-approve state slots so a row switch can resume cleanly', () => {
    expect(SRC).toMatch(/setConfirmUnapproveOpen\(false\)\s*\n\s*setIsUnapproving\(false\)/)
  })
})
