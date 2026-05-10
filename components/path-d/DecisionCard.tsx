import { cn } from '@/components/ui/utils'
import type { DecisionStatus, ProjectDecisionRow } from '@/lib/types/path-d'

// ─────────────────────────────────────────────────────────────────────────────
// DecisionCard — Path D primitive.
// ─────────────────────────────────────────────────────────────────────────────
//
// Displays one project_decisions row (migration 093:117-134):
//
//   • title + decision_type pill + status pill
//   • description (optional)
//   • AI recommendation (JSONB, rendered as a pretty-printed stub)
//   • Alternatives (JSONB array, rendered as a pretty-printed stub)
//   • Accept / Decline action buttons
//
// onAccept/onDecline are optional during scaffolding. Phase B integration
// will provide handlers; until then, click is no-op.
//
// ai_recommendation / alternatives JSONB shapes are owned by Phase B's agent
// prompt. We render JSON.stringify(value, null, 2) inside <pre> as a
// scaffolding stub — refine to structured rendering in a follow-up PR once
// Phase B produces canonical shapes.

const STATUS_STYLES: Record<DecisionStatus, string> = {
  pending: 'bg-amber-50 text-amber-800 border-amber-200',
  decided: 'bg-emerald-50 text-emerald-700 border-emerald-200',
  auto_applied: 'bg-slate-100 text-slate-700 border-slate-200',
}

const STATUS_LABEL: Record<DecisionStatus, string> = {
  pending: 'Pending',
  decided: 'Decided',
  auto_applied: 'Auto-applied',
}

interface DecisionCardProps {
  decision: ProjectDecisionRow
  /** Optional accept handler. No-op when undefined. */
  onAccept?: () => void
  /** Optional decline handler. No-op when undefined. */
  onDecline?: () => void
  className?: string
}

export function DecisionCard({
  decision,
  onAccept,
  onDecline,
  className,
}: DecisionCardProps) {
  return (
    <article
      data-status={decision.status}
      className={cn(
        'flex flex-col gap-4 rounded-xl border border-slate-200 bg-white p-5 shadow-sm',
        className,
      )}
    >
      {/* Header: title + decision_type pill + status pill */}
      <header className='flex items-start justify-between gap-3'>
        <div className='flex flex-col gap-1.5 min-w-0'>
          <h3 className='text-base font-semibold text-slate-900 leading-tight'>
            {decision.title}
          </h3>
          <div className='flex items-center gap-2 flex-wrap'>
            <span className='inline-flex items-center rounded-md border border-slate-200 bg-slate-50 px-2 py-0.5 text-xs font-medium text-slate-700'>
              {decision.decision_type}
            </span>
            <span
              className={cn(
                'inline-flex items-center rounded-md border px-2 py-0.5 text-xs font-medium',
                STATUS_STYLES[decision.status],
              )}
            >
              {STATUS_LABEL[decision.status]}
            </span>
          </div>
        </div>
      </header>

      {/* Description */}
      {decision.description ? (
        <p className='text-sm text-slate-600 leading-relaxed'>
          {decision.description}
        </p>
      ) : null}

      {/* AI recommendation — JSON stub */}
      <section className='flex flex-col gap-2'>
        <h4 className='text-xs font-semibold uppercase tracking-wide text-slate-500'>
          AI recommendation
        </h4>
        <pre
          data-testid='ai-recommendation'
          className='text-xs leading-relaxed bg-slate-50 border border-slate-200 rounded-md p-3 overflow-x-auto text-slate-800'
        >
          {JSON.stringify(decision.ai_recommendation, null, 2)}
        </pre>
      </section>

      {/* Alternatives — JSON stub */}
      <section className='flex flex-col gap-2'>
        <h4 className='text-xs font-semibold uppercase tracking-wide text-slate-500'>
          Alternatives
        </h4>
        <pre
          data-testid='alternatives'
          className='text-xs leading-relaxed bg-slate-50 border border-slate-200 rounded-md p-3 overflow-x-auto text-slate-800'
        >
          {JSON.stringify(decision.alternatives, null, 2)}
        </pre>
      </section>

      {/* Action buttons */}
      <footer className='flex items-center justify-end gap-2 pt-2 border-t border-slate-100'>
        <button
          type='button'
          onClick={onDecline}
          className='inline-flex items-center justify-center rounded-md border border-slate-200 bg-white px-4 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50 transition-colors'
        >
          Decline
        </button>
        <button
          type='button'
          onClick={onAccept}
          className='inline-flex items-center justify-center rounded-md bg-settle-blue-500 hover:bg-settle-blue-600 px-4 py-2 text-sm font-medium text-white transition-colors'
        >
          Accept
        </button>
      </footer>
    </article>
  )
}
