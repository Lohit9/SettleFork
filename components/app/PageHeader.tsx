interface PageHeaderProps {
  projectName: string
  title: string
  subtitle?: string
  children?: React.ReactNode
}

export function PageHeader({ projectName, title, subtitle, children }: PageHeaderProps) {
  return (
    <div className="bg-white border-b border-gray-200 pl-2 pr-6 min-h-[60px] flex items-center justify-between gap-4 flex-shrink-0">
      <div className="flex items-center gap-0 min-w-0">
        <h1 className="text-base font-semibold text-gray-900 whitespace-nowrap">{title}</h1>
        {projectName && (
          <>
            <div className="w-px h-4 bg-gray-200 mx-3 flex-shrink-0" />
            <span className="text-xs text-gray-400 truncate">{projectName}</span>
          </>
        )}
      </div>
      {children && (
        <div className="flex items-center gap-2 flex-shrink-0">
          {children}
        </div>
      )}
    </div>
  )
}
