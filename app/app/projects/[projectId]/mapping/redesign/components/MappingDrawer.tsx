'use client'

import { useCallback, useEffect, useId, useRef } from 'react'
import { cn } from '@/components/ui/utils'
import { X } from '@/components/icons'
import type {
  MappedRow,
  MappingRow,
  MappingSourceRef,
  TargetAcknowledgedRow,
  TargetFieldRef,
  UnmappedRow,
  ValueAssignmentRow,
} from '@/lib/types/mappings-for-redesign'
import { classifyMappedRow, type MappingRowRule } from '@/lib/utils/mapping-row-rules'
import { formatSampleValues } from '@/lib/utils/mapping-drawer-format'
import { TableBadge } from './TableBadge'

// ─────────────────────────────────────────────────────────────────────────────
// MappingDrawer — Phase 3 Gaps 7 + 8a + 8b.
// ─────────────────────────────────────────────────────────────────────────────
//
// Right-side drawer that opens when the user clicks a mapping row body.
//
// Gap 7 (shipped d0f8c58): the shell — sticky header with target field name +
// target TableBadge + close X, sticky rule-specific subheader, scrollable body,
// sticky footer placeholder, Esc / outside-click close, focus restore.
//
// Gap 8a (shipped f9d2896): body content for non-mapped row kinds.
//
// Gap 8b (this gap): body content for mapped rows (Rules 1-4) — per-source
// roster + combination strategy + row-level reasoning + row-level confidence.
// Removes the Gap 8a "Mapped row drawer body — coming in Gap 8b" placeholder.
//
// Final body kind dispatch:
//
//   target_acknowledged → AcknowledgedBody     (Target field / Acknowledgment /
//                                               Status)
//   unmapped            → UnmappedBody         (Target field / Mapping status)
//   value_assignment    → ValueAssignmentBody  (Target field / Value expression /
//                                               AI reasoning / Confidence / Status)
//   mapped              → MappedBody           (Target field / Sources /
//                                               [Combination] / AI reasoning /
//                                               Confidence / Status)
//
// Footer remains the Gap 7 placeholder; action buttons are Gap 9. The drawer is
// deliberately tab-LESS; the spec's Details/Source/Transform tabs were retired
// at Gap 7 in favour of kind-dispatched single-page bodies. Founder Q3.
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
      <DrawerBody row={row} />
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

// ── Body — kind-dispatched (Gap 8a) ────────────────────────────────────────
//
// The wrapping `<div data-testid="mapping-drawer-body">` is preserved so:
//   • The outside-click handler in `MappingDrawer` (line ~130) can still
//     test `drawerRef.current.contains(target)` against any descendant.
//   • Existing Gap 7 tests that use `mapping-drawer-body` to fire `mousedown`
//     on a non-closing target keep passing.
// Inside the wrapper, content is dispatched on `row.kind`:
//   target_acknowledged → AcknowledgedBody
//   unmapped            → UnmappedBody
//   value_assignment    → ValueAssignmentBody
//   mapped              → MappedBody (still a placeholder; Gap 8b)

function DrawerBody({ row }: { row: MappingRow }) {
  return (
    <div
      data-testid="mapping-drawer-body"
      className="flex-1 overflow-auto px-6 py-5"
    >
      <BodyContent row={row} />
    </div>
  )
}

function BodyContent({ row }: { row: MappingRow }) {
  switch (row.kind) {
    case 'mapped':
      return <MappedBody row={row} />
    case 'value_assignment':
      return <ValueAssignmentBody row={row} />
    case 'target_acknowledged':
      return <AcknowledgedBody row={row} />
    case 'unmapped':
      return <UnmappedBody row={row} />
  }
}

// ── Body primitives — shared across kinds ──────────────────────────────────
//
// Three light primitives keep the kind bodies declarative and the visual
// language (small-caps section title, generous spacing, no border separators)
// in one place. They are intentionally thin wrappers — extracting them into
// their own files is premature until Gap 8b confirms the conventions hold for
// the more complex mapped-row roster.

/**
 * Stacked section with a small-caps title and arbitrary children. Spacing
 * is `mb-6` between sections (clean Linear / Notion vibe — no border rules).
 */
function DrawerSection({
  title,
  testId,
  children,
}: {
  title: string
  testId: string
  children: React.ReactNode
}) {
  return (
    <section className="mb-6 last:mb-0" data-testid={testId}>
      <h3 className="mb-2 text-xs font-medium uppercase tracking-wide text-slate-500">
        {title}
      </h3>
      <div>{children}</div>
    </section>
  )
}

