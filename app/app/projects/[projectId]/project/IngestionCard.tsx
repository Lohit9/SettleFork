'use client'

import { useState, useRef, useCallback, useEffect } from 'react'
import { useRouter } from 'next/navigation'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Upload, CheckCircle2, AlertCircle, RefreshCw } from '@/components/icons'
import { Database, Loader2, AlertTriangle, XCircle } from 'lucide-react'
import { testConnection, listRemoteTables, listMssqlSchemas, listTablesForConnection, getConnectionForDataset, disconnectDatabase, resyncTables } from '@/lib/actions/db-connector'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { getCsvUploadSlot } from '@/lib/actions/csv'
import { queueIngestionJob, getIngestionJobStatus } from '@/lib/actions/ingestion-jobs'
import { uploadToSignedUrl } from '@/lib/utils/upload-helpers'
import Papa from 'papaparse'
import { createDataset, getTablesForDataset } from '@/lib/actions/datasets'
import { parseDDLFile, confirmDDLSchema } from '@/lib/actions/ddl-upload'
import type { ParsedTable } from '@/lib/parsers/ddl-parser'
import type { DatasetWithTableStats, TableStats } from '@/lib/actions/datasets'
import type { DBConnectionInfo } from '@/lib/types/database'
import { DDLSchemaReview } from './DDLSchemaReview'
import { useProjectRole } from '@/lib/hooks/useProjectRole'
import { RoleTooltip } from '@/components/app/RoleTooltip'

type IngestMethod = 'csv' | 'ddl' | 'db' | null

interface UploadState {
  status:
    | 'idle'
    | 'requesting-slot'
    | 'uploading'
    | 'queued'
    | 'processing'
    | 'success'
    | 'error'
  filename?: string
  // bytes uploaded so far (only meaningful in 'uploading' phase)
  uploadedBytes?: number
  // total file size in bytes (only meaningful in 'uploading' phase)
  totalBytes?: number
  // background-job id once queueIngestionJob succeeds; drives polling
  jobId?: string
  // worker-reported progress 0..1 (only meaningful in 'processing' phase)
  workerProgress?: number
  // worker-reported counts during processing
  completedRows?: number
  totalRows?: number
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
  initialConnection?: DBConnectionInfo | null
  isArchived?: boolean
}

