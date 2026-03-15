'use client'

import { FileText, Database, GitBranch, Code, CheckCircle, Download, ArrowLeft } from '@/components/icons'
import Link from 'next/link'
import { usePathname } from 'next/navigation'

interface NavItem {
  id: string
  label: string
  icon: React.ComponentType<{ className?: string }>
  href: string
  exact?: boolean
}

interface NavigationProps {
  projectName?: string
  projectId?: string
  sourceSystemName?: string
  targetSystemName?: string
}

export function Navigation({
  projectName,
  projectId,
  sourceSystemName,
  targetSystemName,
}: NavigationProps) {
  const pathname = usePathname()

  const navItems: NavItem[] = [
    {
      id: 'control-plane',
      label: 'Control Plane',
      icon: FileText,
      href: projectId ? `/app/projects/${projectId}` : '#',
      exact: true,
    },
    {
      id: 'data-overview',
      label: 'Data Overview',
      icon: Database,
      href: projectId ? `/app/projects/${projectId}/data-overview` : '#',
    },
    {
      id: 'data-quality',
      label: 'Data Quality',
      icon: CheckCircle,
      href: projectId ? `/app/projects/${projectId}/data-quality` : '#',
    },
    {
      id: 'mapping',
      label: 'Mapping',
      icon: GitBranch,
      href: projectId ? `/app/projects/${projectId}/mapping` : '#',
    },
    {
      id: 'transform',
      label: 'Transform',
      icon: Code,
      href: projectId ? `/app/projects/${projectId}/transform` : '#',
    },
    {
      id: 'outputs',
      label: 'Outputs',
      icon: Download,
      href: projectId ? `/app/projects/${projectId}/outputs` : '#',
    },
  ]

  return (
    <div className="w-64 bg-white border-r border-gray-200 flex flex-col h-screen flex-shrink-0">
      <div className="p-6 border-b border-gray-200">
        <div className="flex items-center gap-2 mb-4">
          <img
            src="/Mine Logo no background.png"
            alt="MINE"
            className="h-8 w-auto"
          />
          <span className="text-xl font-semibold text-gray-900">MINE</span>
        </div>
        <Link
          href="/app/projects"
          className="w-full flex items-center gap-2 text-sm text-gray-600 px-2 py-2 hover:bg-gray-100 rounded-md transition-colors"
        >
          <ArrowLeft className="w-4 h-4" />
          All Projects
        </Link>
        {projectName && (
          <div className="mt-3 pt-3 border-t border-gray-200">
            <div className="text-xs text-gray-500 mb-1">Current Project</div>
            <div className="text-sm font-medium text-gray-900 truncate">{projectName}</div>
            {(sourceSystemName || targetSystemName) && (
              <div className="mt-1.5 flex items-center gap-1 text-xs text-gray-500">
                <span className="truncate">{sourceSystemName}</span>
                <span>→</span>
                <span className="truncate">{targetSystemName}</span>
              </div>
            )}
          </div>
        )}
      </div>

      <nav className="flex-1 p-4 overflow-y-auto">
        <ul className="space-y-1">
          {navItems.map((item) => {
            const Icon = item.icon
            const isActive = item.exact
              ? pathname === item.href
              : pathname === item.href || pathname?.startsWith(item.href + '/')

            return (
              <li key={item.id}>
                <Link
                  href={item.href}
                  className={`
                    w-full flex items-center gap-3 px-4 py-2.5 rounded-lg text-sm transition-colors
                    ${
                      isActive
                        ? 'bg-[#4F46E5] text-white'
                        : 'text-gray-700 hover:bg-gray-100'
                    }
                  `}
                >
                  <Icon className="w-5 h-5 flex-shrink-0" />
                  <span>{item.label}</span>
                </Link>
              </li>
            )
          })}
        </ul>
      </nav>
    </div>
  )
}