/**
 * Stacked label/value pair. `mono` switches the value to `font-mono` (used
 * for field names, data types, and other identifier-shaped values). Empty
 * `value` is supported but callers should reach for `<DrawerEmptyState />`
 * for readability when the field is intentionally absent.
 */
function DrawerField({
  label,
  value,
  mono = false,
  testId,
}: {
  label: string
  value: string
  mono?: boolean
  testId?: string
}) {
  return (
    <div className="mb-3 last:mb-0" data-testid={testId}>
      <div className="text-xs text-slate-500">{label}</div>
      <div
        className={cn(
          'text-sm text-slate-900',
          mono && 'font-mono',
        )}
      >
        {value}
      </div>
    </div>
  )
}

/**
 * Italic muted line for "field intentionally absent" states. Visually
 * matches the row-level em-dash treatment from Gap 5a so the drawer reads
 * consistently with the rows underneath it.
 */
function DrawerEmptyState({
  text,
  testId,
}: {
  text: string
  testId?: string
}) {
  return (
    <p
      className="text-sm italic text-slate-400"
      data-testid={testId}
    >
      {text}
    </p>
  )
}

// ── Shared "Target field" section (used by every kind body) ────────────────

/**
 * Reused by all four kinds. Shows target name + TableBadge on the first
 * line, then `<dataType> · <required|nullable>` underneath. The target field
 * identity is the one constant across every drawer body.
 */
function TargetFieldSection({ targetField }: { targetField: TargetFieldRef }) {
  return (
    <DrawerSection title="Target field" testId="drawer-section-target-field">
      <div className="space-y-1.5">
        <div className="flex flex-wrap items-center gap-2">
          <span
            className="font-mono text-sm text-slate-900"
            data-testid="drawer-target-field-name"
          >
            {targetField.name}
          </span>
          <TableBadge tableName={targetField.targetTable.name} />
        </div>
        <div
          className="text-xs text-slate-500"
          data-testid="drawer-target-field-meta"
        >
          <span className="font-mono">{targetField.dataType}</span>
          <span className="mx-1.5 text-slate-300" aria-hidden="true">·</span>
          <span>{targetField.isNullable ? 'nullable' : 'required'}</span>
        </div>
      </div>
    </DrawerSection>
  )
}

// ── Shared "Status" section (Rule 5 + VA) ──────────────────────────────────
//
// Mirrors the row-level `STATUS_CONFIG` literal in `FieldMappingRow.tsx`. The
// duplication is small (one config map) and deliberate: refactoring into a
// shared module is premature until Gap 9's footer wires up the same vocabulary
// for Approve / Reject buttons. At that point a single source of truth makes
// sense — currently the change would be churn for two callers.

type DrawerStatus = MappingRow['status']

const DRAWER_STATUS_CONFIG: Record<
  DrawerStatus,
  { label: string; dotClassName: string }
> = {
  approved: { label: 'Approved', dotClassName: 'bg-green-500' },
  needs_review: { label: 'Needs Review', dotClassName: 'bg-amber-400' },
  rejected: { label: 'Rejected', dotClassName: 'bg-red-500' },
  unmapped: { label: 'Unmapped', dotClassName: 'bg-slate-300' },
}

function StatusSection({ status }: { status: DrawerStatus }) {
  const cfg = DRAWER_STATUS_CONFIG[status]
  return (
    <DrawerSection title="Status" testId="drawer-section-status">
      <div
        className="flex items-center gap-2"
        data-testid="drawer-status-indicator"
      >
        <span
          aria-hidden="true"
          className={cn('h-2 w-2 flex-shrink-0 rounded-full', cfg.dotClassName)}
        />
        <span className="text-sm text-slate-900">{cfg.label}</span>
      </div>
    </DrawerSection>
  )
}

// ── Rule 5 — Target Acknowledged ───────────────────────────────────────────

/**
 * Acknowledged-row drawer body.
 *
 * NOTE on omitted fields (Gap 8a contract-shape decision, 2026-04-24):
 * The Gap 8a spec mentions optional `acknowledgmentNotes`, `acknowledgedBy`,
 * and `acknowledgedAt` rows. The redesign data contract
 * (`lib/types/mappings-for-redesign.ts` `TargetAcknowledgedRow`) currently
 * exposes ONLY `acknowledgmentReason`. The other three fields are not on the
 * wire and not surfaced in the underlying server action. They are deferred
 * pending a contract change — adding them here would require expanding
 * `TargetAcknowledgedRow`, the translator, and the read-path tests in
 * lockstep. Out of scope for Gap 8a per the original prompt's constraint
 * "do NOT touch lib/actions/mappings-for-redesign.ts or types".
 */
