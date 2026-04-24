'use client'

import { useCallback, useEffect, useId, useRef } from 'react'
import { cn } from '@/components/ui/utils'
import { X } from '@/components/icons'
import type {
  MappedRow,
  MappingRow,
  MappingSourceRef,
  TargetAcknowledgedRow,
} from '@/lib/types/mappings-for-redesign'
import { classifyMappedRow, type MappingRowRule } from '@/lib/utils/mapping-row-rules'
import { TableBadge } from './TableBadge'

// ─────────────────────────────────────────────────────────────────────────────
// MappingDrawer — Phase 3 Gap 7 shell.
// ─────────────────────────────────────────────────────────────────────────────
//
// Right-side drawer that opens when the user clicks a mapping row body.
// Gap 7 ships the SHELL ONLY:
//
//   • Sticky header with target field name + target TableBadge + close X
//   • Sticky subheader summarising sources/state per row kind
//   • Body placeholder ("Tab content coming in Gaps 8-10")
//   • Footer placeholder ("Actions coming in Gap 10")
//
// Tabs (Details / Source / Transform), action buttons, sample-value rendering,
// AI-reasoning text, and SQL editing are all explicitly DEFERRED to Gaps 8-10.
//
// LOCKED FOUNDER DECISIONS (do not re-litigate; see Gap 7 prompt):
//
//   • Width 520px, fixed.
//   • Position: `fixed inset-y-0 right-0` — covers viewport top to bottom,
//     INCLUDING the PageHeader area. No backdrop scrim under the mapping page.
//   • Slide-in from right via `translate-x-full` → `translate-x-0`, 150ms.
//     Respects `prefers-reduced-motion` (transition becomes 0 if media query
//     matches). The reduced-motion gate uses the `motion-reduce:` Tailwind
//     variant which keys off the same media query.
//   • Hand-rolled (no `@radix-ui/react-dialog`, no shadcn Sheet — we don't
//     ship the dep). Style mirrors `components/ui/alert-dialog.tsx` and
//     `components/ui/fix-drawer.tsx`. Founder Q5 decision.
//   • Header: target field name in mono + TableBadge for target table only.
//     Type info / required indicator are deferred to the Gap 8 Details tab
//     body — the header stays "which field am I configuring?" exclusively.
//     Founder Q3 decision.
//   • Subheader (this gap): per-row-kind summary line — see
//     `DrawerSubheader` below for the full matrix.
//   • A11y: `role="dialog"`, `aria-modal="true"`, `aria-labelledby` on the
//     field-name <h2>. NO focus trap — Tab can leave the drawer naturally
//     (founder Q2: drawer is "alongside content" semantically).
//   • Esc and click-outside both close. The click-outside detection is
//     handled in the parent (`MappingContent.tsx`) because the drawer is
//     position-fixed and its sibling page is the natural outside region.
//     This component owns ONLY Esc + the close button.
//
// LIGHT-MODE-ONLY INVARIANT
//
// This file MUST NOT use any Tailwind dark-prefix modifier. The grep
// invariant in `tests/lib/no-shim-in-redesign-path.test.ts` enforces it.
// See `FieldMappingRow.tsx` file header for the full rationale.

// ── Drawer width ───────────────────────────────────────────────────────────

/**
 * Drawer width in pixels. Exported so `MappingContent.tsx` can pad the
 * mapping content area to match (avoids hidden behind-drawer rows). Single
 * source of truth — change here, change everywhere.
 */
export const MAPPING_DRAWER_WIDTH_PX = 520

// ── Public API ────────────────────────────────────────────────────────────

export interface MappingDrawerProps {
  /**
   * Row to show in the drawer. When `null` the drawer renders nothing
   * (no DOM at all). The parent decides whether to keep the row prop in
   * sync with `isOpen` — this component does not animate exit on its own.
   */
  row: MappingRow | null
  /** Whether the drawer is currently open. */
  isOpen: boolean
  /**
   * Called when the user closes the drawer via the X button or the Esc
   * key. The parent should clear its `drawer=` URL param and clear the
   * row highlight in response.
   */
  onClose: () => void
}

/**
 * Right-side drawer shell. See file header for the full Gap 7 contract.
 */
