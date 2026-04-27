// @vitest-environment node
//
// Phase 4b-2 — source-level invariant tests for the MappingDrawer
// un-acknowledge state machine (W4 surface).
//
// Same source-level testing strategy as `mapping-drawer-edit.test.ts`:
// read the drawer source as a string and lock the founder-decision
// invariants via regex. The full-render Drawer behavior (open/close,
// header, subheader, A11y, approve/reject/edit) is covered by
// `mapping-drawer.test.tsx` and `mapping-drawer-edit.test.ts`; this
// file pins ONLY the additions for un-acknowledge:
//
//   UN1.  Un-acknowledge button is rendered in AcknowledgedFooterButtons
//         (rightmost) with the documented test-id and copy.
//   UN2.  Visibility gate: button only renders inside the
//         `target_acknowledged` footer dispatch, NOT on mapped /
//         rejected / unmapped (those branches don't even mount the
//         component).
//   UN3.  Click → confirm dialog opens; the actual server call fires
//         only from the dialog's confirm handler (no direct invocation
//         from the footer button).
//   UN4.  Cancel dialog → no `unacknowledgeField` call (the wrapper
//         is invoked exclusively from inside `handleUnacknowledgeConfirm`).
//   UN5.  Confirm → invokes `unacknowledgeField({ projectId,
//         targetFieldId: row.targetField.id })` and threads
//         `onActionComplete?.('unacknowledge', targetRowId)` on success.
//   UN6.  Success path closes the dialog (drawer about to unmount;
//         `setConfirmUnacknowledgeOpen(false)`) and does NOT clear the
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
// UN1 — Un-acknowledge button presence
// ─────────────────────────────────────────────────────────────────────

