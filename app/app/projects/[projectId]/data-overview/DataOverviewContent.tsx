'use client'

import { useState, useCallback } from 'react'
import { useSearchParams, useRouter, usePathname } from 'next/navigation'
import SchemaOverview from './SchemaOverview'
import DataPreview from './DataPreview'
import DataProfiling from './DataProfiling'
import QueryData from './QueryData'
import type { ProjectSchema, TableOption } from '@/lib/actions/data-overview'

type TabId = 'schema' | 'preview' | 'query' | 'profiling'

const TABS: { id: TabId; label: string }[] = [
  { id: 'schema', label: 'Schema Overview' },
  { id: 'preview', label: 'Data Preview' },
  { id: 'query', label: 'Query Data' },
  { id: 'profiling', label: 'Data Profiling' },
]

interface DataOverviewContentProps {
  projectId: string
  schema: ProjectSchema
  tables: TableOption[]
  isArchived?: boolean
  archivedAt?: string | null
  initialTab?: TabId
  initialQuery?: string
  initialQueryMode?: 'nl' | 'sql'
  initialTableId?: string
  sourceTableCount: number
  sourceFieldCount: number
  targetTableCount: number
  targetFieldCount: number
}

export default function DataOverviewContent({
  projectId,
  schema,
  tables,
  isArchived = false,
  archivedAt,
  initialTab,
  initialQuery,
  initialQueryMode,
  initialTableId,
  sourceTableCount,
  sourceFieldCount,
  targetTableCount,
  targetFieldCount,
}: DataOverviewContentProps) {
  const searchParams = useSearchParams()
  const router = useRouter()
  const pathname = usePathname()

  const validTabs: TabId[] = ['schema', 'preview', 'query', 'profiling']
  const validatedInitialTab = initialTab && validTabs.includes(initialTab) ? initialTab : 'schema'
  const [activeTab, setActiveTab] = useState<TabId>(validatedInitialTab)
  const [mountedTabs, setMountedTabs] = useState<Set<TabId>>(
    new Set(['schema', validatedInitialTab])
  )

  // Shared selected table ID for Data Preview — lifted so profiling can drive it
  const [selectedPreviewTableId, setSelectedPreviewTableId] = useState<string | undefined>(
    initialTableId
  )

  const handleTabChange = useCallback((tab: TabId) => {
    setMountedTabs((prev) => {
      if (prev.has(tab)) return prev
      return new Set([...prev, tab])
    })
    setActiveTab(tab)
    const params = new URLSearchParams(searchParams.toString())
    params.set('tab', tab)
    router.replace(`${pathname}?${params.toString()}`, { scroll: false })
  }, [searchParams, router, pathname])

  function handleNavigateToPreview(tableId: string) {
    setSelectedPreviewTableId(tableId)
    handleTabChange('preview')
  }

  return (
    <div className="flex flex-col flex-1 min-h-0">
      {/* Stat pills */}
      <div className="flex items-center gap-2 px-5 py-2.5 bg-white border-b border-settle-slate-200 flex-shrink-0">
        <div className="flex items-center gap-2 px-3 py-1.5 rounded-lg border border-settle-slate-200 bg-white">
          <span className="text-[10px] font-medium text-settle-slate-400 uppercase tracking-wide">Source</span>
          <span className="text-sm font-medium text-settle-slate-900">
            {sourceTableCount} tables · {sourceFieldCount} fields
          </span>
        </div>
        <div className="flex items-center gap-2 px-3 py-1.5 rounded-lg border border-settle-slate-200 bg-white">
          <span className="text-[10px] font-medium text-settle-slate-400 uppercase tracking-wide">Target</span>
          <span className="text-sm font-medium text-settle-slate-900">
            {targetTableCount} tables · {targetFieldCount} fields
          </span>
        </div>
      </div>

      {/* Tab bar */}
      <div className="border-b border-settle-slate-200 bg-white px-5">
        <nav className="flex gap-0" aria-label="Data overview tabs">
          {TABS.map(({ id, label }) => {
            const active = activeTab === id
            return (
              <button
                key={id}
                onClick={() => handleTabChange(id)}
                className={`px-4 py-3 text-sm font-medium border-b-2 transition-colors -mb-px ${
                  active
                    ? 'border-primary text-primary'
                    : 'border-transparent text-gray-500 hover:text-gray-700 hover:border-gray-300'
                }`}
              >
                {label}
              </button>
            )
          })}
        </nav>
      </div>

      {/* Tab content — tabs mount on first visit then stay mounted; inactive ones are hidden via CSS */}
      <div className="flex-1 overflow-y-auto">
        <div className={activeTab !== 'schema' ? 'hidden' : 'p-6 flex flex-col flex-1 min-h-0'}>
          <SchemaOverview
            projectId={projectId}
            source={schema.source}
            target={schema.target}
          />
        </div>
        <div className={activeTab !== 'preview' ? 'hidden' : 'p-6 flex flex-col flex-1 min-h-0'}>
          {mountedTabs.has('preview') && (
            <DataPreview
              projectId={projectId}
              tables={tables}
              isArchived={isArchived}
              archivedAt={archivedAt}
              initialSelectedTableId={selectedPreviewTableId}
            />
          )}
        </div>
        <div className={activeTab !== 'query' ? 'hidden' : 'p-6 flex flex-col flex-1 min-h-0'}>
          {mountedTabs.has('query') && (
            <QueryData
              projectId={projectId}
              tables={tables}
              isArchived={isArchived}
              initialQuery={initialQuery}
              initialMode={initialQueryMode}
            />
          )}
        </div>
        <div className={activeTab !== 'profiling' ? 'hidden' : 'p-6 flex flex-col flex-1 min-h-0'}>
          {mountedTabs.has('profiling') && (
            <DataProfiling
              projectId={projectId}
              tables={tables}
              isArchived={isArchived}
              onNavigateToPreview={handleNavigateToPreview}
            />
          )}
        </div>
      </div>
    </div>
  )
}