export function MappingDrawer({ row, isOpen, onClose }: MappingDrawerProps) {
  const titleId = useId()
  const drawerRef = useRef<HTMLElement | null>(null)
  // Track the element that had focus before the drawer opened so we can
  // restore focus to it on close. We grab the active element synchronously
  // when `isOpen` flips from false → true; restoring on close happens in
  // the cleanup of the same effect.
  const triggerRef = useRef<HTMLElement | null>(null)

  // Stable-onClose ref so the document-level handlers below don't have
  // to re-bind on every render of the parent.
  const onCloseRef = useRef(onClose)
  useEffect(() => {
    onCloseRef.current = onClose
  }, [onClose])

  // Esc + outside-click + focus-restore — all gated behind `isOpen`.
  useEffect(() => {
    if (!isOpen) return
    triggerRef.current =
      typeof document !== 'undefined'
        ? (document.activeElement as HTMLElement | null)
        : null
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onCloseRef.current()
    }
    const onMouseDown = (e: MouseEvent) => {
      const target = e.target as Node | null
      if (target === null) return
      // If the click landed inside the drawer itself, ignore — the
      // close button has its own React onClick wiring.
      if (drawerRef.current && drawerRef.current.contains(target)) return
      // If the click landed on another clickable row body, let that
      // row's own onClick switch the drawer to it (don't close-then-
      // re-open in a single tick). We detect row bodies by their
      // documented data-testid.
      if (target instanceof Element) {
        const clickedRow = target.closest('[data-testid="field-mapping-row-body"]')
        if (clickedRow) return
      }
      onCloseRef.current()
    }
    document.addEventListener('keydown', onKeyDown)
    document.addEventListener('mousedown', onMouseDown)
    return () => {
      document.removeEventListener('keydown', onKeyDown)
      document.removeEventListener('mousedown', onMouseDown)
      // Defer focus restoration to the next tick so React's commit phase
      // has finished tearing down the drawer subtree first.
      const trigger = triggerRef.current
      if (trigger && typeof trigger.focus === 'function') {
        queueMicrotask(() => trigger.focus())
      }
    }
  }, [isOpen])

  const handleAsideRef = useCallback((node: HTMLElement | null) => {
    drawerRef.current = node
  }, [])

  if (!isOpen || !row) return null

  return (
    <aside
      ref={handleAsideRef}
      role="dialog"
      aria-modal="true"
      aria-labelledby={titleId}
      data-testid="mapping-drawer"
      className={cn(
        'fixed inset-y-0 right-0 z-30 flex flex-col',
        'border-l border-slate-200 bg-white shadow-[-4px_0_16px_-2px_rgba(15,23,42,0.08)]',
        'translate-x-0 transition-transform duration-150 ease-out',
        'motion-reduce:transition-none',
      )}
      style={{ width: `${MAPPING_DRAWER_WIDTH_PX}px` }}
    >
      <DrawerHeader row={row} titleId={titleId} onClose={onClose} />
      <DrawerSubheader row={row} />
      <DrawerBody />
      <DrawerFooter />
    </aside>
  )
}

// ── Header ─────────────────────────────────────────────────────────────────

function DrawerHeader({
  row,
  titleId,
  onClose,
}: {
  row: MappingRow
  titleId: string
  onClose: () => void
}) {
  return (
    <header
      data-testid="mapping-drawer-header"
      className="sticky top-0 z-10 flex items-center justify-between gap-3 border-b border-slate-200 bg-white px-5 py-4"
    >
      <div className="flex min-w-0 items-center gap-2">
        <h2
          id={titleId}
          data-testid="mapping-drawer-title"
          className="truncate font-mono text-base font-semibold text-slate-900"
          title={row.targetField.name}
        >
          {row.targetField.name}
        </h2>
        <TableBadge tableName={row.targetField.targetTable.name} />
      </div>
      <button
        type="button"
        onClick={onClose}
        aria-label="Close drawer"
        data-testid="mapping-drawer-close"
        className={cn(
          'inline-flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-md',
          'text-slate-400 transition-colors hover:bg-slate-100 hover:text-slate-700',
          'focus:outline-none focus-visible:ring-2 focus-visible:ring-slate-300',
        )}
      >
        <X className="h-4 w-4" />
      </button>
    </header>
  )
}

// ── Subheader (per-row-kind summary) ───────────────────────────────────────

/**
 * Sticky summary line directly under the header. The content varies by
 * row kind / rule per the Gap 7 founder spec:
 *
 *   Rule 1 (mapped, 1 source)        "from" + field [Badge]
 *   Rule 2 (same-table multi-source) "from" + comma-fields [Badge]
 *   Rule 3 (cross-table, 2 tables)   "from" + field [Badge], field [Badge]
 *   Rule 4 (3+ tables OR 5+ fields)  "from" + first 3 (field [Badge]) + "+ N more"
 *   Rule 5 (target_acknowledged)     "acknowledged — <reason>" (italic)
 *                                    or "acknowledged" alone if no reason
 *   Rule 6 (unmapped)                "no source mapped yet" (italic)
 *   VA                               "value assignment" (italic)
 *
 * Pure presentational. The classification call delegates to
 * `classifyMappedRow` so Rule semantics stay in one place.
 */
function DrawerSubheader({ row }: { row: MappingRow }) {
  return (
    <div
      data-testid="mapping-drawer-subheader"
      className="sticky z-[9] border-b border-slate-100 bg-white px-5 py-2.5 text-sm text-slate-500"
      style={{ top: 'var(--drawer-header-offset, 65px)' }}
    >
      <SubheaderContent row={row} />
    </div>
  )
}

