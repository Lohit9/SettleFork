'use client'

import { useState } from 'react'
import { Database, Eye, Search, BarChart } from '@/components/icons'
import SchemaOverview from './SchemaOverview'
import DataPreview from './DataPreview'
import DataProfiling from './DataProfiling'
import QueryData from './QueryData'
import type { ProjectSchema, TableOption } from '@/lib/actions/data-overview'

type TabId = 'schema' | 'preview' | 'query' | 'profiling'

const TABS: { id: TabId; label: string; Icon: React.ComponentType<{ className?: string }> }[] = [
  { id: 'schema', label: 'Schema Overview', Icon: Database },
  { id: 'preview', label: 'Data Preview', Icon: Eye },
  { id: 'query', label: 'Query Data', Icon: Search },
  { id: 'profiling', label: 'Data Profiling', Icon: BarChart },
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
}: DataOverviewContentProps) {
  const [activeTab, setActiveTab] = useState<TabId>(initialTab ?? 'schema')
  // Shared selected table ID for Data Preview — lifted so profiling can drive it
  const [selectedPreviewTableId, setSelectedPreviewTableId] = useState<string | undefined>(
    initialTableId
  )

  function handleNavigateToPreview(tableId: string) {
    setSelectedPreviewTableId(tableId)
    setActiveTab('preview')
  }

  return (
    <div className="flex flex-col flex-1 min-h-0">
      {/* Tab bar */}
      <div className="border-b border-gray-200 bg-white pl-2 pr-6">
        <nav className="flex gap-0" aria-label="Data overview tabs">
          {TABS.map(({ id, label, Icon }) => {
            const active = activeTab === id
            return (
              <button
                key={id}
                onClick={() => setActiveTab(id)}
                className={`flex items-center gap-2 px-4 py-3.5 text-sm font-medium border-b-2 transition-colors -mb-px ${
                  active
                    ? 'border-primary text-primary'
                    : 'border-transparent text-gray-500 hover:text-gray-700 hover:border-gray-300'
                }`}
              >
                <Icon className="w-4 h-4" />
                {label}
              </button>
            )
          })}
        </nav>
      </div>

      {/* Tab content */}
      <div className="flex-1 overflow-y-auto p-6">
        {activeTab === 'schema' && (
          <SchemaOverview
            projectId={projectId}
            source={schema.source}
            target={schema.target}
          />
        )}
        {activeTab === 'preview' && (
          <DataPreview
            projectId={projectId}
            tables={tables}
            isArchived={isArchived}
            archivedAt={archivedAt}
            initialSelectedTableId={selectedPreviewTableId}
          />
        )}
        {activeTab === 'query' && (
          <QueryData
            projectId={projectId}
            tables={tables}
            isArchived={isArchived}
            initialQuery={initialQuery}
            initialMode={initialQueryMode}
          />
        )}
        {activeTab === 'profiling' && (
          <DataProfiling
            projectId={projectId}
            tables={tables}
            isArchived={isArchived}
            onNavigateToPreview={handleNavigateToPreview}
          />
        )}
      </div>
    </div>
  )
}
