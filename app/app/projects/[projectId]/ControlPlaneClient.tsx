'use client'

import { useState } from 'react'
import { FileText, CheckCircle2 } from '@/components/icons'
import { IngestionCard, IngestionState } from './IngestionCard'
import { Dataset, DBTable } from '@/lib/types/database'

interface ControlPlaneClientProps {
  projectId: string
  sourceDataset: Dataset | null
  targetDataset: Dataset | null
  sourceTables: DBTable[]
  targetTables: DBTable[]
}

export function ControlPlaneClient({
  projectId,
  sourceDataset,
  targetDataset,
  sourceTables,
  targetTables,
}: ControlPlaneClientProps) {
  const makeInitialState = (
    dataset: Dataset | null,
    tables: DBTable[]
  ): IngestionState => ({
    method: null,
    db: { host: '', port: '', databaseName: '', username: '' },
    csv: {
      selectedDbId: dataset?.id ?? null,
      selectedTableId: null,
      databases: dataset
        ? [{ id: dataset.id, name: dataset.name, tables: tables.map((t) => ({ id: t.id, name: t.name })) }]
        : [],
      newDbName: '',
      newTableName: '',
      showNewDbInput: false,
      showNewTableInput: false,
      uploadStatus: 'idle',
      uploadError: null,
    },
  })

  const [sourceIngestion, setSourceIngestion] = useState<IngestionState>(() =>
    makeInitialState(sourceDataset, sourceTables)
  )
  const [targetIngestion, setTargetIngestion] = useState<IngestionState>(() =>
    makeInitialState(targetDataset, targetTables)
  )

  return (
    <div className="flex-1 bg-gray-50 overflow-auto">
      <div className="max-w-6xl mx-auto px-8 py-8 space-y-8">
        {/* Page Header */}
        <div>
          <h1 className="text-2xl font-semibold text-gray-900 mb-1">Control Plane</h1>
          <p className="text-sm text-gray-500">Configure source and target system connections</p>
        </div>

        {/* Data Ingestion */}
        <div className="space-y-3">
          <h2 className="text-base font-semibold text-gray-900">Data Ingestion</h2>
          <div className="grid md:grid-cols-2 gap-6">
            <IngestionCard
              type="source"
              title="Source Database"
              projectId={projectId}
              datasetId={sourceDataset?.id ?? null}
              state={sourceIngestion}
              onUpdate={(u) => setSourceIngestion((p) => ({ ...p, ...u }))}
            />
            <IngestionCard
              type="target"
              title="Target Database"
              projectId={projectId}
              datasetId={targetDataset?.id ?? null}
              state={targetIngestion}
              onUpdate={(u) => setTargetIngestion((p) => ({ ...p, ...u }))}
            />
          </div>
        </div>

        {/* Schema Documents — Coming Soon */}
        <div className="relative">
          {/* Coming soon overlay */}
          <div className="absolute inset-0 z-10 rounded-lg cursor-not-allowed" />

          <div className="bg-white rounded-lg border border-gray-200 opacity-50 select-none pointer-events-none">
            <div className="flex items-center justify-between px-6 pt-5 pb-4 border-b border-gray-100">
              <h2 className="text-base font-semibold text-gray-900">Schema Documents</h2>
              <span className="text-xs font-medium text-gray-500 bg-gray-100 px-2.5 py-1 rounded-full">
                Coming soon
              </span>
            </div>
            <div className="p-6">
              <div className="grid md:grid-cols-2 gap-6">
                {/* Source Schema Files */}
                <SchemaFilesPanel
                  label="Source Schema Files"
                  inputId="source-schema-upload"
                />
                {/* Target Schema Files */}
                <SchemaFilesPanel
                  label="Target Schema Files"
                  inputId="target-schema-upload"
                />
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}

function SchemaFilesPanel({ label, inputId }: { label: string; inputId: string }) {
  return (
    <div className="space-y-3">
      <h3 className="text-sm font-semibold text-gray-900">{label}</h3>
      <div className="border-2 border-dashed border-gray-300 rounded-lg p-6 text-center">
        <div className="space-y-2">
          <FileText className="w-8 h-8 text-gray-400 mx-auto" />
          <p className="text-xs text-gray-500">Upload DDL, ERD, or documentation</p>
          <input type="file" id={inputId} multiple className="hidden" disabled />
          <label htmlFor={inputId} className="cursor-not-allowed">
            <span className="inline-flex items-center justify-center rounded-md border border-gray-300 bg-white px-3 py-1.5 text-sm font-medium text-gray-700 opacity-50">
              Upload Files
            </span>
          </label>
        </div>
      </div>
    </div>
  )
}
