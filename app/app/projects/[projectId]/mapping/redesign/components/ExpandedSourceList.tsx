import { TableBadge } from './TableBadge'
import type { MappingSourceRef } from '@/lib/types/mappings-for-redesign'

// ─────────────────────────────────────────────────────────────────────────────
// ExpandedSourceList — Phase 3 Gap 5b.
// ─────────────────────────────────────────────────────────────────────────────
//
// Per-source bullet lines rendered below a collapsed Rule 2/3/4 row when the
// user clicks its chevron. Read-only inspection surface only — no edit
// controls, no AI reasoning, no combination SQL (those live in the drawer per
// spec §Expanded view does NOT include).
//
// Structure (spec §Expanded view):
//   ● [TableBadge] Field1               92.00%
//   ● [TableBadge] Field2               85.00%   (join: PrimaryContactID)
//   ● [TableBadge] Field3               78.00%
//
// joinAnnotation is pre-computed server-side (Gap 4b) and is ALWAYS null for
// same-table sources (Rule 2). For Rule 3/4 cross-table sources the dominant
// source still has `joinAnnotation === null` (it IS the anchor); non-dominant
// sources carry the annotation (e.g. "(join: PrimaryContactID)" derived from
// the FK field in the dominant table).
//
// ─── Light-mode-only ─────────────────────────────────────────────────────────
// No dark-prefix Tailwind modifiers. See `FieldMappingRow.tsx` file header
// for the full rationale; `tests/lib/no-shim-in-redesign-path.test.ts`
// enforces the invariant at CI time.

import type { MappingRowRule } from '@/lib/utils/mapping-row-rules'

interface ExpandedSourceListProps {
  sources: MappingSourceRef[]
  /**
   * The parent row's classifier result. Kept on the prop signature so future
   * rule-specific micro-renders (e.g., Rule 4 per-table sub-grouping) can land
   * without widening the API later. Not consumed today — the expanded view is
   * visually identical across Rule 2/3/4 per spec §Expanded view.
   */
  rule: Extract<MappingRowRule, 'rule_2' | 'rule_3' | 'rule_4'>
  /** DOM id so the parent row's chevron button can wire aria-controls. */
  id?: string
}

export function ExpandedSourceList({ sources, rule, id }: ExpandedSourceListProps) {
  void rule // Reserved for future per-rule micro-variations (see JSDoc).

  return (
    <div
      id={id}
      role="list"
      aria-label="Source fields"
      data-testid="expanded-source-list"
      className="overflow-hidden bg-slate-50/60"
    >
      <ul className="space-y-1 px-5 py-3 pl-10">
        {sources.map((source) => (
          <SourceBullet key={source.id} source={source} />
        ))}
      </ul>
    </div>
  )
}

function SourceBullet({ source }: { source: MappingSourceRef }) {
  return (
    <li
      data-testid="expanded-source-bullet"
      className="flex min-w-0 items-center gap-2 text-[13px]"
    >
      <span aria-hidden="true" className="text-slate-400">
        •
      </span>
      <TableBadge tableName={source.sourceTable.name} />
      <span
        className="truncate font-mono text-[13px] text-slate-700"
        title={source.sourceField.name}
      >
        {source.sourceField.name}
      </span>
      <span
        className="ml-auto flex-shrink-0 tabular-nums text-xs text-slate-500"
        data-testid="expanded-source-confidence"
      >
        {formatConfidence(source.confidence)}
      </span>
      {source.joinAnnotation ? (
        <span
          className="flex-shrink-0 text-xs italic text-slate-500"
          data-testid="expanded-source-join"
        >
          {/* Server-formatted by `deriveJoinAnnotation`; already
              wrapped in `(join: …)`. Render as-is. */}
          {source.joinAnnotation}
        </span>
      ) : null}
    </li>
  )
}

/**
 * 2-decimal confidence formatting mirroring FieldMappingRow's rule so the
 * collapsed and expanded views never disagree on a fraction. Accepts either
 * 0-100 integers (legacy storage) or 0-1 fractions (defensive drift guard).
 *
 * Null handled by rendering an em-dash — a mapped source with null confidence
 * is unusual but allowed by the contract.
 */
function formatConfidence(confidence: number | null): string {
  if (confidence === null) return '—'
  const normalized = confidence > 1 ? confidence : confidence * 100
  return `${normalized.toFixed(2)}%`
}