function SubheaderContent({ row }: { row: MappingRow }) {
  switch (row.kind) {
    case 'mapped':
      return <MappedSubheader row={row} />
    case 'value_assignment':
      return (
        <span className="italic" data-testid="mapping-drawer-subheader-va">
          value assignment
        </span>
      )
    case 'target_acknowledged':
      return <AcknowledgedSubheader row={row} />
    case 'unmapped':
      return (
        <span className="italic" data-testid="mapping-drawer-subheader-unmapped">
          no source mapped yet
        </span>
      )
  }
}

function MappedSubheader({ row }: { row: MappedRow }) {
  if (row.sources.length === 0) {
    // Defensive: a 'mapped' row with zero sources is a contract violation
    // upstream (would be 'value_assignment' / 'target_acknowledged'). Fall
    // back to the unmapped phrasing rather than crashing.
    return <span className="italic">no source mapped yet</span>
  }
  const rule = classifyMappedRow(row.sources)
  return (
    <div
      className="flex flex-wrap items-center gap-x-2 gap-y-1"
      data-testid={`mapping-drawer-subheader-${rule}`}
    >
      <span>from</span>
      <SubheaderRuleBody rule={rule} sources={row.sources} />
    </div>
  )
}

const RULE_4_PREVIEW_LIMIT = 3

function SubheaderRuleBody({
  rule,
  sources,
}: {
  rule: MappingRowRule
  sources: MappingSourceRef[]
}) {
  switch (rule) {
    case 'rule_1': {
      const s = sources[0]!
      return (
        <span className="inline-flex items-center gap-2">
          <span className="font-mono text-slate-700">{s.sourceField.name}</span>
          <TableBadge tableName={s.sourceTable.name} />
        </span>
      )
    }
    case 'rule_2': {
      // All sources share a table by classifier guarantee; render one badge.
      const fieldList = sources.map((s) => s.sourceField.name).join(', ')
      return (
        <span className="inline-flex min-w-0 items-center gap-2">
          <span className="truncate font-mono text-slate-700" title={fieldList}>
            {fieldList}
          </span>
          <TableBadge tableName={sources[0]!.sourceTable.name} />
        </span>
      )
    }
    case 'rule_3': {
      // Cross-table, 2 tables. Render each source as `field [Badge]`,
      // comma-separated. We walk the sources in ordinal order — no client
      // sort — so per-source visual order matches the row.
      return (
        <>
          {sources.map((s, i) => (
            <span key={s.id} className="inline-flex items-center gap-2">
              <span className="font-mono text-slate-700">{s.sourceField.name}</span>
              <TableBadge tableName={s.sourceTable.name} />
              {i < sources.length - 1 ? <span aria-hidden="true">,</span> : null}
            </span>
          ))}
        </>
      )
    }
    case 'rule_4': {
      const preview = sources.slice(0, RULE_4_PREVIEW_LIMIT)
      const overflow = sources.length - preview.length
      return (
        <>
          {preview.map((s, i) => (
            <span key={s.id} className="inline-flex items-center gap-2">
              <span className="font-mono text-slate-700">{s.sourceField.name}</span>
              <TableBadge tableName={s.sourceTable.name} />
              {i < preview.length - 1 ? <span aria-hidden="true">,</span> : null}
            </span>
          ))}
          {overflow > 0 ? (
            <span
              className="text-slate-500"
              data-testid="mapping-drawer-subheader-more"
            >
              + {overflow} more
            </span>
          ) : null}
        </>
      )
    }
  }
}

function AcknowledgedSubheader({ row }: { row: TargetAcknowledgedRow }) {
  if (row.acknowledgmentReason) {
    return (
      <span data-testid="mapping-drawer-subheader-ack">
        <span>acknowledged — </span>
        <span className="italic">{row.acknowledgmentReason}</span>
      </span>
    )
  }
  return (
    <span className="italic" data-testid="mapping-drawer-subheader-ack">
      acknowledged
    </span>
  )
}

// ── Body & footer placeholders ─────────────────────────────────────────────

function DrawerBody() {
  return (
    <div
      data-testid="mapping-drawer-body"
      className="flex-1 overflow-auto px-5 py-8"
    >
      <p className="text-center text-sm text-slate-400">
        Tab content coming in Gaps 8-10
      </p>
    </div>
  )
}

function DrawerFooter() {
  return (
    <footer
      data-testid="mapping-drawer-footer"
      className="sticky bottom-0 z-10 border-t border-slate-200 bg-white px-5 py-3"
    >
      <p className="text-center text-sm text-slate-400">
        Actions coming in Gap 10
      </p>
    </footer>
  )
}
