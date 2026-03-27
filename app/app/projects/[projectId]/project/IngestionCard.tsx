'use client'

import { useState, useRef, useCallback } from 'react'
import { useRouter } from 'next/navigation'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Upload, CheckCircle2, AlertCircle, RefreshCw } from '@/components/icons'
import { uploadCSV } from '@/lib/actions/csv'
import { createDataset, getTablesForDataset } from '@/lib/actions/datasets'
import { parseDDLFile, confirmDDLSchema } from '@/lib/actions/ddl-upload'
import type { ParsedTable } from '@/lib/parsers/ddl-parser'
import type { DatasetWithTableStats, TableStats } from '@/lib/actions/datasets'
import { DDLSchemaReview } from './DDLSchemaReview'

type IngestMethod = 'csv' | 'ddl' | 'db' | null

interface UploadState {
  status: 'idle' | 'uploading' | 'success' | 'error'
  filename?: string
  rowCount?: number
  fieldCount?: number
  error?: string
}

type DDLStep = 'upload' | 'review' | 'saved'

interface DDLState {
  step: DDLStep
  parsing: boolean
  saving: boolean
  error: string | null
  filename: string
  usedAI: boolean
  parsedTables: ParsedTable[]
  ddlContent: string
  savedTableCount: number
  isDragOver: boolean
  showReplaceConfirm: boolean
}

const INITIAL_DDL: DDLState = {
  step: 'upload',
  parsing: false,
  saving: false,
  error: null,
  filename: '',
  usedAI: false,
  parsedTables: [],
  ddlContent: '',
  savedTableCount: 0,
  isDragOver: false,
  showReplaceConfirm: false,
}

interface IngestionCardProps {
  type: 'source' | 'target'
  title: string
  projectId: string
  initialDatasets: DatasetWithTableStats[]
}

