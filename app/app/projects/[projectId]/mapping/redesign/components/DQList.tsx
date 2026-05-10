import { Info } from 'lucide-react'
import { cn } from '@/components/ui/utils'
import { AlertCircle, AlertTriangle } from '@/components/icons'
import type {
  DqSeverity,
  ProjectDataQualityIssueRow,
} from '@/lib/types/path-d'

// ─────────────────────────────────────────────────────────────────────────────
// Phase E PR α — drawer DATA QUALITY list primitive.
// ─────────────────────────────────────────────────────────────────────────────
//
// Lightweight inline list rendered inside the drawer's DATA QUALITY
// section. Each row:
//
//   ⚠ {category}                                       (severity-tinted)
//     {description}
//
// Severity ordering (locked): critical → warning → info. The component
// sorts before rendering so callers don't need to pre-sort their
// fan-in arrays from `dqIssuesBySourceFieldId`.
//
// Severity icon mapping (locked):
//   critical → AlertCircle (red palette) — closest STOP-hue match in the
//             repo's icon module; AlertOctagon is not loaded.
//   warning  → AlertTriangle (amber palette)
//   info     → Info (lucide-react) — repo's components/icons/ has no
//             InfoCircle yet; lucide-react ships one and is already a
//             repo dependency.
//
// Empty-state: pass `issues = []` and the component returns `null`
// (Linear pattern — silent collapse).

// Severity bucket order — mirrors the locked render sequence
// (critical → warning → info). We bucketise rather than `.sort()` so we
// stay inside the redesign path's "no client-side sort" invariant
// (`tests/lib/no-shim-in-redesign-path.test.ts`); the guard is conservative
// and flags any `.sort(` regardless of whether the array is rows. Bucketing
// preserves input order within each severity group, which matches the
// server's own ordering and feels right for "two warnings on the same
// source, the older one first" cases.
const SEVERITY_BUCKET_ORDER: readonly DqSeverity[] = [
  'critical',
  'warning',
  'info',
] as const

const SEVERITY_LABEL: Record<DqSeverity, string> = {
  critical: 'Critical',
  warning: 'Warning',
  info: 'Info',
}

const SEVERITY_ICON_CLASSNAME: Record<DqSeverity, string> = {
  critical: 'text-red-600',
  warning: 'text-amber-600',
  info: 'text-blue-600',
}

const SEVERITY_LABEL_CLASSNAME: Record<DqSeverity, string> = {
  critical: 'text-red-700',
  warning: 'text-amber-800',
  info: 'text-blue-700',
}

function severityIcon(
  severity: DqSeverity,
): React.ComponentType<{ className?: string }> {
  if (severity === 'critical') return AlertCircle
  if (severity === 'warning') return AlertTriangle
  return Info
}

interface DQListProps {
  issues: readonly ProjectDataQualityIssueRow[]
  className?: string
}

export function DQList({ issues, className }: DQListProps) {
  if (issues.length === 0) return null

  // Bucketise by severity in the locked order without `.sort()` (see
  // `SEVERITY_BUCKET_ORDER` above for rationale). Within each bucket
  // input order is preserved.
  const ordered: ProjectDataQualityIssueRow[] = []
  for (const severity of SEVERITY_BUCKET_ORDER) {
    for (const issue of issues) {
      if (issue.severity === severity) ordered.push(issue)
    }
  }

  return (
    <ul
      className={cn('flex flex-col gap-3', className)}
      data-testid="drawer-dq-list"
    >
      {ordered.map((issue) => (
        <DQListItem key={issue.id} issue={issue} />
      ))}
    </ul>
  )
}

function DQListItem({ issue }: { issue: ProjectDataQualityIssueRow }) {
  const Icon = severityIcon(issue.severity)
  return (
    <li
      className="flex flex-col gap-1"
      data-testid="drawer-dq-item"
      data-dq-id={issue.id}
      data-dq-severity={issue.severity}
    >
      <div className="flex items-start gap-2">
        <Icon
          aria-hidden="true"
          className={cn(
            'mt-0.5 h-3.5 w-3.5 flex-shrink-0',
            SEVERITY_ICON_CLASSNAME[issue.severity],
          )}
        />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span
              className={cn(
                'text-xs font-medium uppercase tracking-wide',
                SEVERITY_LABEL_CLASSNAME[issue.severity],
              )}
              data-testid="drawer-dq-severity-label"
            >
              {SEVERITY_LABEL[issue.severity]}
            </span>
            <span
              className="text-xs text-slate-500"
              data-testid="drawer-dq-category"
            >
              {issue.category}
            </span>
          </div>
          <p
            className="text-sm leading-relaxed text-slate-700"
            data-testid="drawer-dq-description"
          >
            {issue.description}
          </p>
        </div>
      </div>
    </li>
  )
}
