'use client'

import { useState, useRef, useCallback } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Upload, CheckCircle2, AlertCircle, RefreshCw } from '@/components/icons'
import { uploadCSV } from '@/lib/actions/csv'
import { createDataset, getTablesForDataset } from '@/lib/actions/datasets'
import type { DatasetWithTableStats, TableStats } from '@/lib/actions/datasets'

interface UploadState {
  status: 'idle' | 'uploading' | 'success' | 'error'
  filename?: string
  rowCount?: number
  fieldCount?: number
  error?: string
}

interface IngestionCardProps {
  type: 'source' | 'target'
  title: string
  projectId: string
  initialDatasets: DatasetWithTableStats[]
}

export function IngestionCard({ type, title, projectId, initialDatasets }: IngestionCardProps) {
  const [datasets, setDatasets] = useState<DatasetWithTableStats[]>(initialDatasets)
  const [selectedDatasetId, setSelectedDatasetId] = useState<string | null>(
    initialDatasets[0]?.id ?? null
  )
  const [selectedTableId, setSelectedTableId] = useState<string | null>(null)
  const [selectedTableName, setSelectedTableName] = useState<string | null>(null)

  const [newDatasetName, setNewDatasetName] = useState('')
  const [showNewDatasetInput, setShowNewDatasetInput] = useState(false)
  const [newTableName, setNewTableName] = useState('')
  const [showNewTableInput, setShowNewTableInput] = useState(false)

  const [method, setMethod] = useState<'csv' | 'db' | null>(null)
  const [isDragOver, setIsDragOver] = useState(false)
  const [uploadState, setUploadState] = useState<UploadState>({ status: 'idle' })
  const [showReplaceConfirm, setShowReplaceConfirm] = useState(false)
  const [pendingFile, setPendingFile] = useState<File | null>(null)
  const [creatingDataset, setCreatingDataset] = useState(false)

  const fileInputRef = useRef<HTMLInputElement>(null)

  const selectedDataset = datasets.find((d) => d.id === selectedDatasetId)
  const selectedTable = selectedDataset?.tables.find((t) => t.id === selectedTableId)
  const tableHasData = selectedTable && selectedTable.row_count > 0

  // ── Dataset handlers ──────────────────────────────────────────────────────

  const handleDatasetSelect = (value: string) => {
    if (value === 'new') {
      setShowNewDatasetInput(true)
      setSelectedDatasetId(null)
      setSelectedTableId(null)
      setSelectedTableName(null)
    } else {
      setSelectedDatasetId(value)
      setShowNewDatasetInput(false)
      setSelectedTableId(null)
      setSelectedTableName(null)
      setUploadState({ status: 'idle' })
    }
  }

  const handleSaveNewDataset = async () => {
    if (!newDatasetName.trim()) return
    setCreatingDataset(true)
    try {
      const created = await createDataset(projectId, type, newDatasetName.trim())
      const newDs: DatasetWithTableStats = {
        id: created.id,
        name: created.name,
        role: type,
        tables: [],
      }
      setDatasets((prev) => [...prev, newDs])
      setSelectedDatasetId(created.id)
      setNewDatasetName('')
      setShowNewDatasetInput(false)
    } catch (err) {
      console.error(err)
    } finally {
      setCreatingDataset(false)
    }
  }

  // ── Table handlers ────────────────────────────────────────────────────────

  const handleTableSelect = (value: string) => {
    if (value === 'new') {
      setShowNewTableInput(true)
      setSelectedTableId(null)
      setSelectedTableName(null)
      setUploadState({ status: 'idle' })
    } else {
      const table = selectedDataset?.tables.find((t) => t.id === value)
      setSelectedTableId(value)
      setSelectedTableName(table?.name ?? null)
      setShowNewTableInput(false)
      setUploadState({ status: 'idle' })
    }
  }

  const handleSaveNewTable = () => {
    if (!newTableName.trim()) return
    // Table is created on CSV upload — just store the name locally
    const tempId = `new_${Date.now()}`
    const newTable: TableStats = {
      id: tempId,
      name: newTableName.trim(),
      row_count: 0,
      field_count: 0,
      csv_storage_path: null,
      created_at: new Date().toISOString(),
    }
    setDatasets((prev) =>
      prev.map((d) =>
        d.id === selectedDatasetId ? { ...d, tables: [...d.tables, newTable] } : d
      )
    )
    setSelectedTableId(tempId)
    setSelectedTableName(newTableName.trim())
    setNewTableName('')
    setShowNewTableInput(false)
  }

  // ── Upload handlers ───────────────────────────────────────────────────────

  const doUpload = useCallback(
    async (file: File) => {
      if (!selectedDatasetId || !selectedTableName) return

      setUploadState({ status: 'uploading', filename: file.name })

      const formData = new FormData()
      formData.append('file', file)
      formData.append('projectId', projectId)
      formData.append('role', type)
      formData.append('datasetId', selectedDatasetId)
      formData.append('tableName', selectedTableName)

      const result = await uploadCSV(formData)

      if (result.success && result.tableId) {
        // Reload tables from DB so we have the real ID and stats
        try {
          const freshTables = await getTablesForDataset(selectedDatasetId)
          setDatasets((prev) =>
            prev.map((d) => (d.id === selectedDatasetId ? { ...d, tables: freshTables } : d))
          )
          // Auto-select the newly created/updated table
          const uploadedTable = freshTables.find((t) => t.name === selectedTableName)
          if (uploadedTable) {
            setSelectedTableId(uploadedTable.id)
          }
        } catch {
          // Non-fatal — UI will still show success
        }

        setUploadState({
          status: 'success',
          filename: file.name,
          rowCount: result.rowCount,
          fieldCount: result.fieldCount,
        })
      } else {
        setUploadState({ status: 'error', error: result.error ?? 'Upload failed' })
      }
    },
    [projectId, type, selectedDatasetId, selectedTableName]
  )

  const handleFileSelected = (file: File) => {
    if (tableHasData) {
      setPendingFile(file)
      setShowReplaceConfirm(true)
    } else {
      doUpload(file)
    }
  }

  const handleInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (file) handleFileSelected(file)
    e.target.value = ''
  }

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault()
    setIsDragOver(false)
    const file = e.dataTransfer.files[0]
    if (file) handleFileSelected(file)
  }

  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault()
    setIsDragOver(true)
  }

  const handleDragLeave = () => setIsDragOver(false)

  const handleConfirmReplace = () => {
    if (pendingFile) {
      setShowReplaceConfirm(false)
      doUpload(pendingFile)
      setPendingFile(null)
    }
  }

  const handleCancelReplace = () => {
    setShowReplaceConfirm(false)
    setPendingFile(null)
  }

  // ── Render ────────────────────────────────────────────────────────────────

  const showUploadZone =
    method === 'csv' && selectedDatasetId && (selectedTableId || showNewTableInput === false) && selectedTableName

  return (
    <Card className="border-gray-200">
      <CardHeader>
        <div className="flex items-center justify-between">
          <CardTitle className="text-base">{title}</CardTitle>
          {type === 'source' && (
            <span className="text-xs text-gray-500 bg-gray-100 px-2 py-1 rounded">
              Read-only access
            </span>
          )}
        </div>
      </CardHeader>
      <CardContent className="space-y-5">
        {/* Method Selector */}
        <div className="space-y-2">
          <Label htmlFor={`${type}-method`}>Data ingestion method</Label>
          <select
            id={`${type}-method`}
            value={method ?? ''}
            onChange={(e) => setMethod(e.target.value === '' ? null : (e.target.value as 'csv' | 'db'))}
            className="w-full h-9 rounded-md border border-gray-300 px-3 py-1 text-sm focus:outline-none focus:ring-2 focus:ring-[#4F46E5]"
          >
            <option value="">Select method</option>
            <option value="csv">CSV Upload</option>
            <option value="db">Database Connection</option>
          </select>
        </div>

        {/* No method selected */}
        {method === null && (
          <div className="text-center py-6 text-gray-400">
            <p className="text-sm">Select an ingestion method to continue</p>
          </div>
        )}

        {/* Database Connection — disabled / coming soon */}
        {method === 'db' && (
          <div className="space-y-4">
            <div className="rounded-md border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800">
              Database connections are coming soon. Use CSV Upload for now.
            </div>
            <div className="space-y-3 opacity-50 pointer-events-none">
              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1">
                  <Label>Host</Label>
                  <Input disabled placeholder="localhost" className="cursor-not-allowed" />
                </div>
                <div className="space-y-1">
                  <Label>Port</Label>
                  <Input disabled placeholder="5432" className="cursor-not-allowed" />
                </div>
              </div>
              <div className="space-y-1">
                <Label>Database Name</Label>
                <Input disabled placeholder="my_database" className="cursor-not-allowed" />
              </div>
              <div className="space-y-1">
                <Label>Username</Label>
                <Input disabled placeholder="admin" className="cursor-not-allowed" />
              </div>
              <div className="flex gap-3">
                <Button variant="outline" disabled>Test Connection</Button>
                <Button disabled className="bg-[#4F46E5] text-white">Connect Database</Button>
              </div>
            </div>
          </div>
        )}

        {/* CSV Upload Mode */}
        {method === 'csv' && (
          <div className="space-y-5">
            {/* Step 1: Dataset / Database selector */}
            <div className="space-y-2">
              <Label htmlFor={`${type}-dataset`}>Schema</Label>
              <select
                id={`${type}-dataset`}
                value={selectedDatasetId ?? ''}
                onChange={(e) => handleDatasetSelect(e.target.value)}
                className="w-full h-9 rounded-md border border-gray-300 px-3 py-1 text-sm focus:outline-none focus:ring-2 focus:ring-[#4F46E5]"
              >
                <option value="">Select schema</option>
                {datasets.map((d) => (
                  <option key={d.id} value={d.id}>
                    {d.name}
                  </option>
                ))}
                <option value="new">+ Add new schema</option>
              </select>

              {showNewDatasetInput && (
                <div className="flex gap-2">
                  <Input
                    placeholder="Schema name (e.g. SALESFORCE_PROD)"
                    value={newDatasetName}
                    onChange={(e) => setNewDatasetName(e.target.value)}
                    onKeyDown={(e) => e.key === 'Enter' && handleSaveNewDataset()}
                    autoFocus
                  />
                  <Button
                    size="sm"
                    onClick={handleSaveNewDataset}
                    disabled={!newDatasetName.trim() || creatingDataset}
                    className="bg-[#4F46E5] hover:bg-[#4338CA] text-white"
                  >
                    {creatingDataset ? 'Saving…' : 'Save'}
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => { setShowNewDatasetInput(false); setNewDatasetName('') }}
                  >
                    Cancel
                  </Button>
                </div>
              )}
            </div>

            {/* Step 2: Table selector */}
            {selectedDatasetId && (
              <div className="space-y-2">
                <Label htmlFor={`${type}-table`}>Table</Label>
                <select
                  id={`${type}-table`}
                  value={selectedTableId ?? ''}
                  onChange={(e) => handleTableSelect(e.target.value)}
                  className="w-full h-9 rounded-md border border-gray-300 px-3 py-1 text-sm focus:outline-none focus:ring-2 focus:ring-[#4F46E5]"
                >
                  <option value="">Select table</option>
                  {selectedDataset?.tables.map((t) => (
                    <option key={t.id} value={t.id}>
                      {t.name}
                      {t.row_count > 0 ? ` (${t.row_count.toLocaleString()} rows)` : ''}
                    </option>
                  ))}
                  <option value="new">+ Add new table</option>
                </select>

                {showNewTableInput && (
                  <div className="flex gap-2">
                    <Input
                      placeholder="Table name (e.g. Account)"
                      value={newTableName}
                      onChange={(e) => setNewTableName(e.target.value)}
                      onKeyDown={(e) => e.key === 'Enter' && handleSaveNewTable()}
                      autoFocus
                    />
                    <Button
                      size="sm"
                      onClick={handleSaveNewTable}
                      disabled={!newTableName.trim()}
                      className="bg-[#4F46E5] hover:bg-[#4338CA] text-white"
                    >
                      Save
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => { setShowNewTableInput(false); setNewTableName('') }}
                    >
                      Cancel
                    </Button>
                  </div>
                )}
              </div>
            )}

            {/* Step 3: Upload zone */}
            {showUploadZone && (
              <div className="space-y-3">
                {/* Existing data summary */}
                {tableHasData && uploadState.status === 'idle' && (
                  <div className="flex items-center justify-between rounded-md bg-green-50 border border-green-200 px-3 py-2">
                    <div className="flex items-center gap-2">
                      <CheckCircle2 className="w-4 h-4 text-green-600" />
                      <span className="text-sm text-green-800 font-medium">
                        {selectedTable.row_count.toLocaleString()} rows
                        {selectedTable.field_count > 0
                          ? `, ${selectedTable.field_count} fields`
                          : ''}{' '}
                        uploaded
                      </span>
                    </div>
                    <button
                      className="text-xs text-green-700 underline hover:text-green-900 flex items-center gap-1"
                      onClick={() => fileInputRef.current?.click()}
                    >
                      <RefreshCw className="w-3 h-3" />
                      Re-upload
                    </button>
                  </div>
                )}

                {/* Replace confirmation */}
                {showReplaceConfirm && (
                  <div className="rounded-md border border-amber-200 bg-amber-50 px-4 py-3 space-y-2">
                    <p className="text-sm text-amber-800 font-medium">Replace existing data?</p>
                    <p className="text-xs text-amber-700">
                      This will delete all existing rows and schema for{' '}
                      <strong>{selectedTableName}</strong> and replace them with the new CSV.
                    </p>
                    <div className="flex gap-2">
                      <Button
                        size="sm"
                        className="bg-amber-600 hover:bg-amber-700 text-white"
                        onClick={handleConfirmReplace}
                      >
                        Yes, replace
                      </Button>
                      <Button size="sm" variant="outline" onClick={handleCancelReplace}>
                        Cancel
                      </Button>
                    </div>
                  </div>
                )}

                {/* Upload zone */}
                {!showReplaceConfirm && (
                  <div
                    onDrop={handleDrop}
                    onDragOver={handleDragOver}
                    onDragLeave={handleDragLeave}
                    className={`border-2 border-dashed rounded-lg p-8 text-center transition-colors ${
                      isDragOver
                        ? 'border-[#4F46E5] bg-indigo-50'
                        : 'border-gray-300 hover:border-gray-400'
                    }`}
                  >
                    {uploadState.status === 'uploading' && (
                      <div className="space-y-3">
                        <div className="flex justify-center">
                          <svg className="animate-spin w-8 h-8 text-[#4F46E5]" fill="none" viewBox="0 0 24 24">
                            <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                            <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v4l3-3-3-3v4a8 8 0 00-8 8h4z" />
                          </svg>
                        </div>
                        <p className="text-sm text-gray-600">
                          Uploading <span className="font-medium">{uploadState.filename}</span>…
                        </p>
                        <p className="text-xs text-gray-400">
                          Inferring schema and storing rows. Large files may take a moment.
                        </p>
                      </div>
                    )}

                    {uploadState.status === 'success' && (
                      <div className="space-y-2">
                        <CheckCircle2 className="w-10 h-10 text-green-500 mx-auto" />
                        <p className="text-sm font-medium text-gray-900">{uploadState.filename}</p>
                        <p className="text-sm text-green-700 font-medium">
                          ✓ {uploadState.rowCount?.toLocaleString()} rows, {uploadState.fieldCount} fields uploaded
                        </p>
                        <button
                          className="text-xs text-gray-500 underline mt-1"
                          onClick={() => {
                            setUploadState({ status: 'idle' })
                            setTimeout(() => fileInputRef.current?.click(), 50)
                          }}
                        >
                          Upload a different file
                        </button>
                      </div>
                    )}

                    {uploadState.status === 'error' && (
                      <div className="space-y-2">
                        <AlertCircle className="w-10 h-10 text-red-500 mx-auto" />
                        <p className="text-sm font-medium text-red-700">Upload failed</p>
                        <p className="text-xs text-red-600">{uploadState.error}</p>
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => {
                            setUploadState({ status: 'idle' })
                            fileInputRef.current?.click()
                          }}
                        >
                          Try again
                        </Button>
                      </div>
                    )}

                    {uploadState.status === 'idle' && (
                      <div className="space-y-3">
                        <Upload className="w-10 h-10 text-gray-400 mx-auto" />
                        <div>
                          <p className="text-sm font-medium text-gray-700">
                            {isDragOver
                              ? 'Drop file here'
                              : tableHasData
                              ? 'Drop CSV to re-upload'
                              : 'Drop CSV here or click to select'}
                          </p>
                          <p className="text-xs text-gray-400 mt-1">
                            One CSV per table · Max 10MB · Up to 100,000 rows
                          </p>
                        </div>
                        <Button
                          variant="outline"
                          size="sm"
                          type="button"
                          onClick={() => fileInputRef.current?.click()}
                        >
                          Select File
                        </Button>
                      </div>
                    )}
                  </div>
                )}

                <input
                  ref={fileInputRef}
                  type="file"
                  accept=".csv,text/csv"
                  className="hidden"
                  onChange={handleInputChange}
                />
              </div>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  )
}
