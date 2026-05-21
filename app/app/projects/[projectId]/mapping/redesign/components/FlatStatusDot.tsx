import { cn } from '@/components/ui/utils'
import type { FlatRowStatus } from '@/lib/utils/flatten-rows-for-list-view'

// FlatStatusDot — Mapping list view status indicator.
//
// Deliberately distinct from the target-led view's `StatusDot`
// (FieldMappingRow.tsx). The target-led variant uses 4 statuses
// (including a slate-300 'unmapped' bucket and a hollow red 'rejected'
// dot). The flat view collapses to 3 buckets per the founder review:
//
//   approved     → green filled (acknowledgments included)
//   needs_review → gray filled
//   rejected     → gray filled (collapsed onto needs_review)
//
// Post-#157/#158/A2 the flat view's 'rejected' status no longer carries
// a semantic distinct from 'needs_review' (Reject = reset). Legacy
// SimpleLegal mapped+rejected rows therefore render the SAME slate-400
// dot as needs_review — they visually collapse into the unified
// needs-review state. The `FlatRowStatus` type keeps its 'rejected'
// member; only this visual mapping changed.
//
// Shipping a sibling component keeps the target-led visual stable while
// the flat view adopts the simpler 3-bucket scheme. Co-evolution risk
// is acceptable: there are only two callsites total (FieldMappingRow
// for target-led, this file for flat) and the rules differ
// intentionally.

const FLAT_STATUS_CONFIG: Record<
  FlatRowStatus,
  { label: string; dotClassName: string }
> = {
  approved: { label: 'Approved', dotClassName: 'bg-green-500' },
  needs_review: { label: 'Needs Review', dotClassName: 'bg-slate-400' },
  rejected: { label: 'Rejected', dotClassName: 'bg-slate-400' },
}

export function FlatStatusDot({
  status,
  className,
}: {
  status: FlatRowStatus
  className?: string
}) {
  const config = FLAT_STATUS_CONFIG[status]
  return (
    <span
      aria-label={`status: ${config.label}`}
      title={config.label}
      data-testid="flat-status-dot"
      data-status={status}
      className={cn(
        'inline-block h-1.5 w-1.5 flex-shrink-0 rounded-full',
        config.dotClassName,
        className,
      )}
    />
  )
}

export function flatStatusLabel(status: FlatRowStatus): string {
  return FLAT_STATUS_CONFIG[status].label
}
