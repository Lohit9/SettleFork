import { cn } from '@/components/ui/utils'
import type {
  MappingRow,
  MappingTransformationStatus,
} from '@/lib/types/mappings-for-redesign'

// ─────────────────────────────────────────────────────────────────────────────
// FieldMappingRow — Phase 3 Gap 4c.
// ─────────────────────────────────────────────────────────────────────────────
//
// Minimal, read-only rendering of a single MappingRow. Proves the grouped
// target-table view works end-to-end over real Heritage data; row interaction
// (drawer, chevron, approve/reject buttons) is deferred to later gaps.
//
// Not rendered (deliberately, per Gap 4c scope):
//   • Source column — Rules 1-6 ship in Gap 5.
//   • Chevron / expansion chrome — Gap 5 for same-table concats, Gap 6 for
//     cross-table rows.
//   • Click-to-open-drawer — Gaps 7-10.
//   • Action buttons (approve / reject / remove) — Gap 5 or later.
//
// What IS rendered:
//   • target field name in mono for schema-nomenclature alignment
//   • confidence (2-decimal) OR em-dash when null
//   • status chip (dot + label) matching legacy visual vocabulary for
//     consistency during the Phase 3 → 5 transition
//   • tiny transformation-state indicator dot when hasTransformation=true

interface FieldMappingRowProps {
  row: MappingRow
}

export function FieldMappingRow({ row }: FieldMappingRowProps) {
  return (
    <div
      role="listitem"
      data-testid="field-mapping-row"
      data-row-kind={row.kind}
      className="flex items-center gap-4 px-5 py-2.5 text-sm"
    >
      {/* Target field name — primary identity column */}
      <div className="flex min-w-0 flex-1 items-center gap-2">
        <span
          className="truncate font-mono text-[13px] text-gray-900 dark:text-gray-100"
          title={row.targetField.name}
        >
          {row.targetField.name}
        </span>
        {row.targetField.isNullable === false ? (
          <span
            className="rounded bg-slate-100 px-1 py-0.5 text-[10px] font-medium text-slate-500 dark:bg-slate-800 dark:text-slate-400"
            title="NOT NULL"
          >
            required
          </span>
        ) : null}
      </div>

      {/* Confidence — fixed right-aligned cell so eyes can scan vertically */}
      <div className="w-16 flex-shrink-0 text-right tabular-nums text-xs text-gray-500">
        <ConfidenceCell confidence={row.confidence} />
      </div>

      {/* Status dot + label */}
      <div className="w-32 flex-shrink-0">
        <StatusChip status={row.status} />
      </div>

      {/* Transformation indicator — only when a transformation row exists */}
      <div className="w-5 flex-shrink-0">
        {row.hasTransformation ? (
          <TransformationIndicator status={row.transformationStatus} />
        ) : null}
      </div>
    </div>
  )
}

// ─── Confidence cell ─────────────────────────────────────────────────────────

function ConfidenceCell({ confidence }: { confidence: number | null }) {
  if (confidence === null) {
    return (
      <span className="text-gray-300" aria-label="no confidence">
        —
      </span>
    )
  }
  return <span className="text-gray-600">{formatConfidence(confidence)}</span>
}

/**
 * 2-decimal precision per Gap 4c spec. Accepts either a 0-100 integer
 * (legacy storage convention) or a 0-1 fraction (defensive — contract
 * documents the former but DB decimals can drift) and renders the 0-100
 * form with 2 decimals. Values >1 are assumed already 0-100.
 */
function formatConfidence(confidence: number): string {
  const normalized = confidence > 1 ? confidence : confidence * 100
  return `${normalized.toFixed(2)}%`
}

// ─── Status chip (dot + label) ───────────────────────────────────────────────
// Matches legacy MappingContent.tsx:95-121 visual vocabulary exactly so the
// redesign and legacy pages read consistently during the Phase 3 rollout.

type RowStatus = MappingRow['status']

function StatusChip({ status }: { status: RowStatus }) {
  const config = STATUS_CONFIG[status]
  return (
    <div
      className="flex items-center gap-1.5"
      aria-label={`status: ${config.label}`}
    >
      <span
        aria-hidden="true"
        className={cn('h-1.5 w-1.5 flex-shrink-0 rounded-full', config.dotClassName)}
      />
      <span className={cn('text-xs', config.labelClassName)}>{config.label}</span>
    </div>
  )
}

const STATUS_CONFIG: Record<
  RowStatus,
  { label: string; dotClassName: string; labelClassName: string }
> = {
  approved: {
    label: 'Approved',
    dotClassName: 'bg-green-500',
    labelClassName: 'text-settle-slate-500',
  },
  needs_review: {
    label: 'Needs Review',
    dotClassName: 'bg-amber-400',
    labelClassName: 'text-settle-slate-500',
  },
  rejected: {
    label: 'Rejected',
    dotClassName: 'bg-red-500',
    labelClassName: 'text-settle-slate-400',
  },
  unmapped: {
    label: 'Unmapped',
    dotClassName: 'bg-settle-slate-300',
    labelClassName: 'text-settle-slate-400',
  },
}

// ─── Transformation indicator ────────────────────────────────────────────────
// Tiny colored dot communicating the transformation lifecycle. Only rendered
// when `row.hasTransformation === true`.

function TransformationIndicator({
  status,
}: {
  status: MappingTransformationStatus | null
}) {
  const { className, label } = TRANSFORM_INDICATOR_CONFIG[status ?? 'draft']
  return (
    <span
      aria-label={`transformation: ${label}`}
      title={`Transformation ${label}`}
      className={cn('inline-block h-1.5 w-1.5 rounded-full', className)}
    />
  )
}

const TRANSFORM_INDICATOR_CONFIG: Record<
  MappingTransformationStatus,
  { className: string; label: string }
> = {
  applied: { className: 'bg-green-500', label: 'applied' },
  stale: { className: 'bg-red-500', label: 'stale' },
  draft: { className: 'bg-amber-400', label: 'draft' },
  tested: { className: 'bg-amber-400', label: 'tested' },
  saved: { className: 'bg-amber-400', label: 'saved' },
}
