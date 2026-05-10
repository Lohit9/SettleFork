import { cva, type VariantProps } from 'class-variance-authority'
import { cn } from '@/components/ui/utils'
import {
  Check,
  AlertTriangle,
  AlertCircle,
  X,
} from '@/components/icons'
import type { CoverageStatus } from '@/lib/types/path-d'

// ─────────────────────────────────────────────────────────────────────────────
// CoverageStatusBadge — Path D primitive.
// ─────────────────────────────────────────────────────────────────────────────
//
// Renders the coverage_status of a target_field_coverage row. The 5 variants
// are byte-identical to the CHECK constraint in
// `supabase/migrations/093_path_d_foundation.sql:58` —
// ('covered', 'partial', 'gap', 'optional', 'out_of_scope').
//
// Visual grammar mirrors the rest of the app: color-coded soft background,
// matching foreground text, leading icon. Uses CVA per shadcn convention
// (see `components/ui/badge.tsx`); icons come from the inline-SVG module
// (`components/icons/index.tsx`). At scaffolding stage `X` doubles for both
// `optional` and `out_of_scope` slots — the variants are visually distinct
// via slate-100 background + slate-700 vs slate-500 text. A follow-up PR
// can introduce dedicated icons (e.g. `Minus` / `EyeOff`) once the icons
// module is touched cleanly.

const coverageBadgeVariants = cva(
  'inline-flex items-center gap-1 rounded-md px-2 py-0.5 text-xs font-medium border',
  {
    variants: {
      status: {
        covered: 'bg-emerald-50 text-emerald-700 border-emerald-200',
        partial: 'bg-amber-50 text-amber-800 border-amber-200',
        gap: 'bg-red-50 text-red-700 border-red-200',
        optional: 'bg-slate-100 text-slate-700 border-slate-200',
        out_of_scope: 'bg-slate-100 text-slate-500 border-slate-200',
      },
    },
  },
)

const STATUS_LABEL: Record<CoverageStatus, string> = {
  covered: 'Covered',
  partial: 'Partial',
  gap: 'Gap',
  optional: 'Optional',
  out_of_scope: 'Out of scope',
}

const STATUS_ICON: Record<
  CoverageStatus,
  React.ComponentType<{ className?: string }>
> = {
  covered: Check,
  partial: AlertTriangle,
  gap: AlertCircle,
  optional: X,
  out_of_scope: X,
}

interface CoverageStatusBadgeProps
  extends Omit<VariantProps<typeof coverageBadgeVariants>, 'status'> {
  /** The target_field_coverage.coverage_status value from migration 093. */
  status: CoverageStatus
  /** Optional className override (e.g. inside tight cells). */
  className?: string
}

export function CoverageStatusBadge({
  status,
  className,
}: CoverageStatusBadgeProps) {
  const Icon = STATUS_ICON[status]
  const label = STATUS_LABEL[status]
  return (
    <span
      data-status={status}
      aria-label={`Coverage status: ${label}`}
      className={cn(coverageBadgeVariants({ status }), className)}
    >
      <Icon className='size-3' />
      {label}
    </span>
  )
}
