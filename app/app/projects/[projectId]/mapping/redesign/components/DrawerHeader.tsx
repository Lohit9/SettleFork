'use client'

import { cn } from '@/components/ui/utils'
import { X } from '@/components/icons'
import type { MappingRow } from '@/lib/types/mappings-for-redesign'
import { formatConfidencePercent } from '@/lib/utils/confidence-format'

// ─────────────────────────────────────────────────────────────────────────────
// DrawerHeader — feat/mapping-drawer-header-redesign (compact mockup design).
// ─────────────────────────────────────────────────────────────────────────────
//
// Replaces the prior FROM/TO stack with per-source / per-target inline editing
// pencils (HeaderPencilButton, HeaderRemoveButton, AddSourceButton,
// HeaderStatusBadge). All those editing controls retired here:
//
//   • Primary source swap (single-source TFM) — flat view source-cell click.
//   • Non-primary source swap (multi-source TFM) — moves to drawer BODY
//     SOURCE column per-source pencil (commit 2 of this branch).
//   • Add source — moves to drawer BODY SOURCE column "+ Add source" button.
//   • Remove one source from multi-source — moves to drawer BODY SOURCE
//     column per-source ✕.
//   • Target swap — flat view target-cell click (drawer body's TARGET column
//     stays read-only).
//   • Whole-TFM removal — flat view row reject OR drawer body's
//     "Remove mapping" link.
//   • Status badge — folded into the new confidence line below the title.
//
// Layout (single row, 3 stacked text lines + close button right):
//
//   ┌───────────────────────────────────────────────────────────────┐
//   │ MAPPING                                                    ✕  │  row 1: label + close
//   │ ACCT_MASTER · ACCT_NO → accounts · customer_id                │  row 2: title
//   │ ● 98% confidence                                              │  row 3: confidence
//   └───────────────────────────────────────────────────────────────┘
//
// Per-variant matrix:
//
//   mapped, sources.length === 1
//     SRC_TBL · src_field → TGT_TBL · tgt_field
//
//   mapped, sources.length > 1 (multi-source)
//     SRC_TBL · src_field [+ N source] → TGT_TBL · tgt_field
//     (the pill is visual-only — not clickable; editing per-source lives
//      in the drawer body SOURCE column.)
//
//   value_assignment
//     Value assignment → TGT_TBL · tgt_field
//
//   unmapped (target-only)
//     TGT_TBL · tgt_field
//
// Status line varies by status:
//
//   approved      ● Approved              (emerald dot — no percentage)
//   needs_review  ● 54% needs review      (slate dot — confidence-gated)
//   rejected      ● Rejected              (slate dot — no percentage)
//
// Post-#157/#158/A2 'rejected' no longer carries a semantic distinct
// from 'needs_review' (Reject = reset), so its dot stays slate-400 to
// match the flat-view `FlatStatusDot` / `StatusDot` treatment.
//
// Approved / rejected render their label regardless of `row.confidence`
// — the user-facing concept is "what state is this in?", not a
// confidence number. needs_review still gates on `row.confidence` being
// non-null (percentage is the load-bearing affordance there).

export interface DrawerHeaderProps {
  row: MappingRow
  titleId: string
  onClose: () => void
}

type DrawerStatus = MappingRow['status']

const STATUS_CONFIG: Record<
  DrawerStatus,
  {
    /** Trailing word after `{pct}%` on the status line (needs_review only). */
    label: string
    /** Fill className for the 8px status dot. */
    dotClassName: string
    /** Optional halo ring className. Null = no ring (neutral states). */
    ringClassName: string | null
  }
> = {
  approved: {
    label: 'Approved',
    dotClassName: 'bg-emerald-500',
    ringClassName: 'ring-2 ring-emerald-500/25',
  },
  needs_review: {
    label: 'needs review',
    dotClassName: 'bg-slate-400',
    ringClassName: 'ring-2 ring-slate-400/25',
  },
  rejected: {
    // Post-#157/#158/A2 'rejected' collapses onto the needs_review
    // visual (Reject = reset — no distinct rejected semantic). Slate
    // dot + ring matches `FlatStatusDot` / MappingListView `StatusDot`.
    label: 'Rejected',
    dotClassName: 'bg-slate-400',
    ringClassName: 'ring-2 ring-slate-400/25',
  },
  unmapped: {
    label: 'unmapped',
    dotClassName: 'bg-gray-400',
    ringClassName: null,
  },
}

export function DrawerHeader({ row, titleId, onClose }: DrawerHeaderProps) {
  return (
    <header
      data-testid="mapping-drawer-header"
      className="border-b border-slate-200 bg-white px-6 py-4"
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          {/* Row 1: MAPPING label (small caps, muted). */}
          <div
            data-testid="mapping-drawer-header-label"
            className="text-[11px] font-medium uppercase tracking-wide text-slate-500"
          >
            Mapping
          </div>
          {/* Row 2: title — kind-specific. */}
          <h2
            id={titleId}
            data-testid="mapping-drawer-header-title"
            className="mt-1 flex min-w-0 flex-wrap items-center gap-y-1 text-base font-normal text-slate-900"
          >
            <DrawerTitle row={row} />
          </h2>
          {/* Row 3: confidence dot + label. */}
          <DrawerConfidenceLine row={row} />
        </div>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close drawer"
          data-testid="mapping-drawer-close"
          className={cn(
            'inline-flex h-6 w-6 flex-shrink-0 items-center justify-center rounded-md',
            'text-slate-400 transition-colors hover:bg-slate-100 hover:text-slate-700',
            'focus:outline-none focus-visible:ring-2 focus-visible:ring-slate-300',
          )}
        >
          <X className="h-3.5 w-3.5" />
        </button>
      </div>
    </header>
  )
}