describe('[mapping-drawer-unacknowledge] UN1 — button presence', () => {
  it('UN1a: AcknowledgedFooterButtons renders the Un-acknowledge button with the documented test-id and aria-label', () => {
    expect(SRC).toMatch(/data-testid="mapping-drawer-unacknowledge-button"/)
    expect(SRC).toMatch(/aria-label="Un-acknowledge field"/)
  })

  it('UN1b: button copy is "Un-acknowledge" (and "Un-acknowledging…" in flight)', () => {
    const ackFooter = sliceBetween(
      SRC,
      'function AcknowledgedFooterButtons',
      '\n// ── ',
    )
    // The button label appears as a string literal in the JSX
    // ternary (`'Un-acknowledge'` / `'Un-acknowledging…'`), not a
    // text node — match the literal form.
    expect(ackFooter).toMatch(/['"]Un-acknowledge['"]/)
    expect(ackFooter).toMatch(/Un-acknowledging…/)
  })

  it('UN1c: spinner renders the documented test-id while in flight', () => {
    expect(SRC).toMatch(/data-testid="mapping-drawer-unacknowledge-spinner"/)
  })

  it('UN1d: button is the SOLE control in AcknowledgedFooterButtons (Q11.A — disabled Approve/Reject removed)', () => {
    // Drawer redesign Q11.A: AcknowledgedFooterButtons no longer
    // renders the disabled [Reject] / [Approve] siblings (they were
    // visual noise — un-acknowledging is the only meaningful action
    // for an ack row). Verify Approve and Reject are absent and the
    // un-acknowledge button is the lone footer control.
    const ackFooter = sliceBetween(
      SRC,
      'function AcknowledgedFooterButtons',
      '\nfunction ',
    )
    expect(ackFooter).not.toMatch(/data-testid="mapping-drawer-approve-button"/)
    expect(ackFooter).not.toMatch(/data-testid="mapping-drawer-reject-button"/)
    expect(ackFooter).toMatch(
      /data-testid="mapping-drawer-unacknowledge-button"/,
    )
  })
})

// ─────────────────────────────────────────────────────────────────────
// UN2 — Visibility gate
// ─────────────────────────────────────────────────────────────────────

describe('[mapping-drawer-unacknowledge] UN2 — visibility gate', () => {
  it("UN2a: AcknowledgedFooterButtons is dispatched only inside the row.kind === 'target_acknowledged' branch of DrawerFooter", () => {
    expect(SRC).toMatch(
      /row\.kind\s*===\s*['"]target_acknowledged['"]\s*\?[\s\S]{0,400}<AcknowledgedFooterButtons/,
    )
  })

  it('UN2b: ApproveRejectButtons (used for mapped/rejected) does NOT render the unacknowledge test-id', () => {
    const approveReject = sliceBetween(
      SRC,
      'function ApproveRejectButtons',
      '\nfunction ',
    )
    expect(approveReject).not.toMatch(/mapping-drawer-unacknowledge-button/)
  })

  it('UN2c: UnmappedFooterButtons does NOT render the unacknowledge test-id', () => {
    const unmappedFooter = sliceBetween(
      SRC,
      'function UnmappedFooterButtons',
      '\nfunction ',
    )
    expect(unmappedFooter).not.toMatch(/mapping-drawer-unacknowledge-button/)
  })
})

// ─────────────────────────────────────────────────────────────────────
// UN3 — Click → confirm dialog opens (NOT direct server call)
// ─────────────────────────────────────────────────────────────────────

describe('[mapping-drawer-unacknowledge] UN3 — confirm dialog opens', () => {
  it('UN3a: button onClick fires onUnacknowledgeClick (does NOT call the server action directly)', () => {
    const ackFooter = sliceBetween(
      SRC,
      'function AcknowledgedFooterButtons',
      '\nfunction ',
    )
    expect(ackFooter).toMatch(/onClick=\{onUnacknowledgeClick\}/)
    expect(ackFooter).not.toMatch(/unacknowledgeField\(/)
  })

  it('UN3b: drawer wires onUnacknowledgeClick → setConfirmUnacknowledgeOpen(true)', () => {
    expect(SRC).toMatch(
      /onUnacknowledgeClick=\{\(\)\s*=>\s*setConfirmUnacknowledgeOpen\(true\)\}/,
    )
  })

  it('UN3c: UnacknowledgeConfirmDialog component is mounted at the drawer root with the open state bound', () => {
    expect(SRC).toMatch(/<UnacknowledgeConfirmDialog/)
    expect(SRC).toMatch(/open=\{confirmUnacknowledgeOpen\}/)
  })

  it('UN3d: dialog has the documented test-id and copy', () => {
    expect(SRC).toMatch(
      /data-testid="mapping-drawer-unacknowledge-confirm-dialog"/,
    )
    expect(SRC).toMatch(/Un-acknowledge this field\?/)
    expect(SRC).toMatch(/return\s+\{?\s*[\s\S]{0,80}\}?\s*to unmapped \(Rule 6\)/)
  })
})

// ─────────────────────────────────────────────────────────────────────
// UN4 — Cancel dialog → no wrapper call
// ─────────────────────────────────────────────────────────────────────

describe('[mapping-drawer-unacknowledge] UN4 — cancel does not call wrapper', () => {
  it('UN4a: AlertDialogCancel resolves to setConfirmUnacknowledgeOpen(false), NOT to handleUnacknowledgeConfirm', () => {
    const dialog = sliceBetween(
      SRC,
      'function UnacknowledgeConfirmDialog',
      '\n}\n',
    )
    // The Cancel button is the AlertDialogCancel — it does NOT call
    // unacknowledgeField. The action ONLY fires from the
    // AlertDialogAction's onConfirm handler.
    const cancelIdx = dialog.indexOf('AlertDialogCancel')
    const actionIdx = dialog.indexOf('AlertDialogAction')
    expect(cancelIdx).toBeGreaterThan(0)
    expect(actionIdx).toBeGreaterThan(cancelIdx)
    const cancelSlice = dialog.slice(cancelIdx, actionIdx)
    expect(cancelSlice).not.toMatch(/onConfirm/)
    expect(cancelSlice).not.toMatch(/unacknowledgeField/)
  })

  it('UN4b: cancel handler is gated by the in-flight flag (mirrors RejectConfirmDialog)', () => {
    const dialog = sliceBetween(
      SRC,
      'function UnacknowledgeConfirmDialog',
      '\n}\n',
    )
    expect(dialog).toMatch(/!isUnacknowledging\)\s*onOpenChange\(false\)/)
  })

  it('UN4c: drawer-level onOpenChange refuses to close while a call is in flight', () => {
    expect(SRC).toMatch(
      /<UnacknowledgeConfirmDialog[\s\S]{0,300}if\s*\(isUnacknowledging\)\s*return/,
    )
  })
})

// ─────────────────────────────────────────────────────────────────────
// UN5 — Confirm → server call wired correctly
// ─────────────────────────────────────────────────────────────────────

describe('[mapping-drawer-unacknowledge] UN5 — confirm triggers server call', () => {
  it('UN5a: drawer imports unacknowledgeField from the redesign actions module', () => {
    expect(SRC).toMatch(
      /import\s*\{[\s\S]{0,400}unacknowledgeField,?[\s\S]{0,400}\}\s*from\s*['"]@\/lib\/actions\/mappings-for-redesign['"]/,
    )
  })

  it('UN5b: handleUnacknowledgeConfirm invokes unacknowledgeField with { projectId, targetFieldId } (recovered from row.targetField.id)', () => {
    const handler = sliceBetween(
      SRC,
      'const handleUnacknowledgeConfirm = useCallback',
      ', [row, projectId, onActionComplete])',
    )
    // Recover targetFieldId from row.targetField.id BEFORE the call.
    expect(handler).toMatch(/targetFieldId\s*=\s*row\.targetField\.id/)
    // Invoke unacknowledgeField with the documented input shape.
    // Object shorthand `{ projectId, targetFieldId }` is preferred over
    // explicit key:value pairs — match either form.
    expect(handler).toMatch(/unacknowledgeField\(\s*\{/)
    expect(handler).toMatch(/projectId/)
    expect(handler).toMatch(/targetFieldId\b/)
  })

  it('UN5c: handler defensively no-ops on non-target_acknowledged rows', () => {
    const handler = sliceBetween(
      SRC,
      'const handleUnacknowledgeConfirm = useCallback',
      ', [row, projectId, onActionComplete])',
    )
    expect(handler).toMatch(
      /row\.kind\s*!==\s*['"]target_acknowledged['"]/,
    )
  })

  it("UN5d: success path threads onActionComplete?.('unacknowledge', targetRowId) so the parent closes the drawer", () => {
    const handler = sliceBetween(
      SRC,
      'const handleUnacknowledgeConfirm = useCallback',
      ', [row, projectId, onActionComplete])',
    )
    expect(handler).toMatch(
      /onActionComplete\?\.\(\s*['"]unacknowledge['"]\s*,\s*targetRowId\s*\)/,
    )
  })

  it("UN5e: onActionComplete prop signature widened to accept 'unacknowledge'", () => {
    // Multi-line prop signature — allow optional trailing commas after
    // each member and lenient whitespace including newlines.
    expect(SRC).toMatch(
      /onActionComplete\?:\s*\(\s*action:\s*['"]approve['"]\s*\|\s*['"]reject['"]\s*\|\s*['"]unacknowledge['"]\s*,\s*rowId:\s*string\s*,?\s*\)\s*=>\s*void/,
    )
  })
})

// ─────────────────────────────────────────────────────────────────────
// UN6 — Success / failure handling matches reject's shape
// ─────────────────────────────────────────────────────────────────────

describe('[mapping-drawer-unacknowledge] UN6 — drawer-close + error semantics', () => {
  it('UN6a: success path closes the dialog (drawer about to unmount); does NOT clear isUnacknowledging', () => {
    const handler = sliceBetween(
      SRC,
      'const handleUnacknowledgeConfirm = useCallback',
      ', [row, projectId, onActionComplete])',
    )
    // After a successful server call:
    //   • setConfirmUnacknowledgeOpen(false) → close dialog
    //   • onActionComplete?.('unacknowledge', ...)
    // We do NOT setIsUnacknowledging(false) on success because the
    // drawer will unmount (mirrors reject pattern).
    const successPath = handler.slice(handler.indexOf('result.success'))
    expect(successPath).toMatch(/setConfirmUnacknowledgeOpen\(false\)/)
    expect(successPath).toMatch(
      /onActionComplete\?\.\(\s*['"]unacknowledge['"]/,
    )
    // The setIsUnacknowledging(false) call only appears in the !success
    // and catch branches of the handler.
    const successBlock = handler.slice(
      handler.indexOf('onActionComplete?.(\'unacknowledge\''),
      handler.indexOf('catch'),
    )
    expect(successBlock).not.toMatch(/setIsUnacknowledging\(false\)/)
  })

  it('UN6b: failure path clears in-flight + closes dialog + sets uniform error copy', () => {
    expect(SRC).toMatch(/GENERIC_UNACKNOWLEDGE_ERROR/)
    expect(SRC).toMatch(
      /Couldn't un-acknowledge this field\. Please try again\./,
    )
  })

  it('UN6c: catch arm logs to console.error for ops triage', () => {
    const handler = sliceBetween(
      SRC,
      'const handleUnacknowledgeConfirm = useCallback',
      ', [row, projectId, onActionComplete])',
    )
    expect(handler).toMatch(
      /\[MappingDrawer\] unacknowledgeField (failed|threw):/,
    )
  })

  it('UN6d: rowId reset effect clears unacknowledge state slots so a row switch can resume cleanly', () => {
    expect(SRC).toMatch(/setConfirmUnacknowledgeOpen\(false\)\s*\n\s*setIsUnacknowledging\(false\)/)
  })
})