function AcknowledgedBody({ row }: { row: TargetAcknowledgedRow }) {
  return (
    <>
      <TargetFieldSection targetField={row.targetField} />
      <DrawerSection title="Acknowledgment" testId="drawer-section-acknowledgment">
        {row.acknowledgmentReason ? (
          <p
            className="text-sm text-slate-900"
            data-testid="drawer-acknowledgment-reason"
          >
            {row.acknowledgmentReason}
          </p>
        ) : (
          <DrawerEmptyState
            text="No reason recorded"
            testId="drawer-acknowledgment-reason-empty"
          />
        )}
      </DrawerSection>
      <StatusSection status={row.status} />
    </>
  )
}

// ── Rule 6 — Unmapped ──────────────────────────────────────────────────────

const UNMAPPED_BODY_PROSE =
  'This target field has no source mapping yet. Use AI Suggest from the Mapping page to generate a proposal, or acknowledge this field as intentionally unmapped.'

/**
 * Unmapped-row drawer body. No status section — unmapped state is implicit
 * from the prose.
 *
 * TODO(Gap 9): replace the empty-state prose with an inline "Suggest mapping"
 * action button when the action footer lands. The current copy is the
 * read-only Gap 8a equivalent ("here's what to do, but no buttons yet").
 */
function UnmappedBody({ row }: { row: UnmappedRow }) {
  return (
    <>
      <TargetFieldSection targetField={row.targetField} />
      <DrawerSection title="Mapping status" testId="drawer-section-mapping-status">
        <p
          className="text-sm text-slate-600"
          data-testid="drawer-unmapped-prose"
        >
          {UNMAPPED_BODY_PROSE}
        </p>
      </DrawerSection>
    </>
  )
}

// ── VA — Value Assignment ──────────────────────────────────────────────────

/**
 * Value-assignment drawer body.
 *
 * `combinationSql` is the single field that distinguishes a VA from any other
 * row in the drawer view. We render it in a code block (slate-50 bg, mono,
 * `whitespace-pre-wrap` so multi-line SQL preserves formatting). Long lines
 * are allowed to scroll horizontally to keep the multiline reading pose.
 *
 * The status section uses the actual `row.status` (not hardcoded "Approved").
 * VAs are nominally created at `'approved'` but the contract permits all three
 * states (`'needs_review' | 'approved' | 'rejected'`); rendering the actual
 * value avoids lying to the user when they are mid-review.
 */
function ValueAssignmentBody({ row }: { row: ValueAssignmentRow }) {
  return (
    <>
      <TargetFieldSection targetField={row.targetField} />

      <DrawerSection title="Value expression" testId="drawer-section-value-expression">
        {row.combinationSql ? (
          <pre
            className="overflow-x-auto whitespace-pre-wrap break-words rounded bg-slate-50 p-3 font-mono text-xs text-slate-900"
            data-testid="drawer-value-expression"
          >
            {row.combinationSql}
          </pre>
        ) : (
          <DrawerEmptyState
            text="No expression authored yet"
            testId="drawer-value-expression-empty"
          />
        )}
      </DrawerSection>

      <DrawerSection title="AI reasoning" testId="drawer-section-ai-reasoning">
        {row.aiReasoning ? (
          <p
            className="text-sm italic text-slate-600"
            data-testid="drawer-ai-reasoning"
          >
            {row.aiReasoning}
          </p>
        ) : (
          <DrawerEmptyState
            text="No reasoning available"
            testId="drawer-ai-reasoning-empty"
          />
        )}
      </DrawerSection>

      <DrawerSection title="Confidence" testId="drawer-section-confidence">
        {row.confidence !== null ? (
          <span
            className="text-sm tabular-nums text-slate-900"
            data-testid="drawer-confidence"
          >
            {formatConfidence(row.confidence)}
          </span>
        ) : (
          <span
            aria-label="no confidence available"
            className="inline-flex items-center text-sm text-slate-400"
            data-testid="drawer-confidence-empty"
          >
            <span aria-hidden="true">—</span>
          </span>
        )}
      </DrawerSection>

      <StatusSection status={row.status} />
    </>
  )
}

/**
 * Shared with `FieldMappingRow.tsx` semantically — accepts either the
 * 0-100 integer storage convention or a 0-1 fraction defensively, renders
 * 2-decimal percentage. Mirrors row-level Gap 5a vocabulary.
 */
