'use client'

import { useState, useTransition, useCallback } from 'react'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import {
  CheckCircle2,
  AlertCircle,
  ChevronDown,
  ChevronRight,
  Download,
  RefreshCw,
  ArrowRight,
  Zap,
  Sparkles,
  FileText,
} from '@/components/icons'
import { Link2, Code, ShieldCheck, Database, Settings, Copy, Check, Package, PackageOpen, Eye, EyeOff, ClipboardCheck, BarChart2, GitMerge, Code2, Clock, BookOpen, FileText as FileTextLucide, Info, AlertTriangle } from 'lucide-react'
import { Checkbox } from '@/components/ui/checkbox'
import { PageHeader } from '@/components/app/PageHeader'
import {
  generateGoldStandardCSVs,
  generateSQLLoadScripts,
  generateReadinessReport,
  generateMappingFile,
  generateTransformSpecs,
  generateFixLog,
  generateDataDictionary,
} from '@/lib/actions/outputs'
import type { OutputsPageData, GeneratedFile, ExistingOutput } from '@/lib/actions/outputs'
import {
  generateExecutionPackage,
  generateExecutionPackageWithFormat,
  getExecutionPackageUrl,
  getCompartmentalizedPackageUrls,
} from '@/lib/actions/execution-package'
import type { CompartmentalizedFile } from '@/lib/actions/execution-package'
import { generateMigrationRunbook } from '@/lib/actions/migration-runbook'
import { getDeliverableUrl, type DeliverableKey } from '@/lib/actions/deliverables'
import { SQL_DIALECTS } from '@/lib/types/database'
import type { SqlDialect, ExecutionPackageFormat } from '@/lib/types/database'
import { useProjectRole } from '@/lib/hooks/useProjectRole'
import { RoleTooltip } from '@/components/app/RoleTooltip'
import { SourceCoverageWidget } from '@/components/app/SourceCoverageWidget'
import type { ProjectStats } from '@/lib/quality/project-stats'

// ── Types ─────────────────────────────────────────────────────────────────────

interface Props {
  projectId: string
  projectName: string
  initialData: OutputsPageData
  isArchived?: boolean
  targetDbType?: SqlDialect
}

interface DeliverableState {
  downloadUrl: string
  version: string
  generatedAt: string
}

interface ExecutionPackageState {
  status: 'idle' | 'generating' | 'generated' | 'error'
  sqlContent: string | null
  signedUrl: string | null
  version: string | null
  generatedAt: string | null
  error: string | null
  dialect: SqlDialect | null
}

interface CompartmentalizedFileState extends CompartmentalizedFile {
  signedUrl: string | null
}

interface CompartmentalizedPackageState {
  status: 'idle' | 'generating' | 'generated' | 'error'
  files: CompartmentalizedFileState[]
  zipStoragePath: string | null
  zipSignedUrl: string | null
  version: string | null
  generatedAt: string | null
  error: string | null
  dialect: SqlDialect | null
}

type ToastState = { message: string; type: 'success' | 'error' }

// ── Color helpers ─────────────────────────────────────────────────────────────

function phaseColor(color: string) {
  switch (color) {
    case 'green': return { bg: 'bg-green-500', text: 'text-green-700', badge: 'bg-green-100 text-green-700 border-green-200' }
    case 'yellow': return { bg: 'bg-yellow-400', text: 'text-yellow-700', badge: 'bg-yellow-100 text-yellow-700 border-yellow-200' }
    case 'red': return { bg: 'bg-red-500', text: 'text-red-700', badge: 'bg-red-100 text-red-700 border-red-200' }
    default: return { bg: 'bg-gray-300', text: 'text-gray-500', badge: 'bg-gray-100 text-gray-500 border-gray-100' }
  }
}

function readinessColor(status: string) {
  if (status === 'ready') return 'text-green-600'
  if (status === 'at_risk') return 'text-yellow-600'
  return 'text-red-600'
}

function readinessBg(status: string) {
  if (status === 'ready') return 'bg-green-50 border-green-200'
  if (status === 'at_risk') return 'bg-yellow-50 border-yellow-200'
  return 'bg-red-50 border-red-200'
}

function decisionIcon(type: string) {
  switch (type) {
    case 'mapping': return '→'
    case 'fix': return '✓'
    case 'risk': return '⚠'
    case 'transform': return '<>'
    case 'rule': return '⊕'
    default: return '•'
  }
}

function decisionDotColor(type: string) {
  switch (type) {
    case 'fix': return 'bg-green-500'
    case 'mapping': return 'bg-primary'
    case 'transform': return 'bg-purple-500'
    case 'validation': return 'bg-amber-500'
    case 'data': return 'bg-primary'
    case 'system': return 'bg-gray-500'
    default: return 'bg-gray-400'
  }
}

function DecisionIcon({ type }: { type: string }) {
  switch (type) {
    case 'mapping':
      return <Link2 className="w-3.5 h-3.5 text-blue-500 flex-shrink-0 mt-0.5" />
    case 'transform':
      return <Code className="w-3.5 h-3.5 text-purple-500 flex-shrink-0 mt-0.5" />
    case 'fix':
    case 'validation':
      return <ShieldCheck className="w-3.5 h-3.5 text-green-500 flex-shrink-0 mt-0.5" />
    case 'data':
      return <Database className="w-3.5 h-3.5 text-blue-500 flex-shrink-0 mt-0.5" />
    case 'system':
      return <Settings className="w-3.5 h-3.5 text-gray-400 flex-shrink-0 mt-0.5" />
    default:
      return <span className="w-2 h-2 rounded-full mt-1.5 flex-shrink-0 bg-gray-400" />
  }
}

function fmtDate(iso: string) {
  try {
    return new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
  } catch {
    return iso
  }
}

function fmtDateTime(iso: string) {
  try {
    return new Date(iso).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })
  } catch {
    return iso
  }
}

