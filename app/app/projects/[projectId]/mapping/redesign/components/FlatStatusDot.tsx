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
//   needs_review → amber filled
//   rejected     → gray filled (NOT red, NOT hollow)
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
  needs_review: { label: 'Needs Review', dotClassName: 'bg-amber-400' },
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