function formatConfidence(confidence: number): string {
  const normalized = confidence > 1 ? confidence : confidence * 100
  return `${normalized.toFixed(2)}%`
}

// ── Mapped row body — Gap 8b ───────────────────────────────────────────────
//
// Per-source roster + combination strategy + row-level reasoning/confidence.
// Sections:
//
//   1. Target field      (reused — TargetFieldSection)
//   2. Sources           (per-source roster, 1+ SourceCards)
//   3. Combination       (multi-source rows only — sources.length >= 2)
//   4. AI reasoning      (row-level; empty-state when null since absence is
//                         meaningful at the row level — contrast with
//                         per-source reasoning, which silently omits)
//   5. Confidence        (row-level)
//   6. Status            (reused — StatusSection)
//
// Source ordering invariant: `sources[]` is server-emitted in ordinal-asc
// order. The roster MUST iterate verbatim — no client-side sort. The
// codebase grep invariant in `tests/lib/no-shim-in-redesign-path.test.ts`
// guards this for the redesign path generally.

/**
 * Combination-type → human-readable phrase. Defensive over the full enum
 * even though `'single'` is functionally unreachable in the rendered output
 * (the Combination section is gated on `sources.length >= 2`, while
 * `combinationType: 'single'` only ever appears with `sources.length === 1`
 * per migration 074 STEP 5 and the contract JSDoc). Keeping all four
 * entries:
 *
 *   • Exhaustive maps catch enum widening at compile time without ad-hoc
 *     `default:` branches.
 *   • If a future contract drift produces `'single'` on a multi-source
 *     row, this renders a sensible label instead of throwing.
 */
const COMBINATION_TYPE_LABELS: Record<MappedRow['combinationType'], string> = {
  single: 'Use single source',
  concat_space: 'Concatenate with space',
  concat_comma: 'Concatenate with comma',
  custom_sql: 'Custom SQL expression',
}

/**
 * Mapped-row drawer body. Reuses Gap 8a primitives wherever possible
 * (`TargetFieldSection`, `StatusSection`, `DrawerSection`, `DrawerEmptyState`,
 * `formatConfidence`).
 */
function MappedBody({ row }: { row: MappedRow }) {
  const isMultiSource = row.sources.length >= 2
  return (
    <>
      <TargetFieldSection targetField={row.targetField} />
      <SourcesSection sources={row.sources} />
      {isMultiSource ? (
        <CombinationSection
          combinationType={row.combinationType}
          combinationSql={row.combinationSql}
        />
      ) : null}
      <RowAiReasoningSection aiReasoning={row.aiReasoning} />
      <RowConfidenceSection confidence={row.confidence} />
      <StatusSection status={row.status} />
    </>
  )
}

/**
 * Per-source roster wrapper. Always renders the "Sources" section header
 * for visual consistency with the rest of the drawer body — including for
 * Rule 1 (single source). See Gap 8b investigation report Q1 for the
 * consistency-over-density rationale.
 *
 * `sources[]` is iterated verbatim (no `.sort()` — server ordinal order is
 * authoritative).
 */
function SourcesSection({ sources }: { sources: MappingSourceRef[] }) {
  return (
    <DrawerSection title="Sources" testId="drawer-section-sources">
      <ul className="space-y-3" data-testid="drawer-sources-list">
        {sources.map((source) => (
          <SourceCard key={source.id} source={source} />
        ))}
      </ul>
    </DrawerSection>
  )
}

/**
 * Per-source card. Layout (founder decision 1):
 *
 *   [TableBadge] field_name        confidence    (join: …)
 *   Sample values
 *   v1, v2, v3, v4 (... (+N more) when truncated)
 *   <italic per-source reasoning>
 *
 * Sample-values block omits entirely when `sampleValues` is empty (silent).
 * Per-source reasoning omits entirely when null (silent — sources without
 * reasoning are common; an empty-state would clutter). Contrast with the
 * row-level reasoning section, which DOES surface absence.
 *
 * No card border — vertical whitespace separates cards. Matches the
 * Linear/Notion-style aesthetic established in Gap 8a.
 */
