import { cn } from '@/components/ui/utils'
import type {
  DecisionStatus,
  ProjectDecisionRow,
} from '@/lib/types/path-d'

// ─────────────────────────────────────────────────────────────────────────────
// Phase E PR α — drawer DECISIONS list primitive.
// ─────────────────────────────────────────────────────────────────────────────
//
// Lightweight inline list rendered inside the drawer's DECISIONS section.
// Per align-on-approach: deliberately NOT the full `DecisionCard`
// (components/path-d/DecisionCard.tsx) — that primitive is too visually
// heavy for the drawer's 480px width and is kept for a future dedicated
// decisions page.
//
// Each row:
//   ● {title}                              [pending|decided|auto_applied]
//     {description}
//
// Title: `decision.title` (always present per migration 093:121).
// Description: `decision.description` (nullable; row collapses to a
//   single-line render when null).
// Status pill: amber/emerald/slate per the existing `DecisionCard` palette
//   (kept consistent so a future merge with the standalone page reads as
//   one design language).
//
// `ai_recommendation` JSONB rendering: the prompt notes a "summary" string
// field if Phase B's agent emits one. Absent that, the drawer omits the
// recommendation prose entirely — the dedicated decisions page is the
// canonical surface for full JSON inspection.
//
// Empty-state: pass `decisions = []` and the component returns `null`
// (Linear pattern — silent collapse).

const STATUS_PILL_STYLES: Record<DecisionStatus, string> = {
  pending: 'bg-amber-50 text-amber-800 border-amber-200',
  decided: 'bg-emerald-50 text-emerald-700 border-emerald-200',
  auto_applied: 'bg-slate-100 text-slate-700 border-slate-200',
}

const STATUS_PILL_LABEL: Record<DecisionStatus, string> = {
  pending: 'Pending',
  decided: 'Decided',
  auto_applied: 'Auto-applied',
}

const STATUS_DOT_CLASSNAME: Record<DecisionStatus, string> = {
  pending: 'bg-amber-400',
  decided: 'bg-emerald-500',
  auto_applied: 'bg-slate-400',
}

/**
 * Extract a one-line summary from `ai_recommendation` JSONB when the
 * agent emitted a `summary` string field. Returns null otherwise so the
 * caller can omit the recommendation block entirely (no raw JSON in
 * drawer).
 */
function extractRecommendationSummary(
  recommendation: unknown,
): string | null {
  if (
    recommendation === null ||
    typeof recommendation !== 'object' ||
    Array.isArray(recommendation)
  ) {
    return null
  }
  const summary = (recommendation as Record<string, unknown>).summary
  if (typeof summary === 'string' && summary.trim().length > 0) {
    return summary.trim()
  }
  return null
}

interface DecisionListProps {
  decisions: readonly ProjectDecisionRow[]
  className?: string
}

export function DecisionList({ decisions, className }: DecisionListProps) {
  if (decisions.length === 0) return null

  return (
    <ul
      className={cn('flex flex-col gap-3', className)}
      data-testid="drawer-decision-list"
    >
      {decisions.map((decision) => (
        <DecisionListItem key={decision.id} decision={decision} />
      ))}
    </ul>
  )
}

function DecisionListItem({ decision }: { decision: ProjectDecisionRow }) {
  const recommendationSummary = extractRecommendationSummary(
    decision.ai_recommendation,
  )
  return (
    <li
      className="flex flex-col gap-1.5"
      data-testid="drawer-decision-item"
      data-decision-id={decision.id}
      data-decision-status={decision.status}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="flex min-w-0 items-center gap-2">
          <span
            aria-hidden="true"
            className={cn(
              'h-2 w-2 flex-shrink-0 rounded-full',
              STATUS_DOT_CLASSNAME[decision.status],
            )}
          />
          <span
            className="min-w-0 truncate text-sm font-medium text-slate-900"
            data-testid="drawer-decision-title"
            title={decision.title}
          >
            {decision.title}
          </span>
        </div>
        <span
          className={cn(
            'inline-flex flex-shrink-0 items-center rounded-md border px-2 py-0.5 text-[11px] font-medium',
            STATUS_PILL_STYLES[decision.status],
          )}
          data-testid="drawer-decision-status-pill"
        >
          {STATUS_PILL_LABEL[decision.status]}
        </span>
      </div>
      {decision.description ? (
        <p
          className="pl-4 text-xs leading-relaxed text-slate-600"
          data-testid="drawer-decision-description"
        >
          {decision.description}
        </p>
      ) : null}
      {recommendationSummary ? (
        <p
          className="pl-4 text-xs italic leading-relaxed text-slate-500"
          data-testid="drawer-decision-recommendation"
        >
          {recommendationSummary}
        </p>
      ) : null}
    </li>
  )
}
