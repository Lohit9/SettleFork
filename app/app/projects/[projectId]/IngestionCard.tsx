'use client'

import { useRef } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Upload, CheckCircle2 } from '@/components/icons'
import { uploadCSV } from '@/lib/actions/csv'

type IngestionMethod = 'db' | 'csv' | null

interface DatabaseConnection {
  host: string
  port: string
  databaseName: string
  username: string
}

interface TableEntry {
  id: string
  name: string
  lastUploaded?: string
}

interface DatabaseEntry {
  id: string
  name: string
  tables: TableEntry[]
}

export interface CsvState {
  selectedDbId: string | null
  selectedTableId: string | null
  databases: DatabaseEntry[]
  newDbName: string
  newTableName: string
  showNewDbInput: boolean
  showNewTableInput: boolean
  uploadStatus: 'idle' | 'uploading' | 'complete' | 'error'
  uploadError: string | null
}

export interface IngestionState {
  method: IngestionMethod
  db: DatabaseConnection
  csv: CsvState
}

interface IngestionCardProps {
  type: 'source' | 'target'
  title: string
  projectId: string
  datasetId: string | null
  state: IngestionState
  onUpdate: (updates: Partial<IngestionState>) => void
}

export function IngestionCard({
  type,
  title,
  projectId,
  datasetId,
  state,
  onUpdate,
}: IngestionCardProps) {
  const fileInputRef = useRef<HTMLInputElement>(null)

  // ── Database Dropdown ──────────────────────────────────────────────────
  const handleDatabaseSelect = (value: string) => {
    if (value === 'new') {
      onUpdate({ csv: { ...state.csv, showNewDbInput: true, selectedDbId: null, selectedTableId: null } })
    } else {
      onUpdate({ csv: { ...state.csv, selectedDbId: value, showNewDbInput: false, selectedTableId: null } })
    }
  }

  const handleSaveNewDatabase = () => {
    if (!state.csv.newDbName.trim()) return
    const newDb: DatabaseEntry = { id: `db_${Date.now()}`, name: state.csv.newDbName, tables: [] }
    onUpdate({
      csv: {
        ...state.csv,
        databases: [...state.csv.databases, newDb],
        selectedDbId: newDb.id,
        newDbName: '',
        showNewDbInput: false,
      },
    })
  }

  // ── Table Dropdown ─────────────────────────────────────────────────────
  const selectedDatabase = state.csv.databases.find((db) => db.id === state.csv.selectedDbId)

  const handleTableSelect = (value: string) => {
    if (value === 'new') {
      onUpdate({ csv: { ...state.csv, showNewTableInput: true, selectedTableId: null } })
    } else {
      onUpdate({ csv: { ...state.csv, selectedTableId: value, showNewTableInput: false } })
    }
  }

  const handleSaveNewTable = () => {
    if (!state.csv.newTableName.trim() || !state.csv.selectedDbId) return
    const newTable: TableEntry = { id: `t_${Date.now()}`, name: state.csv.newTableName }
    onUpdate({
      csv: {
        ...state.csv,
        databases: state.csv.databases.map((db) =>
          db.id === state.csv.selectedDbId
            ? { ...db, tables: [...db.tables, newTable] }
            : db
        ),
        selectedTableId: newTable.id,
        newTableName: '',
        showNewTableInput: false,
      },
    })
  }

  const selectedTable = selectedDatabase?.tables.find((t) => t.id === state.csv.selectedTableId)

  // ── CSV Upload ─────────────────────────────────────────────────────────
  const handleFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file || !datasetId || !selectedTable) return

    onUpdate({ csv: { ...state.csv, uploadStatus: 'uploading', uploadError: null } })

    const formData = new FormData()
    formData.append('file', file)
    formData.append('projectId', projectId)
    formData.append('datasetId', datasetId)
    formData.append('tableName', selectedTable.name)

    const result = await uploadCSV(formData)

    if (result.success) {
      const now = new Date().toLocaleString()
      onUpdate({
        csv: {
          ...state.csv,
          uploadStatus: 'complete',
          uploadError: null,
          databases: state.csv.databases.map((db) =>
            db.id === state.csv.selectedDbId
              ? {
                  ...db,
                  tables: db.tables.map((t) =>
                    t.id === state.csv.selectedTableId ? { ...t, lastUploaded: now } : t
                  ),
                }
              : db
          ),
        },
      })
      // Reset to idle after 3s
      setTimeout(
        () =>
          onUpdate({
            csv: { ...state.csv, uploadStatus: 'idle', uploadError: null },
          }),
        3000
      )
    } else {
      onUpdate({ csv: { ...state.csv, uploadStatus: 'error', uploadError: result.error ?? null } })
    }

    // Reset the file input so the same file can be re-uploaded
    if (fileInputRef.current) fileInputRef.current.value = ''
  }

  const isUploading = state.csv.uploadStatus === 'uploading'
  const isComplete = state.csv.uploadStatus === 'complete'
  const isError = state.csv.uploadStatus === 'error'
  const isExistingTable = !!selectedTable?.lastUploaded

  return (
    <div className="bg-white rounded-lg border border-gray-200">
      {/* Card Header */}
      <div className="flex items-center justify-between px-6 pt-5 pb-4 border-b border-gray-100">
        <span className="text-sm font-semibold text-gray-900">{title}</span>
        {type === 'source' && (
          <span className="text-xs text-gray-500 bg-gray-100 px-2.5 py-1 rounded-full">
            Read-only access
          </span>
        )}
      </div>

      <div className="p-6 space-y-5">
        {/* Method Selector */}
        <div className="space-y-1.5">
          <Label className="text-sm text-gray-700">Data ingestion method</Label>
          <select
            value={state.method || ''}
            onChange={(e) => {
              const v = e.target.value
              onUpdate({ method: v === '' ? null : (v as IngestionMethod) })
            }}
            className="w-full h-9 rounded-md border border-gray-300 bg-white px-3 text-sm focus:outline-none focus:ring-2 focus:ring-[#4F46E5]"
          >
            <option value="">Select method</option>
            <option value="db" disabled>
              Database Connection — Coming soon
            </option>
            <option value="csv">CSV Upload</option>
          </select>
        </div>

        {/* Empty State */}
        {state.method === null && (
          <div className="py-10 text-center">
            <p className="text-sm text-gray-400">Select an ingestion method to continue</p>
          </div>
        )}

        {/* ── Database Connection (Coming Soon) ───────────────────────── */}
        {state.method === 'db' && (
          <div className="space-y-4">
            {/* Coming soon banner */}
            <div className="flex items-start gap-2 bg-amber-50 border border-amber-200 rounded-md px-3 py-2.5">
              <span className="text-amber-600 text-sm font-medium leading-5">
                Database connections coming soon.{' '}
                <button
                  className="underline underline-offset-2 text-amber-700 font-semibold"
                  onClick={() => onUpdate({ method: 'csv' })}
                >
                  Use CSV Upload for now.
                </button>
              </span>
            </div>

            <fieldset disabled className="space-y-4 opacity-50 cursor-not-allowed">
              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-1.5">
                  <Label>Host</Label>
                  <Input placeholder="localhost" className="cursor-not-allowed" />
                </div>
                <div className="space-y-1.5">
                  <Label>Port</Label>
                  <Input type="number" placeholder="5432" className="cursor-not-allowed" />
                </div>
              </div>
              <div className="space-y-1.5">
                <Label>Database Name</Label>
                <Input
                  placeholder={type === 'source' ? 'salesforce_prod' : 'sap_s4hana'}
                  className="cursor-not-allowed"
                />
              </div>
              <div className="space-y-1.5">
                <Label>Username</Label>
                <Input placeholder="admin" className="cursor-not-allowed" />
              </div>
              <div className="flex gap-3">
                <Button variant="outline" disabled className="cursor-not-allowed">
                  Test Connection
                </Button>
                <Button disabled className="bg-[#4F46E5] text-white cursor-not-allowed">
                  Connect Database
                </Button>
              </div>
            </fieldset>
          </div>
        )}

        {/* ── CSV Upload ───────────────────────────────────────────────── */}
        {state.method === 'csv' && (
          <div className="space-y-5">
            {/* Database Selector */}
            <div className="space-y-1.5">
              <Label>Database</Label>
              <select
                value={state.csv.selectedDbId || ''}
                onChange={(e) => handleDatabaseSelect(e.target.value)}
                className="w-full h-9 rounded-md border border-gray-300 bg-white px-3 text-sm focus:outline-none focus:ring-2 focus:ring-[#4F46E5]"
              >
                <option value="">Select database</option>
                {state.csv.databases.map((db) => (
                  <option key={db.id} value={db.id}>
                    {db.name}
                  </option>
                ))}
                <option value="new">+ Add new database</option>
              </select>

              {state.csv.showNewDbInput && (
                <div className="flex gap-2 mt-2">
                  <Input
                    placeholder="Database name (e.g. SALESFORCE_PROD)"
                    value={state.csv.newDbName}
                    onChange={(e) => onUpdate({ csv: { ...state.csv, newDbName: e.target.value } })}
                    onKeyDown={(e) => e.key === 'Enter' && handleSaveNewDatabase()}
                    autoFocus
                  />
                  <Button size="sm" onClick={handleSaveNewDatabase} disabled={!state.csv.newDbName.trim()}>
                    Save
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => onUpdate({ csv: { ...state.csv, showNewDbInput: false, newDbName: '' } })}
                  >
                    Cancel
                  </Button>
                </div>
              )}
            </div>

            {/* Table Selector — only shown once a database is selected */}
            {state.csv.selectedDbId && (
              <div className="space-y-1.5">
                <Label>Table</Label>
                <select
                  value={state.csv.selectedTableId || ''}
                  onChange={(e) => handleTableSelect(e.target.value)}
                  className="w-full h-9 rounded-md border border-gray-300 bg-white px-3 text-sm focus:outline-none focus:ring-2 focus:ring-[#4F46E5]"
                >
                  <option value="">Select table</option>
                  {selectedDatabase?.tables.map((t) => (
                    <option key={t.id} value={t.id}>
                      {t.name}
                    </option>
                  ))}
                  <option value="new">+ Add new table</option>
                </select>

                {state.csv.showNewTableInput && (
                  <div className="flex gap-2 mt-2">
                    <Input
                      placeholder="Table name (e.g. Account)"
                      value={state.csv.newTableName}
                      onChange={(e) =>
                        onUpdate({ csv: { ...state.csv, newTableName: e.target.value } })
                      }
                      onKeyDown={(e) => e.key === 'Enter' && handleSaveNewTable()}
                      autoFocus
                    />
                    <Button
                      size="sm"
                      onClick={handleSaveNewTable}
                      disabled={!state.csv.newTableName.trim()}
                    >
                      Save
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() =>
                        onUpdate({ csv: { ...state.csv, showNewTableInput: false, newTableName: '' } })
                      }
                    >
                      Cancel
                    </Button>
                  </div>
                )}

                {selectedTable?.lastUploaded && (
                  <p className="text-xs text-gray-500 flex items-center gap-1 mt-1">
                    <CheckCircle2 className="w-3.5 h-3.5 text-green-500" />
                    Last uploaded: {selectedTable.lastUploaded}
                  </p>
                )}
              </div>
            )}

            {/* CSV Upload Zone — only shown once a table is selected */}
            {state.csv.selectedTableId && (
              <div className="space-y-3">
                <div
                  className={`border-2 border-dashed rounded-lg p-8 text-center transition-colors ${
                    isUploading
                      ? 'border-indigo-300 bg-indigo-50'
                      : isComplete
                        ? 'border-green-300 bg-green-50'
                        : isError
                          ? 'border-red-300 bg-red-50'
                          : 'border-gray-300 hover:border-gray-400'
                  }`}
                >
                  <div className="space-y-3">
                    {isComplete ? (
                      <CheckCircle2 className="w-10 h-10 text-green-500 mx-auto" />
                    ) : (
                      <Upload
                        className={`w-10 h-10 mx-auto ${isUploading ? 'text-indigo-400 animate-pulse' : 'text-gray-400'}`}
                      />
                    )}

                    <div>
                      {isUploading && (
                        <p className="text-sm font-medium text-indigo-700">
                          {isExistingTable ? 'Refreshing table data…' : 'Uploading and inferring schema…'}
                        </p>
                      )}
                      {isComplete && (
                        <p className="text-sm font-medium text-green-700">Upload complete!</p>
                      )}
                      {isError && (
                        <p className="text-sm font-medium text-red-700">
                          {state.csv.uploadError || 'Upload failed'}
                        </p>
                      )}
                      {!isUploading && !isComplete && !isError && (
                        <>
                          <p className="text-sm text-gray-700 font-medium mb-0.5">
                            Upload CSV data for the selected table
                          </p>
                          <p className="text-xs text-gray-500">
                            {isExistingTable
                              ? 'This upload will refresh the existing table data.'
                              : 'A new table will be created with this data.'}
                          </p>
                        </>
                      )}
                    </div>

                    {!isComplete && (
                      <>
                        <input
                          ref={fileInputRef}
                          type="file"
                          accept=".csv,text/csv"
                          className="hidden"
                          disabled={isUploading}
                          onChange={handleFileChange}
                        />
                        <Button
                          variant="outline"
                          type="button"
                          disabled={isUploading}
                          onClick={() => fileInputRef.current?.click()}
                        >
                          {isUploading ? 'Uploading…' : isError ? 'Try Again' : 'Select Files'}
                        </Button>
                      </>
                    )}
                  </div>
                </div>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  )
}
