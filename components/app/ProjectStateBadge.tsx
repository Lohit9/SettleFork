import { cva } from 'class-variance-authority'
import { cn } from '@/components/ui/utils'
import type { ProjectStats } from '@/lib/quality/project-stats'

// ─────────────────────────────────────────────────────────────────────────────
// ProjectStateBadge — PR-2 of the stats redesign.
// ─────────────────────────────────────────────────────────────────────────────
//
// State-aware pill rendered next to the project name on the Projects
// Dashboard tile. Drives off `ProjectStats.state` (PR-1's 3-state machine)
// with a `completed` overlay when `projects.completed_at IS NOT NULL`.
//
// Variants and labels are spec'd in the PR-2 brief — colors mirror the rest
// of the app (slate / blue / amber / emerald) so the badge reads as a status
// pill rather than a generic shadcn variant. Replaces the previous inline
// Completed `<span>` in `ProjectsList.tsx` (single component, single source
// of truth for project-state visual semantics).

type ProjectStateBadgeVariant = ProjectStats['state'] | 'completed'

const projectStateBadgeVariants = cva(
  'inline-flex items-center text-[10px] font-medium px-1.5 py-0.5 rounded flex-shrink-0',
  {
    variants: {
      variant: {
        awaiting_data: 'bg-slate-100 text-slate-700',
        data_ingested: 'bg-blue-50 text-blue-700',
        mappings_generated: 'bg-amber-50 text-amber-800',
        completed: 'bg-green-50 text-green-700',
      },
    },
  },
)

const VARIANT_LABEL: Record<ProjectStateBadgeVariant, string> = {
  awaiting_data: 'Awaiting data ingestion',
  data_ingested: 'Data ingested',
  mappings_generated: 'Ready for review',
  completed: 'Completed',
}

interface ProjectStateBadgeProps {
  /** Underlying state from `projectStats.state`. Pass `null` to render the
   *  defensive `awaiting_data` fallback (used when the helper produced
   *  null — shouldn't happen post-PR-1 but covers data-layer failures). */
  state: ProjectStats['state'] | null
  /** Project's `completed_at` timestamp. When non-null, overrides the
   *  state-driven variant and renders the green "Completed" pill. */
  completedAt: string | null
  className?: string
}

export function ProjectStateBadge({
  state,
  completedAt,
  className,
}: ProjectStateBadgeProps) {
  const effectiveState = state ?? 'awaiting_data'
  const variant: ProjectStateBadgeVariant = completedAt ? 'completed' : effectiveState
  return (
    <span
      data-state-variant={variant}
      className={cn(projectStateBadgeVariants({ variant }), className)}
    >
      {VARIANT_LABEL[variant]}
    </span>
  )
}
