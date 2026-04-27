import { ProjectInfoPopover, type ProjectInfo } from '@/components/app/ProjectInfoPopover'

interface PageHeaderProps {
  projectName: string
  title: string
  subtitle?: string
  projectInfo?: ProjectInfo
  children?: React.ReactNode
}

export function PageHeader({ projectName, title, subtitle, projectInfo, children }: PageHeaderProps) {
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
      {(children || projectInfo) && (
        <div className="flex items-center gap-2 flex-shrink-0">
          {children}
          {projectInfo && (
            <ProjectInfoPopover info={projectInfo} />
          )}
        </div>
      )}
    </div>
  )
}
