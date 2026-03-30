interface PageHeaderProps {
  projectName: string
  title: string
  subtitle?: string
  children?: React.ReactNode
}

export function PageHeader({ projectName, title, subtitle, children }: PageHeaderProps) {
  return (
    <div className="bg-white border-b border-gray-200 px-6 py-4 flex-shrink-0">
      <p className="text-[11px] font-medium uppercase tracking-widest text-gray-400 truncate max-w-md mb-1">
        {projectName}
      </p>
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <h1 className="text-xl font-semibold text-gray-900">{title}</h1>
          {subtitle && <p className="text-sm text-gray-500 mt-0.5">{subtitle}</p>}
        </div>
        {children}
      </div>
    </div>
  )
}