// ── Title (kind-dispatched) ────────────────────────────────────────────────

function DrawerTitle({ row }: { row: MappingRow }) {
  if (row.kind === 'unmapped') {
    return (
      <TargetSideTitle
        tableName={row.targetField.targetTable.name}
        fieldName={row.targetField.name}
      />
    )
  }
  if (row.kind === 'value_assignment') {
    return (
      <>
        <span
          data-testid="mapping-drawer-header-title-source"
          className="italic text-slate-500"
        >
          Value assignment
        </span>
        <TitleArrow />
        <TargetSideTitle
          tableName={row.targetField.targetTable.name}
          fieldName={row.targetField.name}
        />
      </>
    )
  }
  // mapped
  const primary = row.sources[0]
  const extraSourceCount = row.sources.length - 1
  return (
    <>
      <SourceSideTitle
        tableName={primary.sourceTable.name}
        fieldName={primary.sourceField.name}
      />
      {extraSourceCount > 0 ? (
        <span
          data-testid="mapping-drawer-header-multi-source-pill"
          data-source-count={String(row.sources.length)}
          className="ml-1.5 inline-flex shrink-0 items-center rounded-full bg-slate-100 px-2 py-0.5 text-xs font-medium text-slate-600"
        >
          + {extraSourceCount} source
        </span>
      ) : null}
      <TitleArrow />
      <TargetSideTitle
        tableName={row.targetField.targetTable.name}
        fieldName={row.targetField.name}
      />
    </>
  )
}

function SourceSideTitle({
  tableName,
  fieldName,
}: {
  tableName: string
  fieldName: string
}) {
  return (
    <span
      data-testid="mapping-drawer-header-title-source"
      className="inline-flex min-w-0 items-center gap-1"
    >
      <TitleTableName name={tableName} />
      <TitleSeparator />
      <TitleFieldChip name={fieldName} />
    </span>
  )
}

function TargetSideTitle({
  tableName,
  fieldName,
}: {
  tableName: string
  fieldName: string
}) {
  return (
    <span
      data-testid="mapping-drawer-header-title-target"
      className="inline-flex min-w-0 items-center gap-1"
    >
      <TitleTableName name={tableName} />
      <TitleSeparator />
      <TitleFieldChip name={fieldName} />
    </span>
  )
}

function TitleTableName({ name }: { name: string }) {
  return (
    <span
      title={name}
      className="truncate text-[11px] font-medium uppercase tracking-wide text-slate-500"
    >
      {name}
    </span>
  )
}

function TitleSeparator() {
  return (
    <span aria-hidden="true" className="text-slate-300">
      ·
    </span>
  )
}

function TitleFieldChip({ name }: { name: string }) {
  return (
    <span
      title={name}
      className="inline-block max-w-full truncate rounded bg-slate-100 px-1.5 py-0.5 font-mono text-sm font-medium text-slate-700"
    >
      {name}
    </span>
  )
}

function TitleArrow() {
  return (
    <span aria-hidden="true" className="mx-1.5 text-slate-300">
      →
    </span>
  )
}

// ── Confidence line ────────────────────────────────────────────────────────

function DrawerConfidenceLine({ row }: { row: MappingRow }) {
  const config = STATUS_CONFIG[row.status]
  const isTerminal = row.status === 'approved' || row.status === 'rejected'
  // needs_review / 'unmapped' literal both gate on confidence presence —
  // the percentage is the load-bearing affordance for those states.
  // Approved / rejected always render: the user wants to see WHICH state
  // the row is in, regardless of whether a confidence number is on file.
  if (
    !isTerminal &&
    (row.confidence === null || row.confidence === undefined)
  ) {
    return null
  }
  return (
    <div
      data-testid="mapping-drawer-header-confidence"
      data-status={row.status}
      className="mt-2 flex items-center gap-2 text-xs text-slate-600"
    >
      <span
        aria-hidden="true"
        data-testid="mapping-drawer-header-confidence-dot"
        className={cn(
          'inline-block h-2 w-2 flex-shrink-0 rounded-full',
          config.dotClassName,
          config.ringClassName,
        )}
      />
      <span data-testid="mapping-drawer-header-confidence-text">
        {isTerminal ? (
          <span className="text-slate-700">{config.label}</span>
        ) : (
          <>
            <span className="tabular-nums text-slate-700">
              {formatConfidencePercent(row.confidence as number)}
            </span>
            <span className="ml-1">{config.label}</span>
          </>
        )}
      </span>
    </div>
  )
}