// Per-deliverable metadata used by the download pipeline:
//  - `ext`       drives the filename extension
//  - `mimeType`  hints the browser Blob MIME for named downloads
//  - `basename`  is used when constructing the saved filename so the user
//                sees a self-describing file on disk (e.g. migration_runbook_v1.docx).
// Keys match the UI deliverable keys (e.g. 'runbook_docx', 'mapping_csv').
const DELIVERABLE_META: Record<string, { ext: string; mimeType: string; basename: string }> = {
  runbook_docx:      { ext: 'docx', mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', basename: 'migration_runbook' },
  readiness_report:  { ext: 'docx', mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', basename: 'readiness_report' },
  mapping_csv:       { ext: 'csv',  mimeType: 'text/csv',                                                                basename: 'mapping_file' },
  mapping_json:      { ext: 'json', mimeType: 'application/json',                                                        basename: 'mapping_file' },
  transform_specs:   { ext: 'sql',  mimeType: 'application/sql',                                                         basename: 'transformation_specs' },
  fix_log:           { ext: 'csv',  mimeType: 'text/csv',                                                                basename: 'fix_log' },
  data_dictionary:   { ext: 'csv',  mimeType: 'text/csv',                                                                basename: 'data_dictionary' },
}

function buildDeliverableFilename(key: string, version: string | undefined): string {
  const meta = DELIVERABLE_META[key]
  if (!meta) return `deliverable_v${version ?? '1'}`
  return `${meta.basename}_v${version ?? '1'}.${meta.ext}`
}

// Attempts a blob-based download of a signed URL. Returns `true` when the
// file was fetched successfully and the browser was cued to save it.
// Non-throwing: any fetch failure (HTTP error, network, CORS, expired URL)
// resolves to `false` so the caller can advance to a fallback strategy.
async function tryDownloadFromUrl(
  url: string,
  filename: string,
  mimeType: string | undefined
): Promise<boolean> {
  try {
    const response = await fetch(url)
    if (!response.ok) return false
    const raw = await response.blob()
    const blob = mimeType ? new Blob([raw], { type: mimeType }) : raw
    const objectUrl = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = objectUrl
    a.download = filename
    document.body.appendChild(a)
    a.click()
    document.body.removeChild(a)
    URL.revokeObjectURL(objectUrl)
    return true
  } catch {
    return false
  }
}

// Relative "time ago" with graceful absolute fallback past 24h.
// Keeps the UI honest about staleness without requiring a date-fns dependency.
function timeAgo(iso: string) {
  try {
    const then = new Date(iso).getTime()
    if (Number.isNaN(then)) return iso
    const diffMs = Date.now() - then
    if (diffMs < 0) return 'just now'
    const sec = Math.floor(diffMs / 1000)
    if (sec < 45) return 'just now'
    const min = Math.floor(sec / 60)
    if (min < 60) return `${min}m ago`
    const hr = Math.floor(min / 60)
    if (hr < 24) return `${hr}h ago`
    return fmtDateTime(iso)
  } catch {
    return iso
  }
}

// ── OutputsContent ────────────────────────────────────────────────────────────

// RoleTooltip is imported from @/components/app/RoleTooltip

export default function OutputsContent({ projectId, projectName, initialData, isArchived = false, targetDbType = 'postgresql' }: Props) {
  const { can: canRole } = useProjectRole(projectId)
  const canEdit = canRole('edit')
  const [data] = useState<OutputsPageData>(initialData)

  // SQL dialect selector — default to the most recently generated dialect, then target DB type
  const [sqlDialect, setSqlDialect] = useState<SqlDialect>(() => {
    const existing = initialData.existingOutputs.find(
      (o) => o.type === 'execution_package'
    )
    if (existing?.dialect) return existing.dialect as SqlDialect
    return targetDbType
  })

  // Gold standard
  const [goldFormat, setGoldFormat] = useState<'csv' | 'sql'>('csv')
  const [goldFiles, setGoldFiles] = useState<GeneratedFile[]>([])
  const [isGeneratingGold, startGeneratingGold] = useTransition()
  const [goldProgress, setGoldProgress] = useState<string | null>(null)

  // Deliverables: keyed by `type_format`
  const [deliverableMap, setDeliverableMap] = useState<Record<string, DeliverableState>>(
    () => buildInitialDeliverableMap(initialData.existingOutputs)
  )
  // Tracks which deliverable(s) are currently generating. A `Set` (rather
  // than a single string) lets the Mapping row kick off CSV and JSON
  // generations concurrently without the UI conflating the two spinners.
  const [generatingKeys, setGeneratingKeys] = useState<Set<string>>(() => new Set())
  // Tracks which deliverable is currently being downloaded so the row can
  // show a spinner during the blob fetch and prevent double-clicks on slow links.
  const [downloadingKey, setDownloadingKey] = useState<string | null>(null)
  // Per-deliverable generation error, surfaced inline in the row so the
  // message persists even after the transient toast fades. Cleared on
  // successful retry.
  const [errorMap, setErrorMap] = useState<Record<string, string>>({})
  const [allGenProgress, setAllGenProgress] = useState<string | null>(null)

  // Output format: 'single_file' (monolithic) | 'per_table' (compartmentalized)
  const [outputFormat, setOutputFormat] = useState<ExecutionPackageFormat>(() => {
    const existing = initialData.existingOutputs.find((o) => o.type === 'execution_package')
    return existing?.format === 'single_file' ? 'single_file' : 'per_table'
  })

  // Execution package — single-file mode
  const [executionPackage, setExecutionPackage] = useState<ExecutionPackageState>(() => {
    const existing = initialData.existingOutputs.find(
      (o) => o.type === 'execution_package' && o.format !== 'per_table'
    )
    if (existing) {
      return {
        status: 'generated',
        sqlContent: null,
        signedUrl: existing.signedUrl,
        version: existing.version,
        generatedAt: existing.generated_at,
        error: null,
        dialect: (existing.dialect as SqlDialect | null) ?? null,
      }
    }
    return { status: 'idle', sqlContent: null, signedUrl: null, version: null, generatedAt: null, error: null, dialect: null }
  })

  // Execution package — per-table mode
  const emptyCompartmentalized: CompartmentalizedPackageState = {
    status: 'idle', files: [], zipStoragePath: null, zipSignedUrl: null,
    version: null, generatedAt: null, error: null, dialect: null,
  }
  const [compartmentalized, setCompartmentalized] = useState<CompartmentalizedPackageState>(() => {
    const existing = initialData.existingOutputs.find(
      (o) => o.type === 'execution_package' && o.format === 'per_table'
    )
    if (existing) {
      // File list was reconstructed server-side from the metadata JSONB column
      // to avoid passing raw JSONB through RSC serialization.
      const files: CompartmentalizedFileState[] = (existing.reconstructedFiles ?? []).map((f) => ({
        filename: f.filename,
        type: f.type as CompartmentalizedFile['type'],
        content: '',
        table_name: f.tableName ?? undefined,
        load_order: f.loadOrder ?? undefined,
        dependencies: undefined,
        storagePath: f.storagePath ?? '',
        signedUrl: null,
      }))
      return {
        status: 'generated',
        files,
        zipStoragePath: existing.file_storage_path,
        zipSignedUrl: existing.signedUrl,
        version: existing.version,
        generatedAt: existing.generated_at,
        error: null,
        dialect: (existing.dialect as SqlDialect | null) ?? null,
      }
    }
    return emptyCompartmentalized
  })

  // Per-table preview: which filename is expanded
  const [previewFilename, setPreviewFilename] = useState<string | null>(null)
  // Per-table file content cache: filename → content string
  const [fileContentCache, setFileContentCache] = useState<Record<string, string>>({})
  const [previewLoading, setPreviewLoading] = useState(false)
  // Copy-to-clipboard confirmation
  const [copied, setCopied] = useState(false)
  // Selected files for selective ZIP download
  const [selectedFiles, setSelectedFiles] = useState<Set<string>>(new Set())
  // Selective download is in progress
  const [selectiveDownloading, setSelectiveDownloading] = useState(false)
  // Per-table file list collapse/expand
  const [fileListExpanded, setFileListExpanded] = useState(false)
  const VISIBLE_FILE_COUNT = 4

  // Decisions log drawer
  const [showDecisionsDrawer, setShowDecisionsDrawer] = useState(false)
  const [decisionsTypeFilter, setDecisionsTypeFilter] = useState<string>('all')

  // Toast
  const [toast, setToast] = useState<ToastState | null>(null)

  function showToast(message: string, type: ToastState['type']) {
    setToast({ message, type })
    setTimeout(() => setToast(null), 4000)
  }

  // ── Gold standard handlers ──────────────────────────────────────────────

  function handleGenerateGold() {
    setGoldProgress('Building transformation queries…')
    startGeneratingGold(async () => {
      const result = goldFormat === 'csv'
        ? await generateGoldStandardCSVs(projectId)
        : await generateSQLLoadScripts(projectId)
      setGoldProgress(null)
      if (!result.success) {
        const msg =
          result.error ??
          (result.errors?.length ? result.errors.join('; ') : 'Generation failed')
        showToast(msg, 'error')
        return
      }
      if (result.files.length === 0) { showToast('No files generated — check that mappings are approved.', 'error'); return }
      setGoldFiles(result.files)
      if (result.errors?.length) showToast(`Generated ${result.files.length} file(s) with ${result.errors.length} error(s).`, 'error')
      else showToast(`Generated ${result.files.length} Gold Standard file${result.files.length !== 1 ? 's' : ''}`, 'success')
    })
  }

  // ── Execution package handlers ──────────────────────────────────────────

  async function handleGenerateExecutionPackage(): Promise<boolean> {
    if (outputFormat === 'per_table') {
      // ── Compartmentalized path ──────────────────────────────────────────
      setCompartmentalized((prev) => ({ ...prev, status: 'generating', error: null }))
      try {
        console.log('[UI] sqlDialect:', sqlDialect, 'outputFormat:', outputFormat)
        const result = await generateExecutionPackageWithFormat(projectId, sqlDialect, 'per_table')
        if (result.success && 'files' in result) {
          setCompartmentalized({
            status: 'generated',
            files: result.files.map((f) => ({ ...f, signedUrl: null })),
            zipStoragePath: result.zipStoragePath,
            zipSignedUrl: null,
            version: result.version,
            generatedAt: new Date().toISOString(),
            error: null,
            dialect: result.dialect,
          })
          setSelectedFiles(new Set())
          setFileContentCache({})
          setPreviewFilename(null)
          showToast(`Generated ${result.files.length} script files`, 'success')
          return true
        }
        const errMsg = 'error' in result ? (result.error ?? 'Generation failed') : 'Generation failed'
        setCompartmentalized((prev) => ({ ...prev, status: 'error', error: errMsg }))
        showToast(errMsg, 'error')
        return false
      } catch {
        setCompartmentalized((prev) => ({ ...prev, status: 'error', error: 'An unexpected error occurred. Please try again.' }))
        showToast('An unexpected error occurred', 'error')
        return false
      }
    }

    // ── Single-file path (unchanged) ─────────────────────────────────────
    setExecutionPackage((prev) => ({ ...prev, status: 'generating', error: null }))
    try {
      const result = await generateExecutionPackage(projectId, sqlDialect)
      if (result.success) {
        setExecutionPackage({
          status: 'generated',
          sqlContent: result.sqlContent,
          signedUrl: null,
          version: result.version,
          generatedAt: new Date().toISOString(),
          error: null,
          dialect: result.dialect,
        })
        showToast('Execution package generated successfully', 'success')
        return true
      }
      setExecutionPackage((prev) => ({
        ...prev,
        status: 'error',
        error: result.error ?? 'Failed to generate execution package',
      }))
      showToast(result.error ?? 'Generation failed', 'error')
      return false
    } catch {
      setExecutionPackage((prev) => ({
        ...prev,
        status: 'error',
        error: 'An unexpected error occurred. Please try again.',
      }))
      showToast('An unexpected error occurred', 'error')
      return false
    }
  }

  function buildDownloadFilename() {
    const dialectSuffix = executionPackage.dialect ?? sqlDialect
    return `migration_execution_package_v${executionPackage.version ?? '1.0'}_${dialectSuffix}.sql`
  }

  async function handleDownloadExecutionPackage() {
    if (executionPackage.sqlContent) {
      const blob = new Blob([executionPackage.sqlContent], { type: 'application/sql' })
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = buildDownloadFilename()
      document.body.appendChild(a)
      a.click()
      document.body.removeChild(a)
      URL.revokeObjectURL(url)
      return
    }
    const result = await getExecutionPackageUrl(projectId)
    if (result.url) {
      try {
        const response = await fetch(result.url)
        const blob = await response.blob()
        const downloadUrl = URL.createObjectURL(blob)
        const a = document.createElement('a')
        a.href = downloadUrl
        a.download = buildDownloadFilename()
        document.body.appendChild(a)
        a.click()
        document.body.removeChild(a)
        URL.revokeObjectURL(downloadUrl)
      } catch {
        window.open(result.url, '_blank')
      }
    } else {
      showToast(result.error ?? 'Could not generate download link. Please try regenerating.', 'error')
    }
  }

  // ── Compartmentalized download handlers ─────────────────────────────────

  async function safeGetPackageUrls() {
    if (typeof getCompartmentalizedPackageUrls !== 'function') {
      console.error('[OutputsContent] getCompartmentalizedPackageUrls is not available — server action reference lost after hydration')
      return { error: 'Server action unavailable. Please reload the page.' } as Awaited<ReturnType<typeof getCompartmentalizedPackageUrls>>
    }
    return getCompartmentalizedPackageUrls(projectId)
  }

  async function resolveZipUrl(): Promise<{ url: string | null; error?: string }> {
    if (compartmentalized.zipSignedUrl) return { url: compartmentalized.zipSignedUrl }
    const result = await safeGetPackageUrls()
    if (result.error && !result.zipUrl) {
      return { url: null, error: result.error }
    }
    if (result.zipUrl) {
      setCompartmentalized((prev) => ({ ...prev, zipSignedUrl: result.zipUrl! }))
      if (result.files && result.files.length > 0) {
        setCompartmentalized((prev) => ({
          ...prev,
          files: prev.files.length === 0
            // No files in state (metadata init may have had no storage_path) — construct from result
            ? result.files!.map((rf) => ({
                filename: rf.filename,
                type: rf.type as CompartmentalizedFile['type'],
                content: '',
                table_name: rf.table_name,
                storagePath: '',
                signedUrl: rf.url,
              }))
            // Files already in state — just merge in the signed URLs
            : prev.files.map((f) => {
                const found = result.files!.find((rf) => rf.filename === f.filename)
                return found ? { ...f, signedUrl: found.url } : f
              }),
        }))
      }
      return { url: result.zipUrl }
    }
    return { url: null, error: result.error }
  }

  async function handleDownloadZip() {
    const { url, error } = await resolveZipUrl()
    if (!url) { showToast(error ?? 'Could not generate download link.', 'error'); return }
    const dialectSuffix = compartmentalized.dialect ?? sqlDialect
    const filename = `${projectName.replace(/\s+/g, '_')}_migration_scripts_v${compartmentalized.version ?? '1.0'}_${dialectSuffix}.zip`
    try {
      const response = await fetch(url)
      const blob = await response.blob()
      const dlUrl = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = dlUrl
      a.download = filename
      document.body.appendChild(a)
      a.click()
      document.body.removeChild(a)
      URL.revokeObjectURL(dlUrl)
    } catch {
      window.open(url, '_blank')
    }
  }

  async function handleDownloadFile(file: CompartmentalizedFileState) {
    // In-memory content available (just generated)
    if (file.content) {
      const blob = new Blob([file.content], { type: 'text/plain' })
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = file.filename
      document.body.appendChild(a)
      a.click()
      document.body.removeChild(a)
      URL.revokeObjectURL(url)
      return
    }
    // Use signed URL (after page refresh)
    let url = file.signedUrl
    if (!url) {
      const result = await safeGetPackageUrls()
      if (result.error) {
        showToast(result.error, 'error')
        return
      }
      const found = result.files?.find((rf) => rf.filename === file.filename)
      url = found?.url ?? null
      if (url) {
        setCompartmentalized((prev) => ({
          ...prev,
          files: prev.files.map((f) => f.filename === file.filename ? { ...f, signedUrl: url! } : f),
        }))
      }
    }
    if (url) {
      try {
        const response = await fetch(url)
        const blob = await response.blob()
        const dlUrl = URL.createObjectURL(blob)
        const a = document.createElement('a')
        a.href = dlUrl
        a.download = file.filename
        document.body.appendChild(a)
        a.click()
        document.body.removeChild(a)
        URL.revokeObjectURL(dlUrl)
      } catch {
        window.open(url, '_blank')
      }
    } else {
      showToast('Could not generate download link.', 'error')
    }
  }

  async function handleDownloadSelected() {
    if (selectedFiles.size === 0) return
    setSelectiveDownloading(true)
    try {
      const JSZip = (await import('jszip')).default
      const zip = new JSZip()
      for (const filename of selectedFiles) {
        const file = compartmentalized.files.find((f) => f.filename === filename)
        if (!file) continue
        let content = file.content
        if (!content) {
          // Fetch from signed URL
          let url = file.signedUrl
          if (!url) {
            const result = await safeGetPackageUrls()
            if (result.error) {
              showToast(result.error, 'error')
              return
            }
            url = result.files?.find((rf) => rf.filename === filename)?.url ?? null
          }
          if (url) {
            const response = await fetch(url)
            content = await response.text()
          }
        }
        if (content) zip.file(filename, content)
      }
      const dialectSuffix = compartmentalized.dialect ?? sqlDialect
      const zipBuffer = await zip.generateAsync({ type: 'blob' })
      const dlUrl = URL.createObjectURL(zipBuffer)
      const a = document.createElement('a')
      a.href = dlUrl
      a.download = `selected_scripts_${dialectSuffix}.zip`
      document.body.appendChild(a)
      a.click()
      document.body.removeChild(a)
      URL.revokeObjectURL(dlUrl)
    } catch {
      showToast('Could not create ZIP for selected files.', 'error')
    } finally {
      setSelectiveDownloading(false)
    }
  }

  async function handlePreviewFile(filename: string) {
    // Toggle: clicking the same file closes it
    if (previewFilename === filename) {
      setPreviewLoading(false)
      setPreviewFilename(null)
      // After React removes the preview panel, the page height shrinks but
      // the scroll position stays — creating whitespace at the bottom.
      // Scroll the closed row back into view to correct the scroll offset.
      requestAnimationFrame(() => {
        const row = document.querySelector(`[data-filename="${filename}"]`)
        if (row) {
          row.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
        }
      })
      return
    }
    setPreviewFilename(filename)
    // Return early if already cached
    if (fileContentCache[filename]) return

    // Check in-memory content first
    const file = compartmentalized.files.find((f) => f.filename === filename)
    if (file?.content) {
      setFileContentCache((prev) => ({ ...prev, [filename]: file.content }))
      return
    }

    // Fetch from signed URL
    setPreviewLoading(true)
    try {
      let url = file?.signedUrl ?? null
      if (!url) {
        const result = await safeGetPackageUrls()
        if (result.error) {
          showToast(result.error, 'error')
          return
        }
        const found = result.files?.find((rf) => rf.filename === filename)
        url = found?.url ?? null
        if (url && file) {
          setCompartmentalized((prev) => ({
            ...prev,
            files: prev.files.map((f) => f.filename === filename ? { ...f, signedUrl: url! } : f),
          }))
        }
      }
      if (url) {
        const response = await fetch(url)
        const text = await response.text()
        setFileContentCache((prev) => ({ ...prev, [filename]: text }))
      } else {
        showToast('Could not load file content.', 'error')
      }
    } finally {
      setPreviewLoading(false)
    }
  }

  async function handleCopyToClipboard(content: string) {
    try {
      await navigator.clipboard.writeText(content)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch {
      showToast('Could not copy to clipboard', 'error')
    }
  }

  // ── Deliverable handler ─────────────────────────────────────────────────

  const handleGenerateDeliverable = useCallback(
    async (key: string): Promise<boolean> => {
      setGeneratingKeys((prev) => {
        const next = new Set(prev)
        next.add(key)
        return next
      })
      // Clear any prior error for this key as soon as a retry starts —
      // prevents stale red banners from lingering during a new attempt.
      setErrorMap((prev) => {
        if (!(key in prev)) return prev
        const { [key]: _removed, ...rest } = prev
        return rest
      })

      const [type, format] = key.split('_') as [string, string]

      let result: { success: boolean; downloadUrl?: string; version?: string; error?: string }

      try {
        if (type === 'runbook' && format === 'docx') {
          result = await generateMigrationRunbook(projectId)
        } else if (type === 'readiness' && format === 'report') {
          result = await generateReadinessReport(projectId, 'docx')
        } else if (type === 'mapping' && format === 'csv') {
          result = await generateMappingFile(projectId, 'csv')
        } else if (type === 'mapping' && format === 'json') {
          result = await generateMappingFile(projectId, 'json')
        } else if (type === 'transform' && format === 'specs') {
          result = await generateTransformSpecs(projectId, 'sql')
        } else if (type === 'fix' && format === 'log') {
          result = await generateFixLog(projectId, 'csv')
        } else if (type === 'data' && format === 'dictionary') {
          result = await generateDataDictionary(projectId, 'csv')
        } else {
          result = { success: false, error: 'Unknown deliverable type' }
        }
      } catch (err) {
        result = { success: false, error: String(err) }
      }

      setGeneratingKeys((prev) => {
        if (!prev.has(key)) return prev
        const next = new Set(prev)
        next.delete(key)
        return next
      })

      if (!result.success || !result.downloadUrl) {
        const message = result.error ?? 'Generation failed'
        setErrorMap((prev) => ({ ...prev, [key]: message }))
        showToast(message, 'error')
        return false
      }
      setDeliverableMap((prev) => ({
        ...prev,
        [key]: { downloadUrl: result.downloadUrl!, version: result.version ?? '1.0', generatedAt: new Date().toISOString() },
      }))
      showToast('Generated successfully', 'success')
      return true
    },
    [projectId]
  )

  // ── Deliverable download ────────────────────────────────────────────────
  // Downloads a previously generated deliverable as a blob with a descriptive
  // filename. Uses a three-tier strategy so that downloads remain durable
  // even when cached signed URLs have expired:
  //   1. Cached URL (fresh-from-generation or SSR-hydrated)
  //   2. Server-side refresh via `getDeliverableUrl` (mints a new 1h URL)
  //   3. Open-in-new-tab fallback so the user always has a path to the file
  // The `downloadingKey` state prevents double-clicks and drives the row's
  // download spinner.
  const handleDownloadDeliverable = useCallback(
    async (key: string): Promise<void> => {
      const meta = DELIVERABLE_META[key]
      const state = deliverableMap[key]
      const filename = buildDeliverableFilename(key, state?.version)

      setDownloadingKey(key)
      try {
        // Tier 1: try cached signed URL
        if (state?.downloadUrl && (await tryDownloadFromUrl(state.downloadUrl, filename, meta?.mimeType))) {
          return
        }

        // Tier 2: refresh signed URL server-side
        const fresh = await getDeliverableUrl(projectId, key as DeliverableKey)
        if (!fresh.url) {
          showToast(fresh.error ?? 'Could not refresh download link. Please regenerate this deliverable.', 'error')
          return
        }
        // Cache the fresh URL for subsequent clicks in this session.
        setDeliverableMap((prev) => {
          const existing = prev[key]
          if (!existing) {
            return {
              ...prev,
              [key]: {
                downloadUrl: fresh.url!,
                version: fresh.version ?? '1.0',
                generatedAt: fresh.generatedAt ?? new Date().toISOString(),
              },
            }
          }
          return { ...prev, [key]: { ...existing, downloadUrl: fresh.url! } }
        })

        if (await tryDownloadFromUrl(fresh.url, filename, meta?.mimeType)) {
          return
        }

        // Tier 3: fall back to opening the URL in a new tab
        window.open(fresh.url, '_blank', 'noopener,noreferrer')
        showToast('Your browser blocked the direct download — the file was opened in a new tab.', 'error')
      } finally {
        setDownloadingKey(null)
      }
    },
    [deliverableMap, projectId]
  )

  // ── Generate all deliverables sequentially ──────────────────────────────

  async function handleGenerateAll() {
    const steps: { key: string; label: string; progress: string }[] = [
      { key: 'runbook_docx',     label: 'Migration Runbook',       progress: 'Generating migration runbook…' },
      { key: 'readiness_report', label: 'Readiness Report',        progress: 'Generating readiness report…' },
      { key: 'mapping_csv',      label: 'Mapping File',            progress: 'Generating mapping file…' },
      { key: 'transform_specs',  label: 'Transformation Specs',    progress: 'Generating transformation specs…' },
      { key: 'fix_log',          label: 'Fix Log',                 progress: 'Generating fix log…' },
      { key: 'data_dictionary',  label: 'Data Dictionary',         progress: 'Generating data dictionary…' },
    ]

    const failedLabels: string[] = []
    for (const step of steps) {
      setAllGenProgress(step.progress)
      const ok = await handleGenerateDeliverable(step.key)
      if (!ok) failedLabels.push(step.label)
    }

    // Also generate the single-file execution package as part of "Generate All"
    setAllGenProgress('Generating execution package…')
    const savedFormat = outputFormat
    setOutputFormat('single_file')
    const packageOk = await handleGenerateExecutionPackage()
    setOutputFormat(savedFormat)
    if (!packageOk) failedLabels.push('Execution Package')

    setAllGenProgress(null)
    if (failedLabels.length > 0) {
      showToast(`Failed: ${failedLabels.join(', ')}. See individual rows for details.`, 'error')
    } else {
      showToast('All deliverables generated', 'success')
    }
  }

  // ── Computed values ─────────────────────────────────────────────────────

  const { phases, metrics, decisions, outstanding, existingOutputs, projectStats } = data
  // PR-3: state-aware empty for stat widgets (Q4 — Card height preserved
  // across states, no layout shift). When the project hasn't reached
  // `mappings_generated`, the numeric stat in Mapping Coverage and
  // Transforms is replaced by a state label matching the tile badge
  // wording from PR-2.
  const projectStatsState: ProjectStats['state'] = projectStats?.state ?? 'awaiting_data'
  const isStatsPopulated = projectStatsState === 'mappings_generated'
  const projectStatsEmptyLabel =
    projectStatsState === 'awaiting_data'
      ? 'Awaiting data ingestion'
      : projectStatsState === 'data_ingested'
        ? 'Data ingested'
        : ''
  const filteredDecisions = decisionsTypeFilter === 'all'
    ? decisions
    : decisions.filter((d) => d.type === decisionsTypeFilter)
  const canGenerateGold = data.hasMappings && data.hasSourceData

  // ── Render ──────────────────────────────────────────────────────────────

  return (
    <div className="flex-1 h-full bg-gray-50 flex flex-col min-h-0">
      {/* Toast */}
      {toast && (
        <div className={`fixed bottom-6 right-6 z-50 px-4 py-3 rounded-lg shadow-lg text-sm font-medium ${toast.type === 'success' ? 'bg-green-600 text-white' : 'bg-red-600 text-white'}`}>
          {toast.message}
        </div>
      )}

      <PageHeader projectName={projectName} title="Migration Center" subtitle="Your migration deliverables and project status" projectId={projectId} />

      <div className="flex-1 overflow-auto">
      <div className="max-w-5xl mx-auto p-6 pb-16 space-y-6">

        {/* ════════════════════════════════════════════════════
            SECTION 1 — MIGRATION STATUS DASHBOARD
        ════════════════════════════════════════════════════ */}
        <div>

          {/* ── Compact stat cards ───────────────────────────────────────────
              PR-3 (feat/inner-page-stats-redesign): 4 cards → 5 cards.
              Mapping Coverage and Transforms now read from `projectStats`
              (PR-1's canonical surface) instead of the legacy `metrics.*`
              fields. New Source Coverage card slotted in between Transforms
              and Quality Issues — surfaces the source axis on MC for the
              first time. State-aware empty (Q4) renders the state label
              when state ≠ 'mappings_generated'; Card height preserved.
              Q2 numerator note: `transforms.complete` = saved + applied
              (was `metrics.completedTransforms` = applied-only); user-
              visible numeric jump on projects with saved-but-not-applied
              work. */}
          <div
            data-testid="mc-stats-grid"
            className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-5 gap-4 items-stretch mb-4"
          >
            {/* Card 1 — Mapping Coverage */}
            <div
              data-testid="mc-mapping-coverage"
              data-state={projectStatsState}
              className="rounded-lg border border-gray-100 bg-white p-4 flex flex-col justify-between gap-3"
            >
              <div>
                <p className="text-xs text-gray-500 mb-2">Mapping Coverage</p>
                {isStatsPopulated && projectStats ? (
                  <>
                    <div className="flex items-baseline gap-1">
                      <span
                        data-testid="mc-mapping-approved"
                        className="text-2xl font-semibold text-settle-slate-900"
                      >
                        {projectStats.target.approved}
                      </span>
                      <span className="text-sm text-settle-slate-400">
                        / {projectStats.target.total}
                      </span>
                    </div>
                    {projectStats.target.unmapped > 0 ? (
                      <p className="text-xs text-settle-slate-400 mt-1">
                        {projectStats.target.unmapped} unmapped
                      </p>
                    ) : (
                      <p className="text-xs text-green-600 mt-1">All fields mapped</p>
                    )}
                    {projectStats.target.total > 0 && (
                      <div className="mt-2 h-0.5 bg-settle-slate-100 rounded-full overflow-hidden">
                        <div
                          className="h-full bg-settle-slate-400 rounded-full"
                          style={{
                            width: `${Math.round((projectStats.target.approved / projectStats.target.total) * 100)}%`,
                          }}
                        />
                      </div>
                    )}
                  </>
                ) : (
                  <p
                    data-testid="mc-mapping-empty-label"
                    className="text-sm text-settle-slate-400 mt-1"
                  >
                    {projectStatsEmptyLabel}
                  </p>
                )}
              </div>
              <div className="border-t border-settle-slate-100 pt-2.5">
                <a href={`/app/projects/${projectId}/mapping`} className="text-xs font-medium text-settle-blue-500 hover:text-settle-blue-700 transition-colors inline-flex items-center gap-1">
                  Go to Mapping
                  <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><line x1="5" y1="12" x2="19" y2="12"/><polyline points="12 5 19 12 12 19"/></svg>
                </a>
              </div>
            </div>

            {/* Card 2 — Transforms (PR-3: reads projectStats.transforms;
                Q2 numerator = saved + applied) */}
            <div
              data-testid="mc-transforms"
              data-state={projectStatsState}
              className="rounded-lg border border-gray-100 bg-white p-4 flex flex-col justify-between gap-3"
            >
              <div>
                <p className="text-xs text-gray-500 mb-2">Transforms</p>
                {isStatsPopulated && projectStats ? (
                  <>
                    <div className="flex items-baseline gap-1">
                      <span
                        data-testid="mc-transforms-complete"
                        className="text-2xl font-semibold text-settle-slate-900"
                      >
                        {projectStats.transforms.complete}
                      </span>
                      <span className="text-sm text-settle-slate-400">
                        / {projectStats.transforms.total}
                      </span>
                    </div>
                    <div className="flex items-center gap-1.5 mt-1 flex-wrap">
                      {outstanding.fieldsNeedingTransformWork > 0 && (
                        <p className="text-xs text-settle-slate-400">{outstanding.fieldsNeedingTransformWork} need work</p>
                      )}
                      {outstanding.fieldsNeedingTransformWork > 0 && (outstanding.untestedTransforms > 0 || outstanding.testedTransforms > 0) && (
                        <span className="text-settle-slate-300 text-xs">·</span>
                      )}
                      {outstanding.untestedTransforms > 0 && (
                        <p className="text-xs text-settle-slate-400">{outstanding.untestedTransforms} untested</p>
                      )}
                    </div>
                    {projectStats.transforms.total > 0 && (
                      <div className="mt-2 h-0.5 bg-settle-slate-100 rounded-full overflow-hidden">
                        <div
                          className="h-full bg-settle-slate-400 rounded-full"
                          style={{
                            width: `${Math.round((projectStats.transforms.complete / projectStats.transforms.total) * 100)}%`,
                          }}
                        />
                      </div>
                    )}
                  </>
                ) : (
                  <p
                    data-testid="mc-transforms-empty-label"
                    className="text-sm text-settle-slate-400 mt-1"
                  >
                    {projectStatsEmptyLabel}
                  </p>
                )}
              </div>
              <div className="border-t border-settle-slate-100 pt-2.5">
                <a href={`/app/projects/${projectId}/transform`} className="text-xs font-medium text-settle-blue-500 hover:text-settle-blue-700 transition-colors inline-flex items-center gap-1">
                  Go to Transform
                  <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><line x1="5" y1="12" x2="19" y2="12"/><polyline points="12 5 19 12 12 19"/></svg>
                </a>
              </div>
            </div>

            {/* Card 3 — Source Coverage (NEW PR-3) */}
            <SourceCoverageWidget projectStats={projectStats} projectId={projectId} />

            {/* Card 3 — Quality Issues */}
            <div className="rounded-lg border border-gray-100 bg-white p-4 flex flex-col justify-between gap-3">
              <div>
                <p className="text-xs text-gray-500 mb-2">Quality Issues</p>
                {metrics.openBlocking === 0 && metrics.openWarnings === 0 ? (
                  <span className="text-2xl font-semibold text-green-600">Clean</span>
                ) : (
                  <div className="flex items-baseline gap-2 flex-wrap">
                    {metrics.openBlocking > 0 && (
                      <>
                        <span className="text-2xl font-semibold text-red-600">{metrics.openBlocking}</span>
                        <span className="text-sm text-red-600">blocking</span>
                      </>
                    )}
                    {metrics.openWarnings > 0 && (
                      <>
                        {metrics.openBlocking > 0 && <span className="text-settle-slate-300">·</span>}
                        <span className="text-sm text-amber-600">{metrics.openWarnings} warnings</span>
                      </>
                    )}
                  </div>
                )}
              </div>
              <div className="border-t border-settle-slate-100 pt-2.5">
                <a href={`/app/projects/${projectId}/data-quality`} className="text-xs font-medium text-settle-blue-500 hover:text-settle-blue-700 transition-colors inline-flex items-center gap-1">
                  Go to Validate
                  <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><line x1="5" y1="12" x2="19" y2="12"/><polyline points="12 5 19 12 12 19"/></svg>
                </a>
              </div>
            </div>

            {/* Card 4 — Migration Readiness */}
            <div className="rounded-lg border border-gray-100 bg-white p-4 flex flex-col justify-between gap-3">
              <div>
                <p className="text-xs text-gray-500 mb-2">Migration Readiness</p>
                <div className="flex items-baseline gap-1.5">
                  <span className={`text-2xl font-semibold ${readinessColor(metrics.readinessStatus)}`}>{metrics.readinessScore}%</span>
                  <span className={`text-sm font-medium ${readinessColor(metrics.readinessStatus)}`}>
                    {metrics.readinessStatus === 'ready' ? 'Ready' : metrics.readinessStatus === 'at_risk' ? 'At Risk' : 'Not Ready'}
                  </span>
                </div>
              </div>
              <div className="border-t border-settle-slate-100 pt-2.5">
                <button
                  onClick={() => {
                    const el = document.getElementById('readiness-report-section')
                    el?.scrollIntoView({ behavior: 'smooth', block: 'start' })
                  }}
                  className="text-xs font-medium text-settle-blue-500 hover:text-settle-blue-700 transition-colors inline-flex items-center gap-1"
                >
                  View Readiness Report
                  <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><line x1="5" y1="12" x2="19" y2="12"/><polyline points="12 5 19 12 12 19"/></svg>
                </button>
              </div>
            </div>
          </div>

          {/* ── Decisions log ──────────────────────────────────────────────── */}
          {decisions.length > 0 && (
            <button
              onClick={() => setShowDecisionsDrawer(true)}
              className="w-full flex items-center justify-between px-4 py-3 bg-white border border-settle-slate-200 rounded-xl hover:bg-settle-slate-50 transition-colors group"
            >
              <div className="flex items-center gap-2">
                <span className="text-sm font-medium text-settle-slate-700">Decisions & Actions Log</span>
                <span className="text-xs text-settle-slate-400">· {data.totalDecisions} total</span>
              </div>
              <ChevronRight className="w-3.5 h-3.5 text-settle-slate-400 group-hover:text-settle-slate-600 transition-colors" />
            </button>
          )}

          {/* Decisions log drawer */}
          {showDecisionsDrawer && (
            <div className="fixed inset-0 z-40 flex items-center justify-end bg-black/30 p-4">
              <div className="bg-white rounded-xl shadow-2xl w-full max-w-lg h-full max-h-[90vh] flex flex-col">
                <div className="flex items-center justify-between px-5 py-4 border-b border-gray-100 flex-shrink-0">
                  <div>
                    <h3 className="text-lg font-semibold text-gray-900">Decisions & Actions Log</h3>
                    <p className="text-xs text-gray-400 mt-0.5">{data.totalDecisions} total events</p>
                  </div>
                  <button
                    onClick={() => setShowDecisionsDrawer(false)}
                    className="text-gray-400 hover:text-gray-600 text-xl leading-none"
                  >
                    ×
                  </button>
                </div>
                <div className="flex items-center gap-1 px-5 py-3 border-b border-gray-100 flex-shrink-0 flex-wrap">
                  {[
                    { key: 'all', label: 'All' },
                    { key: 'system', label: 'Scans & Staging' },
                    { key: 'fix', label: 'Fixes' },
                    { key: 'transform', label: 'Transforms' },
                    { key: 'mapping', label: 'Mappings' },
                    { key: 'data', label: 'Data' },
                    { key: 'validation', label: 'Validation' },
                  ].filter(tab => tab.key === 'all' || decisions.some(d => d.type === tab.key))
                    .map((tab) => (
                      <button
                        key={tab.key}
                        onClick={() => setDecisionsTypeFilter(tab.key)}
                        className={`px-2.5 py-1 rounded-full text-xs font-medium transition-colors ${
                          decisionsTypeFilter === tab.key
                            ? 'bg-primary text-white'
                            : 'bg-gray-100 text-gray-600 hover:bg-gray-200'
                        }`}
                      >
                        {tab.label}
                        {tab.key !== 'all' && (
                          <span className="ml-1 opacity-70">
                            {decisions.filter(d => d.type === tab.key).length}
                          </span>
                        )}
                      </button>
                    ))}
                </div>
                <div className="flex-1 overflow-y-auto px-5 py-3 space-y-2.5">
                  {filteredDecisions.length === 0 ? (
                    <p className="text-sm text-gray-400 text-center py-8">No events of this type.</p>
                  ) : filteredDecisions.map((entry) => (
                    <div key={entry.id} className="flex items-start gap-2.5">
                      <DecisionIcon type={entry.type} />
                      <div className="flex-1 min-w-0">
                        <p className="text-xs text-gray-700">{entry.label}</p>
                      </div>
                      <span className="text-[10px] text-gray-400 flex-shrink-0 whitespace-nowrap">
                        {fmtDateTime(entry.timestamp)} · {entry.user_name ?? 'Unknown user'}
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          )}
        </div>

        {/* ════════════════════════════════════════════════════
            SECTION 2 — MIGRATION EXECUTION PACKAGE (hero deliverable)
        ════════════════════════════════════════════════════ */}
        <div className="border-t border-gray-100 pt-6 -mt-2">
          <h2 className="text-lg font-semibold text-gray-900 mb-4">Deliverables</h2>
        </div>

        <div>
          <div className="flex items-center gap-3 mb-3">
            <div className="flex items-center justify-center w-8 h-8 rounded-md bg-settle-slate-50 border border-gray-100 flex-shrink-0">
              <Package size={15} className="text-settle-slate-500" />
            </div>
            <h3 className="text-base font-semibold text-settle-slate-900">Migration Execution Package</h3>
          </div>

          {/* Accent card: left-border + subtle blue tint to signal primary deliverable */}
          <div className="bg-white border border-gray-100 rounded-lg p-5">

            <p className="text-sm text-gray-600 mb-5">
              Complete SQL migration script with extract queries, transformation logic, load scripts,
              post-load validation queries, and rollback procedures — ready for your team to review and execute.
            </p>

            {/* No mappings guard */}
            {!data.hasMappings && executionPackage.status === 'idle' && (
              <div className="flex items-start gap-2 p-3 bg-amber-50 border border-amber-200 rounded-lg text-sm text-amber-800 mb-4">
                <AlertCircle className="w-4 h-4 mt-0.5 flex-shrink-0 text-amber-500" />
                <span>
                  No approved mappings yet.{' '}
                  <a href={`/app/projects/${projectId}/mapping`} className="font-medium underline hover:text-amber-900">
                    Go to Mapping →
                  </a>{' '}
                  and approve at least one table mapping before generating the execution package.
                </span>
              </div>
            )}

            {/* Generation Settings — dialect + format selectors (hidden for per_table generated — toolbar takes over) */}
            {!isArchived && (outputFormat === 'single_file' ? executionPackage.status !== 'generating' : compartmentalized.status !== 'generating' && compartmentalized.status !== 'generated') && (
              <div className="mb-5 flex flex-wrap items-end gap-4">
                <div>
                  <label className="block text-xs font-medium text-gray-500 mb-1.5">Target SQL Dialect</label>
                  <Select value={sqlDialect} onValueChange={(v) => setSqlDialect(v as SqlDialect)}>
                    <SelectTrigger className="w-56 h-8 text-sm">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {SQL_DIALECTS.map((d) => (
                        <SelectItem key={d.id} value={d.id}>
                          <div>
                            <span className="font-medium">{d.label}</span>
                            <span className="block text-xs text-gray-400">{d.description}</span>
                          </div>
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>

                <div>
                  <label className="block text-xs font-medium text-gray-500 mb-1.5">Output Format</label>
                  <div className="flex items-center bg-gray-100 rounded-lg p-1 gap-1">
                    {(['per_table', 'single_file'] as const).map((fmt) => (
                      <button
                        key={fmt}
                        onClick={() => setOutputFormat(fmt)}
                        className={`px-3 py-1.5 rounded-md text-sm font-medium transition-colors whitespace-nowrap ${outputFormat === fmt ? 'bg-white text-gray-900 shadow-sm' : 'text-gray-500 hover:text-gray-700'}`}
                      >
                        {fmt === 'single_file' ? 'Single File' : 'Per-Table Scripts'}
                      </button>
                    ))}
                  </div>
                </div>
              </div>
            )}

            {/* ── SINGLE-FILE PATH ──────────────────────────────────────────── */}
            {outputFormat === 'single_file' && (
              <>
                {/* IDLE */}
                {executionPackage.status === 'idle' && !isArchived && (
                  <RoleTooltip allowed={canEdit} requiredRole="Editor">
                    <Button
                      className="bg-primary hover:bg-primary/90 text-white gap-2"
                      onClick={handleGenerateExecutionPackage}
                      disabled={!data.hasMappings || !canEdit}
                    >
                      <Zap className="w-4 h-4" />
                      Generate Execution Package
                    </Button>
                  </RoleTooltip>
                )}

                {/* GENERATING */}
                {executionPackage.status === 'generating' && (
                  <div className="flex items-center gap-3">
                    <RefreshCw className="w-5 h-5 text-blue-600 animate-spin flex-shrink-0" />
                    <div>
                      <p className="text-sm font-medium text-gray-800">Generating execution package…</p>
                      <p className="text-xs text-gray-500 mt-0.5">Assembling extract, transform, load, and validation scripts. This may take 15–30 seconds.</p>
                    </div>
                  </div>
                )}

                {/* GENERATED */}
                {executionPackage.status === 'generated' && (
                  <div>
                    <div className="flex items-center gap-2 mb-4 flex-wrap">
                      <CheckCircle2 className="w-4 h-4 text-green-600 flex-shrink-0" />
                      <span className="text-sm font-medium text-green-700">Generated</span>
                      {executionPackage.version && (
                        <span className="text-xs text-gray-500 bg-gray-100 px-2 py-0.5 rounded-full border border-gray-100">
                          v{executionPackage.version}
                        </span>
                      )}
                      {executionPackage.dialect && (
                        <span className="text-xs text-blue-700 bg-blue-50 px-2 py-0.5 rounded-full border border-blue-200">
                          {SQL_DIALECTS.find((d) => d.id === executionPackage.dialect)?.label ?? executionPackage.dialect}
                        </span>
                      )}
                      {executionPackage.generatedAt && (
                        <span className="text-xs text-gray-400">{fmtDateTime(executionPackage.generatedAt)}</span>
                      )}
                    </div>
                    <div className="flex items-center gap-3 flex-wrap">
                      <Button className="bg-primary hover:bg-primary/90 text-white gap-2" onClick={handleDownloadExecutionPackage}>
                        <Download className="w-4 h-4" />
                        Download .sql
                      </Button>
                      {!isArchived && (
                        <RoleTooltip allowed={canEdit} requiredRole="Editor">
                          <Button variant="outline" className="gap-2" onClick={handleGenerateExecutionPackage} disabled={!canEdit}>
                            <RefreshCw className="w-3.5 h-3.5" />
                            Regenerate
                          </Button>
                        </RoleTooltip>
                      )}
                    </div>
                  </div>
                )}

                {/* ERROR */}
                {executionPackage.status === 'error' && (
                  <div>
                    <div className="flex items-center gap-2 mb-3">
                      <AlertCircle className="w-4 h-4 text-red-500 flex-shrink-0" />
                      <span className="text-sm text-red-700">{executionPackage.error}</span>
                    </div>
                    {!isArchived && (
                      <RoleTooltip allowed={canEdit} requiredRole="Editor">
                        <Button variant="outline" className="gap-2" onClick={handleGenerateExecutionPackage} disabled={!canEdit}>
                          <RefreshCw className="w-3.5 h-3.5" />
                          Try Again
                        </Button>
                      </RoleTooltip>
                    )}
                  </div>
                )}
              </>
            )}

            {/* ── PER-TABLE PATH ────────────────────────────────────────────── */}
            {outputFormat === 'per_table' && (
              <>
                {/* IDLE */}
                {compartmentalized.status === 'idle' && !isArchived && (
                  <RoleTooltip allowed={canEdit} requiredRole="Editor">
                    <Button
                      className="bg-primary hover:bg-primary/90 text-white gap-2"
                      onClick={handleGenerateExecutionPackage}
                      disabled={!data.hasMappings || !canEdit}
                    >
                      <PackageOpen className="w-4 h-4" />
                      Generate Per-Table Scripts
                    </Button>
                  </RoleTooltip>
                )}

                {/* GENERATING */}
                {compartmentalized.status === 'generating' && (
                  <div className="flex items-center gap-3">
                    <RefreshCw className="w-5 h-5 text-blue-600 animate-spin flex-shrink-0" />
                    <div>
                      <p className="text-sm font-medium text-gray-800">Generating per-table scripts…</p>
                      <p className="text-xs text-gray-500 mt-0.5">Creating individual SQL files for each table. This may take 30–60 seconds.</p>
                    </div>
                  </div>
                )}

                {/* GENERATED */}
                {compartmentalized.status === 'generated' && (
                  <div className="border border-gray-100 rounded-lg overflow-hidden">
                    {/* Toolbar row */}
                    <div className="flex items-center justify-between gap-3 px-4 py-2.5 border-b border-settle-slate-100 bg-settle-slate-50/50">
                      <div className="flex items-center gap-2">
                        <Select value={sqlDialect} onValueChange={(v) => setSqlDialect(v as SqlDialect)}>
                          <SelectTrigger className="h-7 text-xs w-48 bg-white">
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            {SQL_DIALECTS.map((d) => (
                              <SelectItem key={d.id} value={d.id}>
                                <span className="font-medium text-xs">{d.label}</span>
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>

                        <div className="flex items-center bg-white border border-gray-100 rounded-md overflow-hidden">
                          {(['per_table', 'single_file'] as const).map((fmt) => (
                            <button
                              key={fmt}
                              onClick={() => setOutputFormat(fmt)}
                              className={`px-2.5 py-1 text-xs font-medium transition-colors ${
                                outputFormat === fmt
                                  ? 'bg-settle-slate-900 text-white'
                                  : 'text-settle-slate-500 hover:text-settle-slate-700'
                              }`}
                            >
                              {fmt === 'single_file' ? 'Single File' : 'Per-Table'}
                            </button>
                          ))}
                        </div>
                      </div>

                      <div className="flex items-center gap-2">
                        {!isArchived && (
                          <RoleTooltip allowed={canEdit} requiredRole="Editor">
                            <button
                              onClick={handleGenerateExecutionPackage}
                              disabled={!canEdit}
                              className="text-xs text-settle-slate-500 hover:text-settle-slate-700 transition-colors flex items-center gap-1 disabled:opacity-40"
                            >
                              <RefreshCw className="w-3 h-3" />
                              Regenerate
                            </button>
                          </RoleTooltip>
                        )}
                        <button
                          onClick={handleDownloadSelected}
                          disabled={selectedFiles.size === 0 || selectiveDownloading}
                          className="text-xs font-medium px-3 py-1.5 rounded-md border border-settle-slate-200 bg-white text-settle-slate-600 hover:bg-settle-slate-50 disabled:opacity-40 disabled:cursor-not-allowed transition-colors flex items-center gap-1.5"
                        >
                          {selectiveDownloading
                            ? <RefreshCw className="w-3 h-3 animate-spin" />
                            : <Download className="w-3 h-3" />
                          }
                          {selectedFiles.size > 0
                            ? `Download (${selectedFiles.size})`
                            : 'Download Selected'}
                        </button>
                        <button
                          onClick={handleDownloadZip}
                          className="text-xs font-medium px-3 py-1.5 rounded-md bg-primary text-white hover:bg-primary/90 transition-colors flex items-center gap-1.5"
                        >
                          <Download className="w-3 h-3" />
                          Download All (ZIP)
                        </button>
                      </div>
                    </div>

                    {/* Status bar */}
                    <div className="flex items-center justify-between px-4 py-2 border-b border-settle-slate-100">
                      <div className="flex items-center gap-2">
                        <div className="flex items-center gap-1.5 text-xs text-green-600 font-medium">
                          <CheckCircle2 className="w-3.5 h-3.5" />
                          {compartmentalized.files.length} files generated
                        </div>
                        <span className="text-settle-slate-200 text-xs">·</span>
                        {compartmentalized.dialect && (
                          <span className="text-[10px] text-settle-slate-500 bg-settle-slate-100 border border-gray-100 rounded px-1.5 py-0.5">
                            {SQL_DIALECTS.find((d) => d.id === compartmentalized.dialect)?.label ?? compartmentalized.dialect}
                          </span>
                        )}
                        {compartmentalized.generatedAt && (
                          <span className="text-[10px] text-settle-slate-400">
                            {fmtDateTime(compartmentalized.generatedAt)}
                          </span>
                        )}
                      </div>
                      <div className="flex items-center gap-1.5">
                        <Checkbox
                          checked={compartmentalized.files.length > 0 && selectedFiles.size === compartmentalized.files.length}
                          onCheckedChange={(checked) => {
                            if (checked) {
                              setSelectedFiles(new Set(compartmentalized.files.map((f) => f.filename)))
                            } else {
                              setSelectedFiles(new Set())
                            }
                          }}
                          className="h-3.5 w-3.5"
                        />
                        <span className="text-[10px] text-settle-slate-400">Select all</span>
                      </div>
                    </div>

                    {/* File list — collapsed to VISIBLE_FILE_COUNT, expandable */}
                    <div className={fileListExpanded ? 'max-h-96 overflow-y-auto' : ''}>
                      {(fileListExpanded
                        ? compartmentalized.files
                        : compartmentalized.files.slice(0, VISIBLE_FILE_COUNT)
                      ).map((file) => {
                        const isOpen = previewFilename === file.filename
                        const cachedContent = fileContentCache[file.filename]
                        const NEUTRAL_BADGE = 'bg-settle-slate-100 text-settle-slate-600 border-gray-100'
                        const typeInfo = (() => {
                          switch (file.type) {
                            case 'checklist':    return { label: 'Checklist',   cls: NEUTRAL_BADGE }
                            case 'table_script': return { label: 'Table Stage', cls: NEUTRAL_BADGE }
                            case 'validation':   return { label: 'Validation',  cls: NEUTRAL_BADGE }
                            case 'promote':      return { label: 'Promote',     cls: NEUTRAL_BADGE }
                            case 'rollback':     return { label: 'Rollback',    cls: NEUTRAL_BADGE }
                            default:             return { label: file.type,     cls: NEUTRAL_BADGE }
                          }
                        })()

                        return (
                          <div key={file.filename} data-filename={file.filename} className="border-t border-settle-slate-50">
                            <div className="grid grid-cols-[32px_1fr_110px_auto] gap-2 items-center px-4 py-2.5 hover:bg-gray-50/70 transition-colors">
                              <Checkbox
                                checked={selectedFiles.has(file.filename)}
                                onCheckedChange={(checked) => {
                                  setSelectedFiles((prev) => {
                                    const next = new Set(prev)
                                    checked ? next.add(file.filename) : next.delete(file.filename)
                                    return next
                                  })
                                }}
                              />
                              <span className="font-mono text-xs text-gray-800 truncate">{file.filename}</span>
                              <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-[11px] font-medium border ${typeInfo.cls} w-fit`}>
                                {typeInfo.label}
                              </span>
                              <div className="flex items-center gap-3">
                                <button
                                  onClick={() => handlePreviewFile(file.filename)}
                                  className="flex items-center gap-1 text-xs text-blue-600 hover:text-blue-800 font-medium"
                                >
                                  {isOpen ? <EyeOff className="w-3.5 h-3.5" /> : <Eye className="w-3.5 h-3.5" />}
                                  {isOpen ? 'Close' : 'Preview'}
                                </button>
                                <button
                                  onClick={() => handleDownloadFile(file)}
                                  className="flex items-center gap-1 text-xs text-gray-500 hover:text-gray-800 font-medium"
                                >
                                  <Download className="w-3.5 h-3.5" />
                                  Download
                                </button>
                              </div>
                            </div>

                            {/* Inline preview */}
                            {isOpen && (
                              <div className="border-t border-gray-100 bg-slate-900 rounded-b-none">
                                <div className="flex items-center justify-between px-4 py-2 border-b border-slate-700">
                                  <span className="text-xs font-mono text-slate-400">{file.filename}</span>
                                  <button
                                    onClick={() => handleCopyToClipboard(cachedContent ?? '')}
                                    disabled={!cachedContent}
                                    className="flex items-center gap-1.5 text-xs text-slate-400 hover:text-slate-200 transition-colors disabled:opacity-40"
                                  >
                                    {copied ? <Check className="w-3.5 h-3.5 text-green-400" /> : <Copy className="w-3.5 h-3.5" />}
                                    {copied ? 'Copied!' : 'Copy'}
                                  </button>
                                </div>
                                {previewLoading && !cachedContent ? (
                                  <div className="flex items-center gap-2 px-4 py-6 text-slate-400 text-sm">
                                    <RefreshCw className="w-4 h-4 animate-spin" />
                                    Loading file content…
                                  </div>
                                ) : (
                                  <pre className="text-green-300 text-xs font-mono p-4 overflow-x-auto max-h-96 whitespace-pre-wrap leading-relaxed">
                                    {cachedContent ?? '-- No content available'}
                                  </pre>
                                )}
                              </div>
                            )}
                          </div>
                        )
                      })}
                    </div>

                    {/* Expander row */}
                    {compartmentalized.files.length > VISIBLE_FILE_COUNT && (
                      <button
                        onClick={() => setFileListExpanded((v) => !v)}
                        className="w-full py-2.5 text-xs text-settle-slate-400 hover:text-settle-slate-600 transition-colors border-t border-settle-slate-100 flex items-center justify-center gap-1.5"
                      >
                        {fileListExpanded ? (
                          <>
                            <ChevronDown className="w-3 h-3 rotate-180" />
                            Show less
                          </>
                        ) : (
                          <>
                            <ChevronDown className="w-3 h-3" />
                            + {compartmentalized.files.length - VISIBLE_FILE_COUNT} more files · Show all
                          </>
                        )}
                      </button>
                    )}
                  </div>
                )}

                {/* ERROR */}
                {compartmentalized.status === 'error' && (
                  <div>
                    <div className="flex items-center gap-2 mb-3">
                      <AlertCircle className="w-4 h-4 text-red-500 flex-shrink-0" />
                      <span className="text-sm text-red-700">{compartmentalized.error}</span>
                    </div>
                    {!isArchived && (
                      <RoleTooltip allowed={canEdit} requiredRole="Editor">
                        <Button variant="outline" className="gap-2" onClick={handleGenerateExecutionPackage} disabled={!canEdit}>
                          <RefreshCw className="w-3.5 h-3.5" />
                          Try Again
                        </Button>
                      </RoleTooltip>
                    )}
                  </div>
                )}
              </>
            )}
          </div>
        </div>

        {/* ════════════════════════════════════════════════════
            SECTION 3 — IMPORT-READY FILES
        ════════════════════════════════════════════════════ */}
        <div>
          <div className="flex items-start justify-between mb-4">
            <div>
              <h2 className="text-lg font-semibold text-settle-slate-900">Import-Ready Files</h2>
              <p className="text-sm text-gray-500 mt-0.5">Production-ready data files with all transformations applied</p>
            </div>
          </div>

          <div className="bg-white border border-gray-100 rounded-lg shadow-sm overflow-hidden">
            <div className="p-6">
              {/* Warning strip */}
              {(outstanding.blockingIssues > 0 || outstanding.unmappedSourceFields > 0 || outstanding.untestedTransforms > 0) && (
                <div className="mb-3 flex items-start gap-2 px-3 py-2.5 bg-settle-slate-50 border border-gray-100 rounded-lg">
                  <AlertCircle className="w-3.5 h-3.5 text-settle-slate-400 flex-shrink-0 mt-0.5" />
                  <p className="text-xs text-settle-slate-600 leading-relaxed">
                    {[
                      outstanding.blockingIssues > 0
                        ? `${outstanding.blockingIssues} blocking issue${outstanding.blockingIssues !== 1 ? 's' : ''}`
                        : null,
                      outstanding.unmappedSourceFields > 0
                        ? `${outstanding.unmappedSourceFields} field${outstanding.unmappedSourceFields !== 1 ? 's' : ''} unmapped`
                        : null,
                      outstanding.untestedTransforms > 0
                        ? `${outstanding.untestedTransforms} transform${outstanding.untestedTransforms !== 1 ? 's' : ''} untested`
                        : null,
                    ].filter(Boolean).join(' · ')}{' — '}
                    <span className="text-settle-slate-500">generated files may not be production-ready</span>
                  </p>
                </div>
              )}

              {/* Format toggle + generate button */}
              <div className="flex items-center gap-3 mb-5">
                <div className="flex items-center bg-gray-100 rounded-lg p-1 gap-1">
                  {(['csv', 'sql'] as const).map((fmt) => (
                    <button
                      key={fmt}
                      onClick={() => setGoldFormat(fmt)}
                      className={`px-4 py-1.5 rounded-md text-sm font-medium transition-colors ${goldFormat === fmt ? 'bg-white text-gray-900 shadow-sm' : 'text-gray-500 hover:text-gray-700'}`}
                    >
                      {fmt === 'csv' ? 'Transformed CSVs' : 'SQL Load Scripts'}
                    </button>
                  ))}
                </div>

                {!isArchived && (
                  <RoleTooltip allowed={canEdit} requiredRole="Editor">
                    <Button
                      className="bg-primary hover:bg-primary/90 text-white gap-2 ml-auto"
                      onClick={handleGenerateGold}
                      disabled={isGeneratingGold || !canGenerateGold || !canEdit}
                    >
                      <Zap className="w-4 h-4" />
                      {isGeneratingGold ? goldProgress ?? 'Generating…' : `Generate Gold Standard ${goldFormat === 'csv' ? 'CSVs' : 'SQL Scripts'}`}
                    </Button>
                  </RoleTooltip>
                )}
              </div>

              {!canGenerateGold && (
                <p className="text-sm text-gray-400 mb-4">Approve at least one table mapping and upload source data to enable file generation.</p>
              )}

              {/* Generated file cards */}
              {goldFiles.length > 0 && (
                <div className="space-y-3 mt-2">
                  {goldFiles.map((file) => (
                    <div key={file.outputId} className="flex items-center justify-between p-4 bg-gray-50 border border-gray-100 rounded-lg">
                      <div>
                        <div className="flex items-center gap-2 mb-1">
                          <span className="text-sm font-semibold text-gray-900">{file.tableName}</span>
                          <Badge className="bg-blue-100 text-blue-700 hover:bg-blue-100 border-blue-200 text-[10px]">
                            {goldFormat.toUpperCase()}
                          </Badge>
                          <Badge className="bg-gray-100 text-gray-500 hover:bg-gray-100 border-gray-100 text-[10px]">
                            v{file.version}
                          </Badge>
                        </div>
                        <p className="text-xs text-gray-500">From {data.sourceDataset?.name ?? 'source'}.{file.sourceTableName} · {file.rowCount.toLocaleString()} records</p>
                      </div>
                      <a
                        href={file.downloadUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium text-blue-600 hover:text-blue-700 border border-blue-200 rounded-lg hover:bg-blue-50 transition-colors"
                      >
                        <Download className="w-4 h-4" />
                        Download
                      </a>
                    </div>
                  ))}
                </div>
              )}

              {/* Previously generated files from DB */}
              {goldFiles.length === 0 && (() => {
                const prevGold = existingOutputs.filter((o) => o.type === 'gold_standard_csv' || o.type === 'gold_standard_sql')
                if (prevGold.length === 0) return null
                return (
                  <div>
                    <p className="text-xs text-gray-500 mb-3 font-medium">Previously generated</p>
                    <div className="space-y-2">
                      {prevGold.slice(0, 5).map((o) => (
                        <div key={o.id} className="flex items-center justify-between p-3 bg-gray-50 border border-gray-100 rounded-lg">
                          <div>
                            <div className="flex items-center gap-2">
                              <span className="text-sm font-medium text-gray-700">{o.tableName ?? o.file_storage_path?.split('/').pop()}</span>
                              <Badge className="bg-gray-100 text-gray-500 hover:bg-gray-100 border-gray-100 text-[10px]">v{o.version}</Badge>
                            </div>
                            <p className="text-xs text-gray-400 mt-0.5">{fmtDateTime(o.generated_at)}</p>
                          </div>
                          {o.signedUrl && (
                            <a href={o.signedUrl} target="_blank" rel="noopener noreferrer" className="text-xs text-blue-600 hover:underline flex items-center gap-1">
                              <Download className="w-3 h-3" />Download
                            </a>
                          )}
                        </div>
                      ))}
                    </div>
                  </div>
                )
              })()}
            </div>
          </div>
        </div>

        {/* ════════════════════════════════════════════════════
            SECTION 4 — DELIVERABLE PACKAGE
        ════════════════════════════════════════════════════ */}
        <div>
          <div className="flex items-end justify-between mb-2">
            <div>
              <h2 className="text-lg font-semibold text-gray-900">Deliverable Package</h2>
              <p className="text-sm text-gray-500 mt-0.5">Migration documentation and reports for stakeholders, QA, and project records</p>
            </div>
            {!isArchived && (
              <RoleTooltip allowed={canEdit} requiredRole="Editor">
                <button
                  className="text-xs text-settle-slate-500 hover:text-settle-slate-700 transition-colors flex items-center gap-1.5 disabled:opacity-40 flex-shrink-0"
                  onClick={handleGenerateAll}
                  disabled={generatingKeys.size > 0 || !canEdit}
                >
                  <Sparkles className="w-3.5 h-3.5" />
                  {allGenProgress ?? 'Generate All Deliverables'}
                </button>
              </RoleTooltip>
            )}
          </div>

          <div className="bg-white border border-gray-100 rounded-lg overflow-hidden">
            <div className="grid grid-cols-2 divide-x divide-settle-slate-100">
              {/* Row 1 */}
              <div className="border-b border-settle-slate-100">
                <CompactDeliverableRow
                  title="Migration Runbook"
                  shortDescription="Step-by-step execution guide"
                  icon={<FileTextLucide size={13} className="text-settle-slate-500" />}
                  state={deliverableMap['runbook_docx']}
                  error={errorMap['runbook_docx']}
                  onGenerate={() => handleGenerateDeliverable('runbook_docx')}
                  onDownload={() => handleDownloadDeliverable('runbook_docx')}
                  isGenerating={generatingKeys.has('runbook_docx')}
                  isDownloading={downloadingKey === 'runbook_docx'}
                  isArchived={isArchived}
                  canEdit={canEdit}
                />
              </div>
              <div id="readiness-report-section" className="border-b border-settle-slate-100">
                <CompactDeliverableRow
                  title="Readiness Report"
                  shortDescription="Go/no-go recommendation"
                  icon={<BarChart2 size={13} className="text-settle-slate-500" />}
                  state={deliverableMap['readiness_report']}
                  error={errorMap['readiness_report']}
                  onGenerate={() => handleGenerateDeliverable('readiness_report')}
                  onDownload={() => handleDownloadDeliverable('readiness_report')}
                  isGenerating={generatingKeys.has('readiness_report')}
                  isDownloading={downloadingKey === 'readiness_report'}
                  isArchived={isArchived}
                  canEdit={canEdit}
                />
              </div>

              {/* Row 2 */}
              <div className="border-b border-settle-slate-100">
                <CompactDeliverableRow
                  title="Mapping File"
                  shortDescription="Field-to-field mapping spec"
                  icon={<GitMerge size={13} className="text-settle-slate-500" />}
                  csvState={deliverableMap['mapping_csv']}
                  jsonState={deliverableMap['mapping_json']}
                  csvError={errorMap['mapping_csv']}
                  jsonError={errorMap['mapping_json']}
                  onGenerateCSV={() => handleGenerateDeliverable('mapping_csv')}
                  onGenerateJSON={() => handleGenerateDeliverable('mapping_json')}
                  onDownloadCSV={() => handleDownloadDeliverable('mapping_csv')}
                  onDownloadJSON={() => handleDownloadDeliverable('mapping_json')}
                  isGeneratingCSV={generatingKeys.has('mapping_csv')}
                  isGeneratingJSON={generatingKeys.has('mapping_json')}
                  isDownloadingCSV={downloadingKey === 'mapping_csv'}
                  isDownloadingJSON={downloadingKey === 'mapping_json'}
                  isArchived={isArchived}
                  canEdit={canEdit}
                />
              </div>
              <div className="border-b border-settle-slate-100">
                <CompactDeliverableRow
                  title="Transformation Specs"
                  shortDescription="SQL transforms with field context"
                  icon={<Code2 size={13} className="text-settle-slate-500" />}
                  state={deliverableMap['transform_specs']}
                  error={errorMap['transform_specs']}
                  onGenerate={() => handleGenerateDeliverable('transform_specs')}
                  onDownload={() => handleDownloadDeliverable('transform_specs')}
                  isGenerating={generatingKeys.has('transform_specs')}
                  isDownloading={downloadingKey === 'transform_specs'}
                  isArchived={isArchived}
                  canEdit={canEdit}
                />
              </div>

              {/* Row 3 */}
              <div>
                <CompactDeliverableRow
                  title="Fix Log & Audit Trail"
                  shortDescription="Chronological record of all fixes"
                  icon={<Clock size={13} className="text-settle-slate-500" />}
                  state={deliverableMap['fix_log']}
                  error={errorMap['fix_log']}
                  onGenerate={() => handleGenerateDeliverable('fix_log')}
                  onDownload={() => handleDownloadDeliverable('fix_log')}
                  isGenerating={generatingKeys.has('fix_log')}
                  isDownloading={downloadingKey === 'fix_log'}
                  isArchived={isArchived}
                  canEdit={canEdit}
                />
              </div>
              <div>
                <CompactDeliverableRow
                  title="Data Dictionary"
                  shortDescription="Schema docs with data types"
                  icon={<BookOpen size={13} className="text-settle-slate-500" />}
                  state={deliverableMap['data_dictionary']}
                  error={errorMap['data_dictionary']}
                  onGenerate={() => handleGenerateDeliverable('data_dictionary')}
                  onDownload={() => handleDownloadDeliverable('data_dictionary')}
                  isGenerating={generatingKeys.has('data_dictionary')}
                  isDownloading={downloadingKey === 'data_dictionary'}
                  isArchived={isArchived}
                  canEdit={canEdit}
                />
              </div>
            </div>
          </div>
        </div>

      </div>
      </div>
    </div>
  )
}

// ── CompactDeliverableRow ─────────────────────────────────────────────────────
//
// Renders a single deliverable row in the Deliverable Package grid. Each row
// has four visual states:
//
//   1. Idle      — unified "Generate" control
//   2. Generating — spinner + "Generating…" label
//   3. Generated — green "Generated" pill + version pill + relative timestamp
//                  + primary "Download" button + ghost Regenerate icon
//   4. Dual-format (Mapping File only) — two independent sub-rows for CSV /
//                                        JSON, each with its own state
//
// The component is intentionally dumb: all state is passed in via props so
// that the parent owns both generation and download lifecycle (enabling
// shared toasts, signed-URL refresh, and role gating).

interface CompactDeliverableRowProps {
  title: string
  shortDescription: string
  icon: React.ReactNode
  isArchived: boolean
  canEdit: boolean

  // Single-format deliverable (all rows except Mapping File).
  state?: DeliverableState
  error?: string
  onGenerate?: () => void
  onDownload?: () => void
  isGenerating?: boolean
  isDownloading?: boolean

  // Dual-format deliverable (Mapping File — CSV and JSON are tracked independently).
  csvState?: DeliverableState
  jsonState?: DeliverableState
  csvError?: string
  jsonError?: string
  onGenerateCSV?: () => void
  onGenerateJSON?: () => void
  onDownloadCSV?: () => void
  onDownloadJSON?: () => void
  isGeneratingCSV?: boolean
  isGeneratingJSON?: boolean
  isDownloadingCSV?: boolean
  isDownloadingJSON?: boolean
}

function CompactDeliverableRow(props: CompactDeliverableRowProps) {
  const { title, shortDescription, icon, isArchived, canEdit } = props
  const isDualFormat =
    typeof props.onGenerateCSV === 'function' && typeof props.onGenerateJSON === 'function'

  // ── Dual-format (Mapping File) ───────────────────────────────────────────
  if (isDualFormat) {
    return (
      <div className="p-4">
        <div className="flex items-start gap-3">
          <div className="flex items-center justify-center w-7 h-7 rounded-md bg-settle-slate-50 border border-gray-100 flex-shrink-0 mt-0.5">
            {icon}
          </div>
          <div className="min-w-0 flex-1">
            <p className="text-sm font-medium text-settle-slate-900 truncate">{title}</p>
            <p className="text-xs text-settle-slate-400 mt-0.5">{shortDescription}</p>
          </div>
        </div>
        {!isArchived && (
          <div className="mt-2 pl-10 space-y-1.5">
            <DeliverableFormatSubRow
              format="CSV"
              state={props.csvState}
              error={props.csvError}
              onGenerate={props.onGenerateCSV!}
              onDownload={props.onDownloadCSV}
              isGenerating={Boolean(props.isGeneratingCSV)}
              isDownloading={Boolean(props.isDownloadingCSV)}
              canEdit={canEdit}
            />
            <DeliverableFormatSubRow
              format="JSON"
              state={props.jsonState}
              error={props.jsonError}
              onGenerate={props.onGenerateJSON!}
              onDownload={props.onDownloadJSON}
              isGenerating={Boolean(props.isGeneratingJSON)}
              isDownloading={Boolean(props.isDownloadingJSON)}
              canEdit={canEdit}
            />
          </div>
        )}
      </div>
    )
  }

  // ── Single-format layout ─────────────────────────────────────────────────
  const { state, error, onGenerate, onDownload, isGenerating, isDownloading } = props
  const hasGenerated = Boolean(state?.downloadUrl)
  const showError = Boolean(error) && !isGenerating

  return (
    <div className="p-4">
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-start gap-3 min-w-0 flex-1">
          <div className="flex items-center justify-center w-7 h-7 rounded-md bg-settle-slate-50 border border-gray-100 flex-shrink-0 mt-0.5">
            {icon}
          </div>
          <div className="min-w-0">
            <div className="flex items-center gap-1.5 flex-wrap">
              <p className="text-sm font-medium text-settle-slate-900 truncate">{title}</p>
              {hasGenerated && state?.version && (
                <span className="inline-flex items-center px-1.5 py-0.5 rounded-full text-[10px] font-medium bg-gray-100 text-gray-600 border border-gray-200 whitespace-nowrap">
                  v{state.version}
                </span>
              )}
            </div>
            <p className="text-xs text-settle-slate-400 mt-0.5 truncate">
              {hasGenerated && state?.generatedAt
                ? `Generated ${timeAgo(state.generatedAt)}`
                : shortDescription}
            </p>
          </div>
        </div>

        {!isArchived && (
          <div className="flex items-center gap-2 flex-shrink-0 mt-0.5">
            {isGenerating ? (
              <div className="flex items-center gap-1.5 text-xs text-settle-slate-400">
                <RefreshCw className="w-3.5 h-3.5 animate-spin" />
                <span>Generating…</span>
              </div>
            ) : hasGenerated ? (
              <>
                <button
                  type="button"
                  onClick={onDownload}
                  disabled={isDownloading || !onDownload}
                  aria-label={`Download ${title}`}
                  className="flex items-center gap-1 text-xs text-gray-500 hover:text-gray-800 font-medium disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
                >
                  {isDownloading
                    ? <RefreshCw className="w-3.5 h-3.5 animate-spin" />
                    : <Download className="w-3.5 h-3.5" />
                  }
                  Download
                </button>
                <button
                  type="button"
                  onClick={onGenerate}
                  disabled={!canEdit || !onGenerate}
                  aria-label={`Regenerate ${title}`}
                  className="flex items-center gap-1 text-xs text-gray-500 hover:text-gray-800 font-medium disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
                >
                  <RefreshCw className="w-3.5 h-3.5" />
                  Regenerate
                </button>
              </>
            ) : showError ? (
              <button
                type="button"
                onClick={onGenerate}
                disabled={!canEdit || !onGenerate}
                className="inline-flex items-center gap-1 text-xs font-medium text-red-600 hover:text-red-700 disabled:opacity-40 transition-colors"
              >
                <RefreshCw className="w-3 h-3" />
                Try Again
              </button>
            ) : (
              <button
                type="button"
                onClick={onGenerate}
                disabled={!canEdit || !onGenerate}
                className="text-xs text-settle-slate-500 hover:text-settle-slate-700 disabled:opacity-40 transition-colors flex items-center gap-1"
              >
                <RefreshCw className="w-3 h-3" />
                Generate
              </button>
            )}
          </div>
        )}
      </div>

      {showError && (
        <div className="mt-2 ml-10 flex items-start gap-1.5 text-[11px] text-red-700 bg-red-50 border border-red-100 rounded-md px-2 py-1.5">
          <AlertCircle className="w-3 h-3 mt-0.5 flex-shrink-0 text-red-500" />
          <span className="break-words">{error}</span>
        </div>
      )}
    </div>
  )
}

// ── DeliverableFormatSubRow ───────────────────────────────────────────────────
//
// Sub-row used inside the dual-format Mapping File row. Each format (CSV /
// JSON) tracks its own generation and download lifecycle so a user can
// produce either or both independently without the UI conflating them.

interface DeliverableFormatSubRowProps {
  format: 'CSV' | 'JSON'
  state?: DeliverableState
  error?: string
  onGenerate: () => void
  onDownload?: () => void
  isGenerating: boolean
  isDownloading: boolean
  canEdit: boolean
}

function DeliverableFormatSubRow({
  format,
  state,
  error,
  onGenerate,
  onDownload,
  isGenerating,
  isDownloading,
  canEdit,
}: DeliverableFormatSubRowProps) {
  const hasGenerated = Boolean(state?.downloadUrl)
  const showError = Boolean(error) && !isGenerating

  return (
    <div>
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-1.5 min-w-0">
          <span className="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-semibold text-settle-slate-600 bg-settle-slate-100 border border-settle-slate-200">
            {format}
          </span>
          {hasGenerated && state?.version && (
            <span className="text-[10px] text-settle-slate-400">v{state.version}</span>
          )}
          {hasGenerated && state?.generatedAt && (
            <span className="text-[10px] text-settle-slate-400">· {timeAgo(state.generatedAt)}</span>
          )}
        </div>

        <div className="flex items-center gap-1.5 flex-shrink-0">
          {isGenerating ? (
            <div className="flex items-center gap-1 text-[11px] text-settle-slate-400">
              <RefreshCw className="w-3 h-3 animate-spin" />
              <span>Generating…</span>
            </div>
          ) : hasGenerated ? (
            <>
              <button
                type="button"
                onClick={onDownload}
                disabled={isDownloading || !onDownload}
                aria-label={`Download ${format}`}
                className="flex items-center gap-1 text-xs text-gray-500 hover:text-gray-800 font-medium disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
              >
                {isDownloading
                  ? <RefreshCw className="w-3.5 h-3.5 animate-spin" />
                  : <Download className="w-3.5 h-3.5" />
                }
                Download
              </button>
              <button
                type="button"
                onClick={onGenerate}
                disabled={!canEdit}
                aria-label={`Regenerate ${format}`}
                className="flex items-center gap-1 text-xs text-gray-500 hover:text-gray-800 font-medium disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
              >
                <RefreshCw className="w-3.5 h-3.5" />
                Regenerate
              </button>
            </>
          ) : showError ? (
            <button
              type="button"
              onClick={onGenerate}
              disabled={!canEdit}
              className="inline-flex items-center gap-1 text-[11px] font-medium text-red-600 hover:text-red-700 disabled:opacity-40 transition-colors"
            >
              <RefreshCw className="w-2.5 h-2.5" />
              Try Again
            </button>
          ) : (
            <button
              type="button"
              onClick={onGenerate}
              disabled={!canEdit}
              className="text-[11px] text-settle-slate-500 hover:text-settle-slate-700 disabled:opacity-40 transition-colors flex items-center gap-1"
            >
              <RefreshCw className="w-2.5 h-2.5" />
              Generate {format}
            </button>
          )}
        </div>
      </div>

      {showError && (
        <div className="mt-1 flex items-start gap-1 text-[11px] text-red-700 bg-red-50 border border-red-100 rounded-md px-2 py-1">
          <AlertCircle className="w-3 h-3 mt-0.5 flex-shrink-0 text-red-500" />
          <span className="break-words">{error}</span>
        </div>
      )}
    </div>
  )
}

// ── Helpers ───────────────────────────────────────────────────────────────────

// Rehydrate the deliverable state from previously generated outputs.
// The UI key format is `<type>_<format>` so that multi-format deliverables
// (e.g. Mapping File has both CSV and JSON variants) are tracked independently.
// For each UI key we keep only the latest generation by `generated_at`.
function buildInitialDeliverableMap(outputs: ExistingOutput[]): Record<string, DeliverableState> {
  const map: Record<string, DeliverableState> = {}

  const resolveKey = (o: ExistingOutput): string | null => {
    switch (o.type) {
      case 'migration_runbook':
        return 'runbook_docx'
      case 'readiness_report':
        return 'readiness_report'
      case 'mapping_file':
        // Format-aware: CSV and JSON mapping exports are surfaced as separate rows.
        return o.format === 'json' ? 'mapping_json' : 'mapping_csv'
      case 'transformation_specs':
        return 'transform_specs'
      case 'fix_log':
        return 'fix_log'
      case 'data_dictionary':
        return 'data_dictionary'
      default:
        return null
    }
  }

  for (const o of outputs) {
    const key = resolveKey(o)
    if (!key || !o.signedUrl) continue
    const existing = map[key]
    if (!existing || new Date(o.generated_at) > new Date(existing.generatedAt)) {
      map[key] = { downloadUrl: o.signedUrl, version: o.version, generatedAt: o.generated_at }
    }
  }
  return map
}