export function IngestionCard({ type, title, projectId, initialDatasets }: IngestionCardProps) {
  const router = useRouter()
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

  const [method, setMethod] = useState<IngestMethod>(null)
  const [isDragOver, setIsDragOver] = useState(false)
  const [uploadState, setUploadState] = useState<UploadState>({ status: 'idle' })
  const [showReplaceConfirm, setShowReplaceConfirm] = useState(false)
  const [pendingFile, setPendingFile] = useState<File | null>(null)
  const [creatingDataset, setCreatingDataset] = useState(false)

  const [ddl, setDdl] = useState<DDLState>(INITIAL_DDL)

  const fileInputRef = useRef<HTMLInputElement>(null)
  const ddlFileInputRef = useRef<HTMLInputElement>(null)

  const selectedDataset = datasets.find((d) => d.id === selectedDatasetId)
  const selectedTable = selectedDataset?.tables.find((t) => t.id === selectedTableId)
  const tableHasData = selectedTable && selectedTable.row_count > 0

  // ── Shared: when method changes, reset DDL state ──────────────────────────

  const handleMethodChange = (newMethod: IngestMethod) => {
    setMethod(newMethod)
    setDdl(INITIAL_DDL)
    setUploadState({ status: 'idle' })
  }

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
      setDdl(INITIAL_DDL)
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

  // ── CSV: table handlers ───────────────────────────────────────────────────

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

  // ── CSV: upload handlers ──────────────────────────────────────────────────

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
        try {
          const freshTables = await getTablesForDataset(selectedDatasetId)
          setDatasets((prev) =>
            prev.map((d) => (d.id === selectedDatasetId ? { ...d, tables: freshTables } : d))
          )
          const uploadedTable = freshTables.find((t) => t.name === selectedTableName)
          if (uploadedTable) setSelectedTableId(uploadedTable.id)
        } catch {
          // non-fatal
        }

        setUploadState({
          status: 'success',
          filename: file.name,
          rowCount: result.rowCount,
          fieldCount: result.fieldCount,
        })
        router.refresh()
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

  const handleDragOver = (e: React.DragEvent) => { e.preventDefault(); setIsDragOver(true) }
  const handleDragLeave = () => setIsDragOver(false)

  const handleConfirmReplace = () => {
    if (pendingFile) {
      setShowReplaceConfirm(false)
      doUpload(pendingFile)
      setPendingFile(null)
    }
  }
  const handleCancelReplace = () => { setShowReplaceConfirm(false); setPendingFile(null) }

  // ── DDL: upload and parse ─────────────────────────────────────────────────

  const handleDDLFile = async (file: File) => {
    if (!selectedDatasetId) return

    // If this dataset already has tables, confirm replacement
    const existingDs = datasets.find((d) => d.id === selectedDatasetId)
    if (existingDs && existingDs.tables.length > 0 && ddl.step !== 'review') {
      setDdl((s) => ({ ...s, filename: file.name, showReplaceConfirm: true }))
      // Stash the file so we can use it after confirmation
      setPendingFile(file)
      return
    }

    await doParseDDL(file)
  }

  const doParseDDL = async (file: File) => {
    setDdl((s) => ({
      ...s,
      parsing: true,
      error: null,
      filename: file.name,
      showReplaceConfirm: false,
    }))
    setPendingFile(null)

    const formData = new FormData()
    formData.append('file', file)
    formData.append('projectId', projectId)
    formData.append('datasetId', selectedDatasetId!)

    const result = await parseDDLFile(formData)

    if (result.success && result.tables) {
      setDdl((s) => ({
        ...s,
        parsing: false,
        step: 'review',
        parsedTables: result.tables!,
        usedAI: result.usedAI ?? false,
        ddlContent: result.ddlContent ?? '',
      }))
    } else {
      setDdl((s) => ({ ...s, parsing: false, error: result.error ?? 'Parse failed' }))
    }
  }

  const handleDDLInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (file) handleDDLFile(file)
    e.target.value = ''
  }

  const handleDDLDrop = (e: React.DragEvent) => {
    e.preventDefault()
    setDdl((s) => ({ ...s, isDragOver: false }))
    const file = e.dataTransfer.files[0]
    if (file) handleDDLFile(file)
  }

  // ── DDL: confirm schema ───────────────────────────────────────────────────

  const handleDDLConfirm = async (editedTables: ParsedTable[]) => {
    if (!selectedDatasetId) return

    setDdl((s) => ({ ...s, saving: true, error: null }))

    const result = await confirmDDLSchema(
      projectId,
      type,
      selectedDatasetId,
      editedTables,
      ddl.ddlContent,
      ddl.filename
    )

    if (result.success) {
      // Refresh datasets so the sidebar reflects new tables
      try {
        const freshTables = await getTablesForDataset(selectedDatasetId)
        setDatasets((prev) =>
          prev.map((d) => (d.id === selectedDatasetId ? { ...d, tables: freshTables } : d))
        )
      } catch {
        // non-fatal
      }

      setDdl((s) => ({
        ...s,
        saving: false,
        step: 'saved',
        savedTableCount: result.tableCount ?? editedTables.length,
      }))
      router.refresh()
    } else {
      setDdl((s) => ({
        ...s,
        saving: false,
        error: result.error ?? 'Failed to save schema',
      }))
    }
  }

  const handleDDLCancel = () => setDdl(INITIAL_DDL)

  // ── Render ────────────────────────────────────────────────────────────────

  const showCSVUploadZone =
    method === 'csv' &&
    selectedDatasetId &&
    selectedTableName &&
    (selectedTableId || !showNewTableInput)

  const showDDLSection = method === 'ddl' && selectedDatasetId

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

        {/* ── Method Selector ───────────────────────────────────────────── */}
        <div className="space-y-2">
          <Label htmlFor={`${type}-method`}>Data ingestion method</Label>
          <select
            id={`${type}-method`}
            value={method ?? ''}
            onChange={(e) =>
              handleMethodChange(
                e.target.value === '' ? null : (e.target.value as IngestMethod)
              )
            }
            className="w-full h-9 rounded-md border border-gray-300 px-3 py-1 text-sm focus:outline-none focus:ring-2 focus:ring-[#4F46E5]"
          >
            <option value="">Select method</option>
            <option value="csv">CSV Upload</option>
            <option value="ddl">DDL / Schema Upload</option>
            <option value="db">Database Connection</option>
          </select>
        </div>

        {/* No method selected */}
        {method === null && (
          <div className="text-center py-6 text-gray-400">
            <p className="text-sm">Select an ingestion method to continue</p>
          </div>
        )}

        {/* ── Database Connection — coming soon ─────────────────────────── */}
        {method === 'db' && (
          <div className="space-y-4">
            <div className="rounded-md border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800">
              Database connections are coming soon. Use CSV Upload or DDL / Schema Upload for now.
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

        {/* ── Shared: Dataset / Schema selector (CSV + DDL) ─────────────── */}
        {(method === 'csv' || method === 'ddl') && (
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
                  placeholder="Schema name (e.g. SAP_S4HANA)"
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
        )}

        {/* ── CSV Upload Mode ───────────────────────────────────────────── */}
        {method === 'csv' && selectedDatasetId && (
          <div className="space-y-5">
            {/* Step 2: Table selector */}
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

            {/* Step 3: Upload zone */}
            {showCSVUploadZone && (
              <div className="space-y-3">
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
                          ✓ {uploadState.rowCount?.toLocaleString()} rows,{' '}
                          {uploadState.fieldCount} fields uploaded
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

        {/* ── DDL / Schema Upload Mode ──────────────────────────────────── */}
        {showDDLSection && (
          <div className="space-y-4">

            {/* DDL replace-schema confirmation */}
            {ddl.showReplaceConfirm && (
              <div className="rounded-md border border-amber-200 bg-amber-50 px-4 py-3 space-y-2">
                <p className="text-sm text-amber-800 font-medium">Replace existing schema?</p>
                <p className="text-xs text-amber-700">
                  This will delete all existing tables and fields for this schema and replace them
                  with the DDL-defined structure. Any uploaded CSV data will also be removed.
                </p>
                <div className="flex gap-2">
                  <Button
                    size="sm"
                    className="bg-amber-600 hover:bg-amber-700 text-white"
                    onClick={() => pendingFile && doParseDDL(pendingFile)}
                  >
                    Yes, replace
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => { setDdl((s) => ({ ...s, showReplaceConfirm: false })); setPendingFile(null) }}
                  >
                    Cancel
                  </Button>
                </div>
              </div>
            )}

            {/* Upload zone — shown in 'upload' step */}
            {ddl.step === 'upload' && !ddl.showReplaceConfirm && (
              <div
                onDrop={handleDDLDrop}
                onDragOver={(e) => { e.preventDefault(); setDdl((s) => ({ ...s, isDragOver: true })) }}
                onDragLeave={() => setDdl((s) => ({ ...s, isDragOver: false }))}
                className={`border-2 border-dashed rounded-lg p-8 text-center transition-colors ${
                  ddl.isDragOver
                    ? 'border-[#4F46E5] bg-indigo-50'
                    : 'border-gray-300 hover:border-gray-400'
                }`}
              >
                {ddl.parsing ? (
                  <div className="space-y-3">
                    <div className="flex justify-center">
                      <svg className="animate-spin w-8 h-8 text-[#4F46E5]" fill="none" viewBox="0 0 24 24">
                        <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                        <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v4l3-3-3-3v4a8 8 0 00-8 8h4z" />
                      </svg>
                    </div>
                    <p className="text-sm text-gray-600">
                      Parsing <span className="font-medium">{ddl.filename}</span>…
                    </p>
                    <p className="text-xs text-gray-400">
                      Extracting table and field definitions from your DDL.
                    </p>
                  </div>
                ) : ddl.error ? (
                  <div className="space-y-2">
                    <AlertCircle className="w-10 h-10 text-red-500 mx-auto" />
                    <p className="text-sm font-medium text-red-700">Parse failed</p>
                    <p className="text-xs text-red-600 max-w-xs mx-auto">{ddl.error}</p>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => { setDdl(INITIAL_DDL); ddlFileInputRef.current?.click() }}
                    >
                      Try a different file
                    </Button>
                  </div>
                ) : (
                  <div className="space-y-3">
                    <Upload className="w-10 h-10 text-gray-400 mx-auto" />
                    <div>
                      <p className="text-sm font-medium text-gray-700">
                        {ddl.isDragOver
                          ? 'Drop DDL file here'
                          : 'Drop DDL / SQL file here or click to select'}
                      </p>
                      <p className="text-xs text-gray-400 mt-1">
                        Accepted: .sql, .ddl, .txt · Max 2 MB
                      </p>
                      <p className="text-xs text-gray-400 mt-0.5">
                        Supports standard SQL, SQL Server, Oracle, SAP HANA, MySQL, PostgreSQL
                      </p>
                    </div>
                    <Button
                      variant="outline"
                      size="sm"
                      type="button"
                      onClick={() => ddlFileInputRef.current?.click()}
                    >
                      Select File
                    </Button>
                  </div>
                )}
              </div>
            )}

            {/* Review screen */}
            {ddl.step === 'review' && !ddl.showReplaceConfirm && (
              <DDLSchemaReview
                tables={ddl.parsedTables}
                usedAI={ddl.usedAI}
                onConfirm={handleDDLConfirm}
                onCancel={handleDDLCancel}
                saving={ddl.saving}
              />
            )}

            {/* Saved confirmation */}
            {ddl.step === 'saved' && (
              <div className="space-y-3">
                <div className="flex items-center gap-3 rounded-lg bg-green-50 border border-green-200 px-4 py-3">
                  <CheckCircle2 className="w-6 h-6 text-green-600 shrink-0" />
                  <div>
                    <p className="text-sm font-medium text-green-800">
                      Schema saved — {ddl.savedTableCount} table
                      {ddl.savedTableCount !== 1 ? 's' : ''} created
                    </p>
                    <p className="text-xs text-green-700 mt-0.5">
                      Tables and fields are ready. No data rows — this is schema-only.
                    </p>
                  </div>
                </div>
                <button
                  className="text-xs text-gray-500 underline hover:text-gray-700 flex items-center gap-1"
                  onClick={() => { setDdl(INITIAL_DDL); setTimeout(() => ddlFileInputRef.current?.click(), 50) }}
                >
                  <RefreshCw className="w-3 h-3" />
                  Upload a different DDL file
                </button>
              </div>
            )}

            {/* Error outside review */}
            {ddl.step !== 'upload' && ddl.error && (
              <div className="flex items-start gap-2 rounded-md border border-red-200 bg-red-50 px-3 py-2">
                <AlertCircle className="w-4 h-4 text-red-500 shrink-0 mt-0.5" />
                <p className="text-xs text-red-700">{ddl.error}</p>
              </div>
            )}

            <input
              ref={ddlFileInputRef}
              type="file"
              accept=".sql,.ddl,.txt"
              className="hidden"
              onChange={handleDDLInputChange}
            />
          </div>
        )}

      </CardContent>
    </Card>
  )
}