export function IngestionCard({ type, title, projectId, initialDatasets, initialConnection = null, isArchived = false }: IngestionCardProps) {
  const router = useRouter()
  const { can } = useProjectRole(projectId)
  const canEdit = can('edit')
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

  const [method, setMethod] = useState<IngestMethod>(() => {
    if (initialConnection) return 'db'
    return null // let the useEffect handle async detection
  })
  const [isDragOver, setIsDragOver] = useState(false)
  const [uploadState, setUploadState] = useState<UploadState>({ status: 'idle' })
  const [showReplaceConfirm, setShowReplaceConfirm] = useState(false)
  const [pendingFile, setPendingFile] = useState<File | null>(null)
  const [creatingDataset, setCreatingDataset] = useState(false)

  const [ddl, setDdl] = useState<DDLState>(INITIAL_DDL)

  // ── DB Connector state ────────────────────────────────────────────────────
  // Connection view: 'loading' while checking, 'form' = State A, 'connected' = State B, 'adding' = State C
  // If the server passed an initialConnection, skip loading entirely and show connected view immediately.
  const [connectionView, setConnectionView] = useState<'loading' | 'form' | 'connected' | 'adding'>(
    initialConnection ? 'connected' : 'form'
  )
  const [existingConnection, setExistingConnection] = useState<DBConnectionInfo | null>(initialConnection ?? null)
  const [dbType, setDbType] = useState<'postgresql' | 'mysql' | 'mssql'>(
    initialConnection?.db_type ?? 'postgresql'
  )

  // State A: new connection form
  const [dbHost, setDbHost] = useState('')
  const [dbPort, setDbPort] = useState(5432)
  const [dbName, setDbName] = useState('')
  const [dbUser, setDbUser] = useState('')
  const [dbPassword, setDbPassword] = useState('')
  const [dbSslMode, setDbSslMode] = useState('require')
  // MS SQL-specific encryption options
  const [dbEncrypt, setDbEncrypt] = useState(true)
  const [dbTrustCert, setDbTrustCert] = useState(false)
  // MS SQL schema picker
  const [dbSchema, setDbSchema] = useState('dbo')
  const [schemas, setSchemas] = useState<string[]>([])
  const [connectionStatus, setConnectionStatus] = useState<'idle' | 'testing' | 'success' | 'error'>('idle')
  const [connectionError, setConnectionError] = useState<string | null>(null)
  const [remoteTables, setRemoteTables] = useState<{ name: string; estimatedRows: number }[] | null>(null)
  const [selectedRemoteTables, setSelectedRemoteTables] = useState<string[]>([])
  const [importing, setImporting] = useState(false)
  const [importProgress, setImportProgress] = useState<string | null>(null)
  const [importComplete, setImportComplete] = useState(false)
  const [dbDatasetId, setDbDatasetId] = useState<string | null>(null)

  // State B: connected view
  const [disconnectConfirm, setDisconnectConfirm] = useState(false)
  const [disconnecting, setDisconnecting] = useState(false)

  // State B/C: re-sync state (keyed by table name for individual re-syncs, or 'all')
  const [resyncingAll, setResyncingAll] = useState(false)
  const [resyncingTable, setResyncingTable] = useState<string | null>(null)
  const [resyncMessage, setResyncMessage] = useState<string | null>(null)

  // State C: adding more tables
  const [addMoreTables, setAddMoreTables] = useState<{ name: string; estimatedRows: number }[] | null>(null)
  const [addMoreSelected, setAddMoreSelected] = useState<string[]>([])
  const [addMoreLoading, setAddMoreLoading] = useState(false)
  const [addMoreError, setAddMoreError] = useState<string | null>(null)

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
    // Reset DB connector state — start on form; useEffect upgrades to 'connected' if a connection exists
    setConnectionView('form')
    setExistingConnection(null)
    setConnectionStatus('idle')
    setConnectionError(null)
    setRemoteTables(null)
    setSelectedRemoteTables([])
    setImporting(false)
    setImportProgress(null)
    setImportComplete(false)
    setDbDatasetId(null)
    setDisconnectConfirm(false)
    setResyncMessage(null)
    setAddMoreTables(null)
    setAddMoreSelected([])
    setAddMoreError(null)
    setDbEncrypt(true)
    setDbTrustCert(false)
    setDbSchema('dbo')
    setSchemas([])
  }

  // ── Auto-detect ingestion method on mount / dataset change ───────────────
  // Priority: initialConnection prop → async DB check → CSV → DDL → null

  useEffect(() => {
    if (!selectedDatasetId) return

    const dataset = datasets.find((ds) => ds.id === selectedDatasetId)

    // 1. Server-side prop is present — instant, no async needed
    if (initialConnection) {
      setMethod('db')
      setExistingConnection(initialConnection)
      setDbType(initialConnection.db_type)
      setConnectionView('connected')
      return
    }

    // 2. No server prop — check DB connection asynchronously
    //    This covers the RSC serialization edge case and is the authoritative DB check
    getConnectionForDataset(selectedDatasetId).then((result) => {
      if (result.connection) {
        setMethod('db')
        setExistingConnection(result.connection)
        setDbType(result.connection.db_type)
        setConnectionView('connected')
        return
      }

      // 3. No DB connection — check for CSV (non-null csv_storage_path is the reliable signal)
      if (dataset?.tables?.some((t) => t.csv_storage_path)) {
        setMethod('csv')
        setConnectionView('form')
        return
      }

      // 4. Tables exist but all have csv_storage_path: null — DDL import
      if ((dataset?.tables?.length ?? 0) > 0) {
        setMethod('ddl')
        setConnectionView('form')
        return
      }

      // 5. No data at all — leave as null, show method selector
      setMethod(null)
      setConnectionView('form')
    }).catch(() => {
      // On network/auth error fall back to table-based detection
      if (dataset?.tables?.some((t) => t.csv_storage_path)) {
        setMethod('csv')
      } else if ((dataset?.tables?.length ?? 0) > 0) {
        setMethod('ddl')
      }
      setConnectionView('form')
    })
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedDatasetId, initialConnection])

  // ── DB Connector handlers — State A ──────────────────────────────────────

  const handleDbTypeSelect = (t: 'postgresql' | 'mysql' | 'mssql') => {
    setDbType(t)
    setDbPort(t === 'postgresql' ? 5432 : t === 'mysql' ? 3306 : 1433)
    // Reset connection state when switching types
    setConnectionStatus('idle')
    setConnectionError(null)
    setRemoteTables(null)
    setSelectedRemoteTables([])
    setSchemas([])
    setDbSchema('dbo')
  }

  // Map MS SQL encrypt/trustCert checkboxes to the sslMode string the server action expects
  const getMssqlSslMode = () => {
    if (!dbEncrypt) return 'disable'
    if (dbTrustCert) return 'require'
    return 'verify-full'
  }

  const handleTestConnection = async () => {
    setConnectionStatus('testing')
    setConnectionError(null)
    const sslMode = dbType === 'mssql' ? getMssqlSslMode() : dbSslMode

    const result = await testConnection({
      host: dbHost, port: dbPort, database: dbName,
      username: dbUser, password: dbPassword, sslMode,
      dbType,
    })
    if (result.success) {
      setConnectionStatus('success')

      // For MS SQL: fetch available schemas, then list tables in the selected one
      if (dbType === 'mssql') {
        const schemasResult = await listMssqlSchemas({
          host: dbHost, port: dbPort, database: dbName,
          username: dbUser, password: dbPassword, sslMode,
        })
        if (schemasResult.success && schemasResult.schemas) {
          setSchemas(schemasResult.schemas)
          // Keep dbSchema as 'dbo' unless dbo isn't available
          if (!schemasResult.schemas.includes(dbSchema)) {
            setDbSchema(schemasResult.schemas[0] ?? 'dbo')
          }
        }
      }

      const tablesResult = await listRemoteTables({
        host: dbHost, port: dbPort, database: dbName,
        username: dbUser, password: dbPassword, sslMode,
        dbType,
        schema: dbType === 'mssql' ? dbSchema : undefined,
      })
      if (tablesResult.success && tablesResult.tables) {
        setRemoteTables(tablesResult.tables)
      } else {
        setRemoteTables([])
      }
    } else {
      setConnectionStatus('error')
      setConnectionError(result.error ?? 'Connection failed')
    }
  }

  // Re-fetch tables when the MS SQL schema picker changes
  const handleSchemaChange = async (newSchema: string) => {
    setDbSchema(newSchema)
    setSelectedRemoteTables([])
    const sslMode = getMssqlSslMode()
    const tablesResult = await listRemoteTables({
      host: dbHost, port: dbPort, database: dbName,
      username: dbUser, password: dbPassword, sslMode,
      dbType: 'mssql',
      schema: newSchema,
    })
    if (tablesResult.success && tablesResult.tables) {
      setRemoteTables(tablesResult.tables)
    } else {
      setRemoteTables([])
    }
  }

  const handleImport = async () => {
    if (selectedRemoteTables.length === 0) return
    setImporting(true)
    setConnectionError(null)
    setImportProgress(`Connecting to ${dbName}…`)
    try {
      let datasetId = dbDatasetId ?? selectedDatasetId
      if (!datasetId) {
        const created = await createDataset(projectId, type, dbName)
        datasetId = created.id
        setDbDatasetId(datasetId)
        const newDs: DatasetWithTableStats = { id: created.id, name: created.name, role: type, tables: [] }
        setDatasets((prev) => [...prev, newDs])
      }
      setImportProgress(`Importing ${selectedRemoteTables.length} table(s)… This may take up to a minute.`)
      const response = await fetch('/api/db-import', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          projectId, role: type, datasetId,
          host: dbHost, port: dbPort, database: dbName,
          username: dbUser, password: dbPassword,
          sslMode: dbType === 'mssql' ? getMssqlSslMode() : dbSslMode,
          selectedTables: selectedRemoteTables,
          dbType,
          ...(dbType === 'mssql' ? { schema: dbSchema } : {}),
        }),
      })
      const result = await response.json()
      if (result.success) {
        // Refresh local datasets state immediately so connected view shows tables without a page reload
        try {
          const freshTables = await getTablesForDataset(datasetId)
          setDatasets((prev) =>
            prev.map((ds) => (ds.id === datasetId ? { ...ds, tables: freshTables } : ds))
          )
        } catch {
          // non-fatal — tables will appear after router.refresh()
        }
        // Transition to State B: reload connection info
        const connResult = await getConnectionForDataset(datasetId)
        if (connResult.connection) {
          setExistingConnection(connResult.connection)
          setConnectionView('connected')
        } else {
          setImportComplete(true)
        }
        router.refresh()
      } else {
        setConnectionError(result.error ?? 'Import failed')
      }
    } catch (err) {
      setConnectionError(err instanceof Error ? err.message : 'Import failed. Please try again.')
    } finally {
      setImporting(false)
      setImportProgress(null)
    }
  }

  // ── DB Connector handlers — State B ──────────────────────────────────────

  const handleConfirmDisconnect = async () => {
    if (!existingConnection || !selectedDatasetId) return
    setDisconnecting(true)
    const result = await disconnectDatabase(selectedDatasetId, projectId)
    if (result.success) {
      setExistingConnection(null)
      setDisconnectConfirm(false)
      setConnectionView('form')
      setDbHost(''); setDbPort(5432); setDbName(''); setDbUser(''); setDbPassword(''); setDbSslMode('require')
      setConnectionStatus('idle'); setConnectionError(null)
      setRemoteTables(null); setSelectedRemoteTables([])
      setImportComplete(false)
      router.refresh()
    } else {
      setDisconnectConfirm(false)
      setResyncMessage(result.error ?? 'Disconnect failed.')
    }
    setDisconnecting(false)
  }

  const handleResyncAll = async () => {
    if (!existingConnection || !selectedDatasetId) return
    const tableNames = (selectedDataset?.tables ?? []).map((t) => t.name)
    if (tableNames.length === 0) return
    setResyncingAll(true)
    setResyncMessage(null)
    const result = await resyncTables({
      connectionId: existingConnection.id,
      datasetId: selectedDatasetId,
      projectId,
      role: type,
      tableNames,
    })
    if (result.success) {
      setResyncMessage(`Re-synced ${result.tablesImported} table${result.tablesImported !== 1 ? 's' : ''} successfully.`)
      const connResult = await getConnectionForDataset(selectedDatasetId)
      if (connResult.connection) setExistingConnection(connResult.connection)
      router.refresh()
    } else {
      setResyncMessage(result.error ?? 'Re-sync failed.')
    }
    setResyncingAll(false)
  }

  const handleResyncOne = async (tableName: string) => {
    if (!existingConnection || !selectedDatasetId) return
    setResyncingTable(tableName)
    setResyncMessage(null)
    const result = await resyncTables({
      connectionId: existingConnection.id,
      datasetId: selectedDatasetId,
      projectId,
      role: type,
      tableNames: [tableName],
    })
    if (result.success) {
      setResyncMessage(`"${tableName}" re-synced successfully.`)
      router.refresh()
    } else {
      setResyncMessage(result.error ?? 'Re-sync failed.')
    }
    setResyncingTable(null)
  }

  // ── DB Connector handlers — State C ──────────────────────────────────────

  const handleOpenAddMore = async () => {
    if (!existingConnection) return
    setAddMoreError(null)
    setAddMoreLoading(true)
    setConnectionView('adding')
    setAddMoreSelected([])
    // Use server-side action that decrypts stored credentials — password never sent to client
    const tablesResult = await listTablesForConnection(existingConnection.id)
      .catch(() => ({ success: false as const, tables: undefined, error: 'Could not list tables.' }))
    if (tablesResult.success && tablesResult.tables) {
      setAddMoreTables(tablesResult.tables)
    } else {
      setAddMoreTables([])
      setAddMoreError(tablesResult.error ?? 'Could not retrieve table list.')
    }
    setAddMoreLoading(false)
  }

  const handleAddMoreImport = async () => {
    if (!existingConnection || !selectedDatasetId || addMoreSelected.length === 0) return
    setAddMoreLoading(true)
    setAddMoreError(null)
    const result = await resyncTables({
      connectionId: existingConnection.id,
      datasetId: selectedDatasetId,
      projectId,
      role: type,
      tableNames: addMoreSelected,
    })
    if (result.success) {
      const connResult = await getConnectionForDataset(selectedDatasetId)
      if (connResult.connection) setExistingConnection(connResult.connection)
      setConnectionView('connected')
      setAddMoreTables(null)
      setAddMoreSelected([])
      router.refresh()
    } else {
      setAddMoreError(result.error ?? 'Import failed.')
    }
    setAddMoreLoading(false)
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

      // Phase 1 — request signed upload slot. Tiny round-trip; bypasses
      // Vercel's 1 MB serverActions body limit.
      setUploadState({ status: 'requesting-slot', filename: file.name })
      const slot = await getCsvUploadSlot({
        projectId,
        datasetId: selectedDatasetId,
        role: type,
        tableName: selectedTableName,
        filename: file.name,
      })
      if (!slot.success) {
        setUploadState({
          status: 'error',
          filename: file.name,
          error: slot.error ?? 'Failed to start upload',
        })
        return
      }

      // Phase 2 — direct PUT to Supabase Storage. Any size; XHR progress
      // events drive the upload progress bar.
      setUploadState({
        status: 'uploading',
        filename: file.name,
        uploadedBytes: 0,
        totalBytes: file.size,
      })
      try {
        await uploadToSignedUrl(slot.signedUrl, file, {
          contentType: 'text/csv',
          onProgress: (e) => {
            setUploadState((prev) =>
              prev.status === 'uploading'
                ? { ...prev, uploadedBytes: e.loaded, totalBytes: e.total }
                : prev,
            )
          },
        })
      } catch (err) {
        setUploadState({
          status: 'error',
          filename: file.name,
          error: err instanceof Error ? err.message : 'Upload to storage failed',
        })
        return
      }

      // Phase 3 — client-side row count for cap validation + queue payload.
      // We Papa.parse the file in the browser to learn totalRows. This
      // is fast (in-memory; same parse the worker will do server-side
      // shortly) and avoids the worker hitting the row cap mid-pipeline
      // (where it's wasted work). The cap check inside queueIngestionJob
      // is the authoritative one, but checking client-side gives a
      // clean error before queueing.
      let totalRows = 0
      try {
        const text = await file.text()
        const parsed = Papa.parse<Record<string, string>>(text, {
          header: true,
          skipEmptyLines: true,
          dynamicTyping: false,
        })
        totalRows = parsed.data.length
        if (totalRows === 0) {
          setUploadState({
            status: 'error',
            filename: file.name,
            error: 'CSV has no data rows',
          })
          return
        }
      } catch (err) {
        setUploadState({
          status: 'error',
          filename: file.name,
          error: err instanceof Error ? err.message : 'Failed to parse CSV',
        })
        return
      }

      // Phase 4 — queue background ingestion job. Returns immediately
      // with jobId; worker picks up within ~60s via cron.
      const queueResult = await queueIngestionJob({
        projectId,
        datasetId: selectedDatasetId,
        role: type,
        tableName: selectedTableName,
        storagePath: slot.storagePath,
        totalRows,
      })
      if (!queueResult.success) {
        setUploadState({
          status: 'error',
          filename: file.name,
          error: queueResult.error ?? 'Failed to queue ingestion job',
        })
        return
      }

      // Phase 5 — queued state. The polling useEffect (below) takes
      // over from here, transitioning through processing → success.
      setUploadState({
        status: 'queued',
        filename: file.name,
        jobId: queueResult.jobId,
        totalRows,
      })
    },
    [projectId, type, selectedDatasetId, selectedTableName],
  )

  // ── Polling: drive the queued → processing → success/error transition
  // by reading the job's status from getIngestionJobStatus every 2s.
  // The worker (app/api/cron/process-ingestion-job) updates the
  // ingestion_jobs row's status + progress + completed_rows after each
  // 1K-row chunk. The cleanup function clears the interval on unmount
  // OR when status reaches a terminal state ('success' | 'error').
  useEffect(() => {
    if (
      uploadState.status !== 'queued' &&
      uploadState.status !== 'processing'
    ) {
      return
    }
    const jobId = uploadState.jobId
    if (!jobId) return

    let cancelled = false
    const intervalId = setInterval(async () => {
      if (cancelled) return
      const result = await getIngestionJobStatus(jobId)
      if (cancelled) return
      if (!result.success) {
        // Job not found (RLS rejected, or never existed). Treat as
        // error — user can retry. Note: not-found can also mean the
        // job was deleted by an external process, but we don't
        // currently support that path.
        setUploadState({
          status: 'error',
          filename: uploadState.filename,
          error: result.error ?? 'Failed to fetch job status',
        })
        return
      }
      const job = result.job
      if (job.status === 'completed') {
        // Refresh dataset tables so the new table appears in the
        // selector. Same pattern as the legacy success path.
        if (selectedDatasetId) {
          try {
            const freshTables = await getTablesForDataset(selectedDatasetId)
            if (cancelled) return
            setDatasets((prev) =>
              prev.map((d) =>
                d.id === selectedDatasetId ? { ...d, tables: freshTables } : d,
              ),
            )
            const uploadedTable = freshTables.find((t) => t.name === selectedTableName)
            if (uploadedTable) setSelectedTableId(uploadedTable.id)
          } catch {
            // non-fatal — refresh below will pick up the new table
          }
        }
        setUploadState({
          status: 'success',
          filename: uploadState.filename,
          rowCount: job.total_rows ?? undefined,
          // fieldCount is computed by the worker but not surfaced via
          // job snapshot today. The dataset-tables refresh above
          // populates the selector with the correct field count from
          // the freshly inserted fields rows; the success card just
          // shows row count.
        })
        router.refresh()
        return
      }
      if (job.status === 'failed') {
        setUploadState({
          status: 'error',
          filename: uploadState.filename,
          error: job.error ?? 'Background processing failed',
        })
        return
      }
      // 'pending' or 'processing'. Update progress if processing;
      // stay in 'queued' if pending (worker hasn't picked up yet).
      if (job.status === 'processing') {
        setUploadState((prev) =>
          prev.status === 'queued' || prev.status === 'processing'
            ? {
                ...prev,
                status: 'processing',
                workerProgress: job.progress,
                completedRows: job.completed_rows,
                totalRows: job.total_rows ?? prev.totalRows,
              }
            : prev,
        )
      }
    }, 2000)

    return () => {
      cancelled = true
      clearInterval(intervalId)
    }
  }, [
    uploadState.status,
    uploadState.jobId,
    uploadState.filename,
    selectedDatasetId,
    selectedTableName,
    router,
  ])

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
    <div className="space-y-5">

        {/* ── Method Selector ───────────────────────────────────────────── */}
        <div className="space-y-2">
          <Label htmlFor={`${type}-method`} className="text-[11px] font-medium text-settle-slate-500">Data ingestion method</Label>
          <Select
            value={method ?? ''}
            onValueChange={(val) => handleMethodChange(val === '' ? null : (val as IngestMethod))}
          >
            <SelectTrigger id={`${type}-method`} className="h-9 text-sm w-full">
              <SelectValue placeholder="Select method" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="csv">CSV Upload</SelectItem>
              <SelectItem value="ddl">DDL / Schema Upload</SelectItem>
              <SelectItem value="db">Database Connection</SelectItem>
            </SelectContent>
          </Select>
        </div>

        {/* No method selected */}
        {method === null && (
          <div className="text-center py-6 text-gray-400">
            <p className="text-sm">Select an ingestion method to continue</p>
          </div>
        )}

        {/* ── Database Connection ────────────────────────────────────────── */}
        {method === 'db' && isArchived && (
          <div className="rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800">
            Database connection was removed during archival. The imported table schemas are preserved below.
          </div>
        )}

        {method === 'db' && !isArchived && (
          <div className="space-y-4">

            {/* Loading skeleton */}
            {connectionView === 'loading' && (
              <div className="space-y-2 animate-pulse">
                <div className="h-4 w-32 bg-gray-200 rounded" />
                <div className="h-9 w-full bg-gray-100 rounded" />
                <div className="h-9 w-full bg-gray-100 rounded" />
              </div>
            )}

            {/* ── State A: No connection — DB type picker + form ──────────── */}
            {connectionView === 'form' && (
              <div className="space-y-4">
                {/* DB type picker */}
                <div className="space-y-2">
                  <p className="text-xs font-medium text-gray-500 uppercase tracking-wide">Database type</p>
                  <div className="flex gap-2">
                    {([
                      { id: 'postgresql', label: 'PostgreSQL' },
                      { id: 'mysql', label: 'MySQL' },
                      { id: 'mssql', label: 'MS SQL Server' },
                    ] as const).map((db) => (
                      <button
                        key={db.id}
                        onClick={() => handleDbTypeSelect(db.id)}
                        disabled={!canEdit}
                        className={`flex flex-col items-center justify-center gap-1.5 px-4 py-3 rounded-lg border-2 text-sm font-medium transition-colors flex-1 disabled:opacity-50 disabled:cursor-not-allowed ${
                          dbType === db.id
                            ? 'border-blue-600 bg-blue-50 text-blue-700'
                            : 'border-gray-200 bg-white text-gray-600 hover:border-gray-300 hover:bg-gray-50 cursor-pointer'
                        }`}
                      >
                        <Database className={`w-4 h-4 ${dbType === db.id ? 'text-blue-600' : 'text-gray-400'}`} />
                        <span className="text-xs">{db.label}</span>
                      </button>
                    ))}
                  </div>
                </div>

                {/* Connection form */}
                <div className="space-y-3">
                  {/* Host + Port */}
                  <div className="grid grid-cols-[1fr_100px] gap-3">
                    <div className="space-y-1">
                      <Label className="text-[11px] font-medium text-settle-slate-500">Host</Label>
                      <Input
                        placeholder="db.example.com"
                        value={dbHost}
                        onChange={(e) => setDbHost(e.target.value)}
                        disabled={connectionStatus === 'testing' || importing || !canEdit}
                      />
                    </div>
                    <div className="space-y-1">
                      <Label className="text-[11px] font-medium text-settle-slate-500">Port</Label>
                      <Input
                        type="number"
                        value={dbPort}
                        onChange={(e) => setDbPort(Number(e.target.value))}
                        disabled={connectionStatus === 'testing' || importing || !canEdit}
                      />
                    </div>
                  </div>

                  {/* Database name */}
                  <div className="space-y-1">
                    <Label className="text-[11px] font-medium text-settle-slate-500">Database Name</Label>
                    <Input
                      placeholder="my_database"
                      value={dbName}
                      onChange={(e) => setDbName(e.target.value)}
                      disabled={connectionStatus === 'testing' || importing || !canEdit}
                    />
                  </div>

                  {/* Username + Password */}
                  <div className="grid grid-cols-2 gap-3">
                    <div className="space-y-1">
                      <Label className="text-[11px] font-medium text-settle-slate-500">Username</Label>
                      <Input
                        placeholder="readonly_user"
                        value={dbUser}
                        onChange={(e) => setDbUser(e.target.value)}
                        disabled={connectionStatus === 'testing' || importing || !canEdit}
                      />
                    </div>
                    <div className="space-y-1">
                      <Label className="text-[11px] font-medium text-settle-slate-500">Password</Label>
                      <Input
                        type="password"
                        placeholder="••••••••"
                        value={dbPassword}
                        onChange={(e) => setDbPassword(e.target.value)}
                        disabled={connectionStatus === 'testing' || importing || !canEdit}
                      />
                    </div>
                  </div>

                  {/* SSL Mode (PostgreSQL) / Encryption options (MS SQL) */}
                  {dbType === 'mssql' ? (
                    <div className="space-y-2">
                      <Label className="text-[11px] font-medium text-settle-slate-500">Encryption</Label>
                      <div className="flex flex-col gap-2">
                        <label className="flex items-center gap-2 cursor-pointer">
                          <input
                            type="checkbox"
                            checked={dbEncrypt}
                            onChange={(e) => setDbEncrypt(e.target.checked)}
                            disabled={connectionStatus === 'testing' || importing || !canEdit}
                            className="w-4 h-4 rounded border-gray-300 text-blue-600 focus:ring-blue-500"
                          />
                          <span className="text-sm text-gray-700">Encrypt connection</span>
                          <span className="text-xs text-gray-400">(recommended)</span>
                        </label>
                        <label className="flex items-center gap-2 cursor-pointer">
                          <input
                            type="checkbox"
                            checked={dbTrustCert}
                            onChange={(e) => setDbTrustCert(e.target.checked)}
                            disabled={connectionStatus === 'testing' || importing || !dbEncrypt || !canEdit}
                            className="w-4 h-4 rounded border-gray-300 text-blue-600 focus:ring-blue-500"
                          />
                          <span className="text-sm text-gray-700">Trust server certificate</span>
                          <span className="text-xs text-gray-400">(for self-signed / Azure)</span>
                        </label>
                      </div>
                    </div>
                  ) : (
                    <div className="space-y-1">
                      <Label className="text-[11px] font-medium text-settle-slate-500">SSL Mode</Label>
                      <Select
                        value={dbSslMode}
                        onValueChange={setDbSslMode}
                        disabled={connectionStatus === 'testing' || importing || !canEdit}
                      >
                        <SelectTrigger className="h-9 text-sm w-full">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="require">require (recommended)</SelectItem>
                          <SelectItem value="disable">disable</SelectItem>
                          <SelectItem value="verify-ca">verify-ca</SelectItem>
                          <SelectItem value="verify-full">verify-full</SelectItem>
                        </SelectContent>
                      </Select>
                    </div>
                  )}

                  {/* Test Connection button */}
                  <div className="flex items-center gap-3">
                    <RoleTooltip allowed={canEdit} requiredRole="Editor">
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={handleTestConnection}
                        disabled={!dbHost || !dbName || !dbUser || !dbPassword || connectionStatus === 'testing' || importing || !canEdit}
                      >
                        {connectionStatus === 'testing' ? (
                          <span className="flex items-center gap-1.5">
                            <Loader2 className="w-3.5 h-3.5 animate-spin" />
                            Testing…
                          </span>
                        ) : (
                          'Test Connection'
                        )}
                      </Button>
                    </RoleTooltip>
                    {connectionStatus === 'success' && (
                      <span className="flex items-center gap-1.5 text-sm text-green-700 font-medium">
                        <CheckCircle2 className="w-4 h-4" />
                        Connected — {remoteTables?.length ?? 0} table{remoteTables?.length !== 1 ? 's' : ''} found
                      </span>
                    )}
                  </div>

                  {connectionStatus === 'error' && connectionError && (
                    <div className="flex items-start gap-2 rounded-md border border-red-200 bg-red-50 px-3 py-2.5 text-sm text-red-700">
                      <XCircle className="w-4 h-4 mt-0.5 flex-shrink-0" />
                      {connectionError}
                    </div>
                  )}
                  {!importing && connectionError && connectionStatus === 'success' && (
                    <div className="flex items-start gap-2 rounded-md border border-red-200 bg-red-50 px-3 py-2.5 text-sm text-red-700">
                      <XCircle className="w-4 h-4 mt-0.5 flex-shrink-0" />
                      {connectionError}
                    </div>
                  )}
                </div>

                {/* MS SQL schema picker — shown after successful connection when multiple schemas exist */}
                {dbType === 'mssql' && connectionStatus === 'success' && schemas.length > 1 && (
                  <div className="space-y-1">
                    <Label className="text-[11px] font-medium text-settle-slate-500">Schema</Label>
                    <Select value={dbSchema} onValueChange={handleSchemaChange}>
                      <SelectTrigger className="h-9 text-sm w-full">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {schemas.map((s) => (
                          <SelectItem key={s} value={s}>{s}</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                )}

                {/* Table selection */}
                {connectionStatus === 'success' && remoteTables && (
                  <div className="space-y-3 border-t border-gray-100 pt-4">
                    <div className="flex items-center justify-between">
                      <p className="text-sm font-medium text-gray-800">Select Tables to Import</p>
                      <div className="flex gap-3 text-xs text-blue-600">
                        <button onClick={() => setSelectedRemoteTables(remoteTables.map((t) => t.name))} className="hover:underline">
                          Select All
                        </button>
                        <button onClick={() => setSelectedRemoteTables([])} className="hover:underline">
                          Deselect All
                        </button>
                      </div>
                    </div>
                    {remoteTables.length === 0 ? (
                      <p className="text-sm text-gray-400 text-center py-4">
                        No tables found in schema &quot;{dbType === 'mssql' ? dbSchema : 'public'}&quot;.
                      </p>
                    ) : (
                      <div className="max-h-[280px] overflow-y-auto rounded-md border border-gray-200 divide-y divide-gray-100">
                        {remoteTables.map((table) => (
                          <label key={table.name} className="flex items-center gap-3 px-3 py-2.5 hover:bg-gray-50 cursor-pointer">
                            <input
                              type="checkbox"
                              checked={selectedRemoteTables.includes(table.name)}
                              onChange={(e) =>
                                setSelectedRemoteTables((prev) =>
                                  e.target.checked ? [...prev, table.name] : prev.filter((n) => n !== table.name)
                                )
                              }
                              className="w-4 h-4 rounded border-gray-300 text-blue-600 focus:ring-blue-500"
                            />
                            <span className="flex-1 text-sm font-mono text-gray-800">{table.name}</span>
                            <span className="text-xs text-gray-400 tabular-nums">~{table.estimatedRows.toLocaleString()} rows</span>
                            {table.estimatedRows > 1_000_000 && (
                              <span className="flex items-center gap-0.5 text-xs text-amber-600">
                                <AlertTriangle className="w-3 h-3" />
                                capped at 1M
                              </span>
                            )}
                          </label>
                        ))}
                      </div>
                    )}
                    <div className="flex items-center gap-3">
                      <RoleTooltip allowed={canEdit} requiredRole="Editor">
                        <Button
                          size="sm"
                          onClick={handleImport}
                          disabled={selectedRemoteTables.length === 0 || importing || !canEdit}
                          className="bg-primary hover:bg-primary/90 text-white disabled:opacity-50"
                        >
                          {importing ? (
                            <span className="flex items-center gap-1.5">
                              <Loader2 className="w-3.5 h-3.5 animate-spin" />
                              Importing…
                            </span>
                          ) : (
                            `Import Selected Tables (${selectedRemoteTables.length})`
                          )}
                        </Button>
                      </RoleTooltip>
                      {importing && importProgress && (
                        <span className="text-xs text-gray-500">{importProgress}</span>
                      )}
                    </div>
                  </div>
                )}
              </div>
            )}

            {/* ── State B: Connection exists — connected view ──────────────── */}
            {connectionView === 'connected' && existingConnection && (
              <div className="space-y-4">
                {/* Connection header */}
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <span className="inline-flex items-center px-2 py-0.5 rounded text-xs font-medium bg-blue-100 text-blue-700 uppercase tracking-wide">
                      {existingConnection.db_type === 'postgresql' ? 'PostgreSQL'
                        : existingConnection.db_type === 'mysql' ? 'MySQL'
                        : 'MS SQL Server'}
                    </span>
                    {existingConnection.status === 'connected' ? (
                      <span className="flex items-center gap-1 text-xs text-green-700">
                        <span className="w-1.5 h-1.5 rounded-full bg-green-500 inline-block" />
                        Connected
                      </span>
                    ) : (
                      <span className="flex items-center gap-1 text-xs text-red-600">
                        <span className="w-1.5 h-1.5 rounded-full bg-red-500 inline-block" />
                        {existingConnection.status === 'failed' ? 'Failed' : 'Disconnected'}
                      </span>
                    )}
                  </div>
                  {existingConnection.last_connected_at && (
                    <span className="text-xs text-gray-400">
                      Last synced {new Date(existingConnection.last_connected_at).toLocaleDateString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}
                    </span>
                  )}
                </div>

                {/* Connection details */}
                <div className="rounded-md border border-gray-200 bg-gray-50 px-4 py-3 grid grid-cols-2 gap-x-6 gap-y-2">
                  {[
                    ['Host', existingConnection.host],
                    ['Port', String(existingConnection.port)],
                    ['Database', existingConnection.database_name],
                    ['Username', existingConnection.username],
                    [
                      existingConnection.db_type === 'mssql' ? 'Encryption' : 'SSL Mode',
                      existingConnection.db_type === 'mssql'
                        ? (existingConnection.ssl_mode === 'disable' ? 'Off' : existingConnection.ssl_mode === 'verify-full' ? 'Encrypted (verify cert)' : 'Encrypted (trust cert)')
                        : existingConnection.ssl_mode,
                    ],
                    ['Password', '••••••••••'],
                  ].map(([label, value]) => (
                    <div key={label}>
                      <span className="text-xs text-slate-500">{label}</span>
                      <p className="text-sm font-medium text-slate-900 truncate">{value}</p>
                    </div>
                  ))}
                </div>

                {/* Imported tables */}
                <div className="space-y-2">
                  <p className="text-sm font-medium text-gray-800">
                    Imported Tables ({selectedDataset?.tables.length ?? 0})
                  </p>
                  {(selectedDataset?.tables.length ?? 0) === 0 ? (
                    <p className="text-xs text-gray-400 py-2">No tables imported yet.</p>
                  ) : (
                    <div className="rounded-md border border-gray-200 divide-y divide-gray-100">
                      {(selectedDataset?.tables ?? []).map((table) => (
                        <div key={table.id} className="flex items-center gap-3 px-3 py-2.5">
                          <span className="flex-1 text-sm font-mono font-medium text-gray-800">{table.name}</span>
                          <span className="text-xs text-gray-400 tabular-nums">{table.row_count.toLocaleString()} rows</span>
                          <span className="text-xs text-gray-400">{table.field_count} fields</span>
                          <button
                            onClick={() => handleResyncOne(table.name)}
                            disabled={resyncingTable === table.name || resyncingAll || !canEdit}
                            title={canEdit ? 'Re-sync this table' : 'Editor access required'}
                            className="p-1 rounded hover:bg-gray-100 text-gray-400 hover:text-gray-600 disabled:opacity-40 transition-colors"
                          >
                            {resyncingTable === table.name
                              ? <Loader2 className="w-3.5 h-3.5 animate-spin" />
                              : <RefreshCw className="w-3.5 h-3.5" />
                            }
                          </button>
                        </div>
                      ))}
                    </div>
                  )}
                </div>

                {/* Re-sync feedback */}
                {resyncMessage && (
                  <p className="text-xs text-gray-600 bg-gray-50 border border-gray-200 rounded px-3 py-2">{resyncMessage}</p>
                )}

                {/* Action row */}
                {!disconnectConfirm ? (
                  <div className="flex items-center gap-3 flex-wrap">
                    <RoleTooltip allowed={canEdit} requiredRole="Editor">
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={handleOpenAddMore}
                        disabled={resyncingAll || !canEdit}
                      >
                        Add More Tables
                      </Button>
                    </RoleTooltip>
                    <RoleTooltip allowed={canEdit} requiredRole="Editor">
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={handleResyncAll}
                        disabled={resyncingAll || (selectedDataset?.tables.length ?? 0) === 0 || !canEdit}
                      >
                      {resyncingAll ? (
                        <span className="flex items-center gap-1.5">
                          <Loader2 className="w-3.5 h-3.5 animate-spin" />
                          Re-syncing…
                        </span>
                      ) : (
                        'Re-sync All'
                      )}
                      </Button>
                    </RoleTooltip>
                    <RoleTooltip allowed={canEdit} requiredRole="Editor">
                      <button
                        onClick={canEdit ? () => setDisconnectConfirm(true) : undefined}
                        disabled={!canEdit}
                        className="text-xs text-red-600 hover:underline ml-auto disabled:opacity-40 disabled:cursor-not-allowed"
                      >
                        Disconnect
                      </button>
                    </RoleTooltip>
                  </div>
                ) : (
                  <div className="rounded-md border border-red-200 bg-red-50 px-4 py-3 space-y-2">
                    <p className="text-sm font-medium text-red-800">Disconnect and delete data?</p>
                    <p className="text-xs text-red-700">
                      This will remove the database connection and delete all imported tables, fields, and data rows
                      for this {type}. This cannot be undone.
                    </p>
                    <div className="flex gap-2 pt-1">
                      <Button
                        size="sm"
                        onClick={handleConfirmDisconnect}
                        disabled={disconnecting}
                        className="bg-red-600 hover:bg-red-700 text-white"
                      >
                        {disconnecting ? (
                          <span className="flex items-center gap-1.5"><Loader2 className="w-3.5 h-3.5 animate-spin" />Disconnecting…</span>
                        ) : (
                          'Disconnect & Delete Data'
                        )}
                      </Button>
                      <Button size="sm" variant="outline" onClick={() => setDisconnectConfirm(false)} disabled={disconnecting}>
                        Cancel
                      </Button>
                    </div>
                  </div>
                )}
              </div>
            )}

            {/* ── State C: Add more tables ──────────────────────────────────── */}
            {connectionView === 'adding' && existingConnection && (
              <div className="space-y-4">
                <div className="flex items-center justify-between">
                  <p className="text-sm font-medium text-gray-800">Add More Tables</p>
                  <button onClick={() => setConnectionView('connected')} className="text-xs text-gray-500 hover:underline">
                    ← Back
                  </button>
                </div>

                {addMoreLoading ? (
                  <div className="flex items-center gap-2 text-sm text-gray-500 py-4">
                    <Loader2 className="w-4 h-4 animate-spin" />
                    Loading available tables…
                  </div>
                ) : addMoreError ? (
                  <div className="flex items-start gap-2 rounded-md border border-red-200 bg-red-50 px-3 py-2.5 text-sm text-red-700">
                    <XCircle className="w-4 h-4 mt-0.5 flex-shrink-0" />
                    {addMoreError}
                  </div>
                ) : addMoreTables !== null ? (
                  <>
                    {addMoreTables.length === 0 ? (
                      <p className="text-sm text-gray-400 text-center py-4">No tables found in this database.</p>
                    ) : (
                      <>
                        <div className="flex justify-end gap-3 text-xs text-blue-600">
                          <button
                            onClick={() =>
                              setAddMoreSelected(
                                addMoreTables
                                  .filter((t) => !(selectedDataset?.tables ?? []).some((i) => i.name === t.name))
                                  .map((t) => t.name)
                              )
                            }
                            className="hover:underline"
                          >
                            Select New
                          </button>
                          <button onClick={() => setAddMoreSelected([])} className="hover:underline">
                            Deselect All
                          </button>
                        </div>
                        <div className="max-h-[280px] overflow-y-auto rounded-md border border-gray-200 divide-y divide-gray-100">
                          {addMoreTables.map((table) => {
                            const alreadyImported = (selectedDataset?.tables ?? []).some((t) => t.name === table.name)
                            return (
                              <label
                                key={table.name}
                                className={`flex items-center gap-3 px-3 py-2.5 ${alreadyImported ? 'opacity-50 cursor-not-allowed' : 'hover:bg-gray-50 cursor-pointer'}`}
                              >
                                <input
                                  type="checkbox"
                                  checked={alreadyImported || addMoreSelected.includes(table.name)}
                                  disabled={alreadyImported}
                                  onChange={(e) =>
                                    !alreadyImported && setAddMoreSelected((prev) =>
                                      e.target.checked ? [...prev, table.name] : prev.filter((n) => n !== table.name)
                                    )
                                  }
                                  className="w-4 h-4 rounded border-gray-300 text-blue-600 focus:ring-blue-500"
                                />
                                <span className="flex-1 text-sm font-mono text-gray-800">{table.name}</span>
                                {alreadyImported ? (
                                  <span className="text-xs text-gray-400 italic">already imported</span>
                                ) : (
                                  <span className="text-xs text-gray-400 tabular-nums">~{table.estimatedRows.toLocaleString()} rows</span>
                                )}
                              </label>
                            )
                          })}
                        </div>
                        {addMoreError && (
                          <div className="flex items-start gap-2 rounded-md border border-red-200 bg-red-50 px-3 py-2.5 text-sm text-red-700">
                            <XCircle className="w-4 h-4 mt-0.5 flex-shrink-0" />
                            {addMoreError}
                          </div>
                        )}
                        <div className="flex items-center gap-3">
                          <RoleTooltip allowed={canEdit} requiredRole="Editor">
                            <Button
                              size="sm"
                              onClick={handleAddMoreImport}
                              disabled={addMoreSelected.length === 0 || addMoreLoading || !canEdit}
                              className="bg-primary hover:bg-primary/90 text-white disabled:opacity-50"
                            >
                              {addMoreLoading ? (
                                <span className="flex items-center gap-1.5"><Loader2 className="w-3.5 h-3.5 animate-spin" />Importing…</span>
                              ) : (
                                `Import Selected (${addMoreSelected.length})`
                              )}
                            </Button>
                          </RoleTooltip>
                          <Button size="sm" variant="outline" onClick={() => setConnectionView('connected')}>
                            Cancel
                          </Button>
                        </div>
                      </>
                    )}
                  </>
                ) : null}
              </div>
            )}

          </div>
        )}

        {/* ── Shared: Dataset / Schema selector (CSV + DDL) ─────────────── */}
        {(method === 'csv' || method === 'ddl') && (
          <div className="space-y-2">
            <Label htmlFor={`${type}-dataset`} className="text-[11px] font-medium text-settle-slate-500">Database</Label>
            <Select
              value={selectedDatasetId ?? ''}
              onValueChange={(val) => handleDatasetSelect(val)}
            >
              <SelectTrigger id={`${type}-dataset`} className="h-9 text-sm w-full">
                <SelectValue placeholder="Select database" />
              </SelectTrigger>
              <SelectContent>
                {datasets.map((d) => (
                  <SelectItem key={d.id} value={d.id}>{d.name}</SelectItem>
                ))}
                <SelectItem value="new">+ Add new database</SelectItem>
              </SelectContent>
            </Select>

            {showNewDatasetInput && (
              <div className="flex gap-2">
                <Input
                  placeholder="Database name (e.g. SAP_S4HANA)"
                  value={newDatasetName}
                  onChange={(e) => setNewDatasetName(e.target.value)}
                  onKeyDown={(e) => e.key === 'Enter' && handleSaveNewDataset()}
                  autoFocus
                />
                <Button
                  size="sm"
                  onClick={handleSaveNewDataset}
                  disabled={!newDatasetName.trim() || creatingDataset}
                  className="bg-primary hover:bg-primary/90 text-white"
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
              <Label htmlFor={`${type}-table`} className="text-[11px] font-medium text-settle-slate-500">Table</Label>
              <Select
                value={selectedTableId ?? ''}
                onValueChange={(val) => handleTableSelect(val)}
              >
                <SelectTrigger id={`${type}-table`} className="h-9 text-sm w-full">
                  <SelectValue placeholder="Select table" />
                </SelectTrigger>
                <SelectContent>
                  {selectedDataset?.tables.map((t) => (
                    <SelectItem key={t.id} value={t.id}>
                      {t.name}{t.row_count > 0 ? ` (${t.row_count.toLocaleString()} rows)` : ''}
                    </SelectItem>
                  ))}
                  <SelectItem value="new">+ Add new table</SelectItem>
                </SelectContent>
              </Select>

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
                    className="bg-primary hover:bg-primary/90 text-white"
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
                    className={`border-[1.5px] border-dashed rounded-lg p-4 text-center transition-colors ${
                      isDragOver
                        ? 'border-blue-500 bg-blue-50'
                        : 'border-settle-slate-300 hover:border-settle-slate-400'
                    }`}
                  >
                    {uploadState.status === 'requesting-slot' && (
                      <div className="flex flex-col items-center justify-center h-full py-8">
                        <div className="flex items-center gap-2.5">
                          <div className="w-4 h-4 border-2 border-primary/30 border-t-primary rounded-full animate-spin flex-shrink-0" />
                          <span className="text-sm text-gray-700">Preparing upload for {uploadState.filename}...</span>
                        </div>
                      </div>
                    )}

                    {uploadState.status === 'uploading' && (
                      <div className="flex flex-col items-center justify-center h-full py-8 w-full">
                        <div className="flex items-center gap-2.5">
                          <div className="w-4 h-4 border-2 border-primary/30 border-t-primary rounded-full animate-spin flex-shrink-0" />
                          <span className="text-sm text-gray-700">Uploading {uploadState.filename}...</span>
                        </div>
                        {(() => {
                          const loaded = uploadState.uploadedBytes ?? 0
                          const total = uploadState.totalBytes ?? 0
                          const pct = total > 0 ? Math.min(100, Math.round((loaded / total) * 100)) : 0
                          const loadedMB = (loaded / (1024 * 1024)).toFixed(1)
                          const totalMB = (total / (1024 * 1024)).toFixed(1)
                          return (
                            <div className="ml-[26px] mt-1.5 w-full max-w-xs">
                              <div className="h-1.5 w-full bg-gray-200 rounded-full overflow-hidden">
                                <div
                                  className="h-full bg-primary transition-[width] duration-150 ease-out"
                                  style={{ width: `${pct}%` }}
                                  data-testid="csv-upload-progress-bar"
                                />
                              </div>
                              <p className="text-xs text-gray-400 mt-1">
                                {loadedMB} / {totalMB} MB ({pct}%)
                              </p>
                            </div>
                          )
                        })()}
                      </div>
                    )}

                    {uploadState.status === 'queued' && (
                      <div className="flex flex-col items-center justify-center h-full py-8">
                        <div className="flex items-center gap-2.5">
                          <div className="w-4 h-4 border-2 border-primary/30 border-t-primary rounded-full animate-spin flex-shrink-0" />
                          <span className="text-sm text-gray-700">Queued for processing... starting within 60s</span>
                        </div>
                        <p className="text-xs text-gray-400 mt-1.5 ml-[26px]">
                          Background worker picks up jobs once a minute
                        </p>
                      </div>
                    )}

                    {uploadState.status === 'processing' && (
                      <div className="flex flex-col items-center justify-center h-full py-8 w-full">
                        <div className="flex items-center gap-2.5">
                          <div className="w-4 h-4 border-2 border-primary/30 border-t-primary rounded-full animate-spin flex-shrink-0" />
                          <span className="text-sm text-gray-700">Processing {uploadState.filename}...</span>
                        </div>
                        {(() => {
                          const completed = uploadState.completedRows ?? 0
                          const total = uploadState.totalRows ?? 0
                          const pct = total > 0 ? Math.min(100, Math.round((completed / total) * 100)) : 0
                          return (
                            <div className="ml-[26px] mt-1.5 w-full max-w-xs">
                              <div className="h-1.5 w-full bg-gray-200 rounded-full overflow-hidden">
                                <div
                                  className="h-full bg-primary transition-[width] duration-300 ease-out"
                                  style={{ width: `${pct}%` }}
                                  data-testid="csv-processing-progress-bar"
                                />
                              </div>
                              <p className="text-xs text-gray-400 mt-1">
                                {completed.toLocaleString()} / {total.toLocaleString()} rows ({pct}%)
                              </p>
                            </div>
                          )
                        })()}
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
                        <Upload className="w-5 h-5 text-settle-slate-400 mx-auto" />
                        <div>
                          <p className="text-xs font-medium text-settle-slate-600">
                            {isDragOver
                              ? 'Drop file here'
                              : tableHasData
                              ? 'Drop CSV to re-upload'
                              : 'Drop CSV here or click to select'}
                          </p>
                          <p className="text-[10px] text-settle-slate-400 mt-1">
                            One CSV per table · Max 250MB · Up to 1,000,000 rows
                          </p>
                        </div>
                        <RoleTooltip allowed={canEdit} requiredRole="Editor">
                          <Button
                            variant="outline"
                            size="sm"
                            type="button"
                            onClick={() => fileInputRef.current?.click()}
                            disabled={!canEdit}
                          >
                            Select File
                          </Button>
                        </RoleTooltip>
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
                className={`border-[1.5px] border-dashed rounded-lg p-4 text-center transition-colors ${
                  ddl.isDragOver
                    ? 'border-blue-500 bg-blue-50'
                    : 'border-settle-slate-300 hover:border-settle-slate-400'
                }`}
              >
                {ddl.parsing ? (
                  <div className="flex flex-col items-center justify-center py-8">
                    <div className="flex items-center gap-2.5">
                      <div className="w-4 h-4 border-2 border-primary/30 border-t-primary rounded-full animate-spin flex-shrink-0" />
                      <span className="text-sm text-gray-700">Parsing {ddl.filename ?? 'file'}...</span>
                    </div>
                    <p className="text-xs text-gray-400 mt-1.5 ml-[26px]">
                      Extracting tables and fields · this may take a moment
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
                    <Upload className="w-5 h-5 text-settle-slate-400 mx-auto" />
                    <div>
                      <p className="text-xs font-medium text-settle-slate-600">
                        {ddl.isDragOver
                          ? 'Drop DDL file here'
                          : 'Drop DDL / SQL file here or click to select'}
                      </p>
                      <p className="text-[10px] text-settle-slate-400 mt-1">
                        Accepted: .sql, .ddl, .txt · Max 2 MB
                      </p>
                      <p className="text-[10px] text-settle-slate-400 mt-0.5">
                        Supports standard SQL, SQL Server, Oracle, SAP HANA, MySQL, PostgreSQL
                      </p>
                    </div>
                    <RoleTooltip allowed={canEdit} requiredRole="Editor">
                      <Button
                        variant="outline"
                        size="sm"
                        type="button"
                        onClick={() => ddlFileInputRef.current?.click()}
                        disabled={!canEdit}
                      >
                        Select File
                      </Button>
                    </RoleTooltip>
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

    </div>
  )
}