function SourceCard({ source }: { source: MappingSourceRef }) {
  const samplesLine = formatSampleValues(source.sampleValues)
  return (
    <li className="space-y-1.5" data-testid="drawer-source-card">
      <div className="flex min-w-0 flex-wrap items-center gap-2">
        <TableBadge tableName={source.sourceTable.name} />
        <span
          className="truncate font-mono text-sm text-slate-900"
          data-testid="drawer-source-field-name"
          title={source.sourceField.name}
        >
          {source.sourceField.name}
        </span>
        <span
          className="ml-auto flex-shrink-0 tabular-nums text-xs text-slate-500"
          data-testid="drawer-source-confidence"
        >
          {formatSourceConfidence(source.confidence)}
        </span>
        {source.joinAnnotation ? (
          <span
            className="basis-full text-xs italic text-slate-500"
            data-testid="drawer-source-join"
          >
            (join: {source.joinAnnotation})
          </span>
        ) : null}
      </div>

      {samplesLine !== '' ? (
        <div data-testid="drawer-source-samples">
          <div className="text-xs text-slate-500">Sample values</div>
          <div className="break-words text-xs text-slate-600">
            {samplesLine}
          </div>
        </div>
      ) : null}

      {source.aiReasoning ? (
        <p
          className="text-sm italic text-slate-600"
          data-testid="drawer-source-reasoning"
        >
          {source.aiReasoning}
        </p>
      ) : null}
    </li>
  )
}

/**
 * Combination strategy. Renders the human-readable label for the
 * `combinationType`; when `combinationType === 'custom_sql'` AND
 * `combinationSql` is non-null, also renders the SQL in a code block whose
 * styling matches `ValueAssignmentBody`'s Value expression block exactly
 * (consistency for the same visual primitive across body kinds).
 *
 * Caller-gated on `sources.length >= 2` — single-source rows never see
 * this section.
 */
function CombinationSection({
  combinationType,
  combinationSql,
}: {
  combinationType: MappedRow['combinationType']
  combinationSql: string | null
}) {
  const label = COMBINATION_TYPE_LABELS[combinationType]
  const showSql = combinationType === 'custom_sql' && combinationSql !== null
  return (
    <DrawerSection title="Combination" testId="drawer-section-combination">
      <div
        className="text-sm text-slate-900"
        data-testid="drawer-combination-label"
      >
        {label}
      </div>
      {showSql ? (
        <pre
          className="mt-2 overflow-x-auto whitespace-pre-wrap break-words rounded bg-slate-50 p-3 font-mono text-xs text-slate-900"
          data-testid="drawer-combination-sql"
        >
          {combinationSql}
        </pre>
      ) : null}
    </DrawerSection>
  )
}

/**
 * Row-level AI reasoning. Surfaces an empty-state when null — at the row
 * level, "no reasoning" IS information (the AI couldn't justify the
 * mapping, the user should know). Per-source reasoning by contrast is
 * silently omitted when absent.
 */
function RowAiReasoningSection({ aiReasoning }: { aiReasoning: string | null }) {
  return (
    <DrawerSection title="AI reasoning" testId="drawer-section-ai-reasoning">
      {aiReasoning ? (
        <p
          className="text-sm italic text-slate-600"
          data-testid="drawer-ai-reasoning"
        >
          {aiReasoning}
        </p>
      ) : (
        <DrawerEmptyState
          text="No reasoning available"
          testId="drawer-ai-reasoning-empty"
        />
      )}
    </DrawerSection>
  )
}

/**
 * Row-level confidence. Mirrors the VA body's Confidence section exactly —
 * percentage when non-null, em-dash with sr-only label when null. Always
 * rendered (including for Rule 1 even though the value duplicates the
 * single source's confidence) per Gap 8b investigation Q2 — consistency
 * with the rest of the drawer body wins over the marginal density saving.
 */
function RowConfidenceSection({ confidence }: { confidence: number | null }) {
  return (
    <DrawerSection title="Confidence" testId="drawer-section-confidence">
      {confidence !== null ? (
        <span
          className="text-sm tabular-nums text-slate-900"
          data-testid="drawer-confidence"
        >
          {formatConfidence(confidence)}
        </span>
      ) : (
        <span
          aria-label="no confidence available"
          className="inline-flex items-center text-sm text-slate-400"
          data-testid="drawer-confidence-empty"
        >
          <span aria-hidden="true">—</span>
        </span>
      )}
    </DrawerSection>
  )
}

/**
 * Per-source confidence formatter. Identical algorithm to `formatConfidence`
 * (2-decimal percentage, accepts 0-1 fraction or 0-100 integer storage), but
 * returns an em-dash for `null` — per-source rows can carry null confidence
 * per the contract, and we want a quiet glyph rather than throwing or
 * showing "0.00%".
 */
function formatSourceConfidence(confidence: number | null): string {
  if (confidence === null) return '—'
  return formatConfidence(confidence)
}

// ── Footer — still the Gap 7 placeholder (Gap 9 fills with action buttons) ─

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
