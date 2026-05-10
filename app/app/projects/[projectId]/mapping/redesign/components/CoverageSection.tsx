import { cn } from '@/components/ui/utils'
import { getCoverageRationale } from '@/lib/utils/coverage-rationale'
import type { TargetFieldCoverageRow } from '@/lib/types/path-d'

// ─────────────────────────────────────────────────────────────────────────────
// Phase E PR α — drawer COVERAGE section.
// ─────────────────────────────────────────────────────────────────────────────
//
// Renders the categorical coverage rationale on no-source / acknowledged
// rows. Three lines stacked under a small-caps "COVERAGE" section header:
//
//   1. Short label  (e.g. "Out of scope" / "Manual entry required")
//   2. AI reasoning (italic muted prose; omitted when null)
//   3. Suggested action (small muted text; omitted when null)
//
// Render-or-collapse contract:
//   • UnmappedBody passes `coverage = coverageByTargetFieldId.get(...)` (may
//     be undefined → null). Section ALWAYS renders — null produces the
//     synthesized "Manual entry required" orphan line.
//   • AcknowledgedBody passes the lookup but COLLAPSES the section when
//     coverage is missing — the orphan label reads oddly on an explicitly
//     closed acknowledged row. The collapse decision is enforced at the
//     call site via the `coverage === undefined` early return below;
//     callers that always want to render pass `null` explicitly.
//
// Pure presentational. No hooks, no data fetching. The drawer's
// `DrawerSection` wrapper surrounds this component.

interface CoverageSectionProps {
  /**
   * Coverage row for the target field. Pass `null` to render the
   * synthesized "Manual entry required" orphan label (no-source rows).
   * Pass `undefined` to indicate "no coverage data available — caller
   * should collapse the section entirely"; the component returns
   * `null` in that case so a callsite can blanket-render and let the
   * primitive handle the collapse.
   */
  coverage: TargetFieldCoverageRow | null | undefined
  /** Optional className override for the outer wrapper. */
  className?: string
}

export function CoverageSection({ coverage, className }: CoverageSectionProps) {
  if (coverage === undefined) return null

  const rationale = getCoverageRationale(coverage)

  return (
    <div
      className={cn('flex flex-col gap-2', className)}
      data-testid="drawer-coverage-section"
      data-coverage-status={coverage?.coverage_status ?? 'orphan'}
    >
      <div
        className="text-sm font-medium text-slate-900"
        data-testid="drawer-coverage-label"
      >
        {rationale.label}
      </div>
      {rationale.reasoning ? (
        <p
          className="text-sm italic leading-relaxed text-slate-600"
          data-testid="drawer-coverage-reasoning"
        >
          {rationale.reasoning}
        </p>
      ) : null}
      {rationale.suggestedAction ? (
        <p
          className="mt-1 text-xs text-slate-500"
          data-testid="drawer-coverage-action"
        >
          {rationale.suggestedAction}
        </p>
      ) : null}
    </div>
  )
}
