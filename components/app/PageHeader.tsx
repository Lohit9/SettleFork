import Link from 'next/link'
import { Settings } from '@/components/icons'

interface PageHeaderProps {
  projectName: string
  title: string
  subtitle?: string
  /**
   * When set, renders a settings gear (right side of the header) linking
   * to `/app/projects/<projectId>/settings`. PR 2a replaced the (i) info
   * popover with this gear so the project-settings flow (Members + Info
   * tabs) gets a stable entry point. Non-project consumers omit this prop;
   * the gear simply doesn't render.
   */
  projectId?: string
  children?: React.ReactNode
}

// Note on `subtitle`: declared in the prop interface for clarity at
// call-sites and to keep the public API stable, but the design intentionally
// surfaces only `projectName` in the chrome (per the Phase 4-polish-1
// hierarchy refinement). The prop is destructured but not rendered; this
// matches the pre-PR 2a behavior byte-for-byte.
export function PageHeader({ projectName, title, projectId, children }: PageHeaderProps) {
  // Refinement 2 (Phase 4-polish-1 final-final, 2026-04-26): the page
  // header's title-vs-subtitle hierarchy was sharpened. The title
  // ("Mapping" / "Schemas" / etc.) bumps to `font-bold` so it reads
  // as the dominant element on first scan. The subtitle (the project
  // name slot, e.g. "Heritage Core to Nymbus Core Migration") grows
  // from text-xs to text-sm and slides from gray-400 to slate-500 —
  // larger and slightly more contrasted, but still clearly secondary
  // to the title via the weight + size delta. The slate-N palette
  // also matches the redesign-path body (FieldMappingRow, etc.) for
  // consistency across the page.
  return (
    <div className="bg-white border-b border-gray-100 pl-2 pr-6 min-h-[60px] flex items-center justify-between gap-4 flex-shrink-0">
      <div className="flex items-center gap-0 min-w-0">
        <h1
          data-testid="page-header-title"
          className="text-base font-bold text-slate-900 whitespace-nowrap"
        >
          {title}
        </h1>
        {projectName && (
          <>
            <div className="w-px h-4 bg-gray-200 mx-3 flex-shrink-0" />
            <span
              data-testid="page-header-subtitle"
              className="text-sm font-normal text-slate-500 truncate"
            >
              {projectName}
            </span>
          </>
        )}
      </div>
      {(children || projectId) && (
        <div className="flex items-center gap-2 flex-shrink-0">
          {children}
          {projectId && (
            <Link
              href={`/app/projects/${projectId}/settings`}
              aria-label="Project settings"
              title="Project settings"
              data-testid="page-header-settings"
              className="w-7 h-7 rounded-md text-settle-slate-400 hover:text-settle-slate-600 hover:bg-settle-slate-50 flex items-center justify-center transition-colors"
            >
              <Settings width={15} height={15} />
            </Link>
          )}
        </div>
      )}
    </div>
  )
}
