'use client'

import { useState, useRef, useCallback, useEffect } from 'react'
import { useRouter } from 'next/navigation'
import { Button } from '@/components/ui/button'
import {
  FileText,
  Upload,
  CheckCircle2,
  X,
  AlertCircle,
  ChevronRight,
  Search,
  Sparkles,
  Database,
  ArrowRight,
  Pencil,
} from '@/components/icons'
import {
  FileSpreadsheet,
  Table2,
  MinusCircle,
  TrendingUp,
  Paperclip,
  RefreshCw,
  ShieldCheck,
  ChevronDown,
  AlertTriangle,
  BookOpen,
} from 'lucide-react'
import { IngestionCard } from './IngestionCard'
import { PageHeader } from '@/components/app/PageHeader'
import { ProjectMenu } from '@/components/app/ProjectMenu'
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuPortal,
  DropdownMenuContent,
  DropdownMenuItem,
} from '@/components/ui/dropdown-menu'
import { useProjectRole } from '@/lib/hooks/useProjectRole'
import { RoleTooltip } from '@/components/app/RoleTooltip'
import {
  uploadSchemaDocument,
  deleteSchemaDocument,
  uploadBusinessContextDoc,
} from '@/lib/actions/schema-documents'
import { getTableFields, type SchemaField } from '@/lib/actions/schemabrowser'
import type { DatasetWithTableStats, TableStats } from '@/lib/actions/datasets'
import type { DBConnectionInfo, SchemaDocument } from '@/lib/types/database'

// ── Types ──────────────────────────────────────────────────────────────────────

interface DocUploadState {
  uploading: boolean
  error: string | null
  isDragOver: boolean
  filename?: string
}

interface ControlPlaneContentProps {
  projectId: string
  projectName: string
  sourceDatasets: DatasetWithTableStats[]
  targetDatasets: DatasetWithTableStats[]
  initialSourceDocs: SchemaDocument[]
  initialTargetDocs: SchemaDocument[]
  initialContextDocs: SchemaDocument[]
  primarySourceDatasetId: string | null
  primaryTargetDatasetId: string | null
  initialConnections?: Record<string, DBConnectionInfo>
  isArchived?: boolean
  // Backend integration point: called when user clicks "Generate ready-to-load data".
  // If not provided, navigates to /generating route automatically.
  onGenerateClick?: () => void
}

// ── File utilities ─────────────────────────────────────────────────────────────

function humanFileSize(bytes: number | null): string {
  if (!bytes) return ''
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

function fileIcon(filename: string): React.ReactNode {
  const ext = filename.toLowerCase().split('.').pop()
  if (ext === 'xlsx' || ext === 'xls' || ext === 'xlsb') {
    return <FileSpreadsheet className="w-4 h-4 text-green-600 flex-shrink-0" />
  }
  const color =
    ext === 'pdf'
      ? 'text-red-500'
      : ext === 'sql' || ext === 'ddl'
      ? 'text-blue-500'
      : ext === 'png' || ext === 'jpg' || ext === 'jpeg'
      ? 'text-purple-500'
      : 'text-gray-500'
  return <FileText className={`w-4 h-4 ${color} flex-shrink-0`} />
}

// Source/target ingestion method shown in the row meta, derived from real signals:
// a live DB connection → "Database"; uploaded CSV tables → "CSV"; otherwise a
// parsed schema file (DDL on the target side, generic schema on the source side).
function deriveMethod(
  tables: Pick<TableStats, 'csv_storage_path'>[],
  hasConnection: boolean,
  role: 'source' | 'target'
): string {
  if (hasConnection) return 'Database'
  if (tables.some((t) => t.csv_storage_path)) return 'CSV'
  return role === 'target' ? 'DDL' : 'Schema'
}

// ── Shared sub-components ──────────────────────────────────────────────────────

function DocList({
  docs,
  onDelete,
  canEdit = true,
}: {
  docs: SchemaDocument[]
  onDelete: (id: string) => void
  canEdit?: boolean
}) {
  if (docs.length === 0) return null
  return (
    <div className="space-y-2 mt-3">
      {docs.map((doc) => (
        <div
          key={doc.id}
          className="flex items-center justify-between px-3 py-2 bg-[#F9FAFB] rounded-md border border-[#E5E7EB]"
        >
          <div className="flex items-center gap-2 min-w-0">
            {fileIcon(doc.filename)}
            <span className="text-[13px] text-[#111827] truncate">{doc.filename}</span>
            {doc.file_size && (
              <span className="text-[12px] text-[#9CA3AF] flex-shrink-0">
                {humanFileSize(doc.file_size)}
              </span>
            )}
          </div>
          <div className="flex items-center gap-2 flex-shrink-0 ml-2">
            <CheckCircle2 className="w-4 h-4 text-[#10B981]" />
            <RoleTooltip allowed={canEdit} requiredRole="Editor">
              <button
                onClick={canEdit ? () => onDelete(doc.id) : undefined}
                disabled={!canEdit}
                className="text-[#9CA3AF] hover:text-red-500 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
                title="Delete"
              >
                <X className="w-4 h-4" />
              </button>
            </RoleTooltip>
          </div>
        </div>
      ))}
    </div>
  )
}

function UploadZone({
  onFile,
  uploading,
  filename,
  isDragOver,
  onDragOver,
  onDragLeave,
  onDrop,
  accept,
  hint,
  canEdit,
}: {
  onFile: (file: File) => void
  uploading: boolean
  filename?: string
  isDragOver: boolean
  onDragOver: () => void
  onDragLeave: () => void
  onDrop: (file: File) => void
  accept: string
  hint: string
  canEdit: boolean
}) {
  const inputRef = useRef<HTMLInputElement>(null)
  return (
    <div
      onDrop={(e) => { e.preventDefault(); onDragLeave(); const f = e.dataTransfer.files[0]; if (f) onDrop(f) }}
      onDragOver={(e) => { e.preventDefault(); onDragOver() }}
      onDragLeave={onDragLeave}
      className={`border-[1.5px] border-dashed rounded-lg p-4 text-center transition-colors ${isDragOver ? 'border-[#2358D4] bg-[#EEF2FD]' : 'border-[#E5E7EB] hover:border-[#D1D5DB]'}`}
    >
      {uploading ? (
        <div className="flex flex-col items-center justify-center py-4">
          <div className="flex items-center gap-2.5">
            <div className="w-4 h-4 border-2 border-[#2358D4]/30 border-t-[#2358D4] rounded-full animate-spin flex-shrink-0" />
            <span className="text-[13px] text-[#111827]">Uploading {filename ?? 'file'}…</span>
          </div>
        </div>
      ) : (
        <div className="space-y-2 py-2">
          <Upload className="w-5 h-5 text-[#9CA3AF] mx-auto" />
          <p className="text-[12.5px] text-[#6B7280]">{hint}</p>
          <input
            ref={inputRef}
            type="file"
            accept={accept}
            className="hidden"
            onChange={(e) => { const f = e.target.files?.[0]; if (f) onFile(f); e.target.value = '' }}
          />
          <RoleTooltip allowed={canEdit} requiredRole="Editor">
            <Button
              variant="outline"
              size="sm"
              type="button"
              onClick={() => inputRef.current?.click()}
              disabled={!canEdit}
            >
              Upload file
            </Button>
          </RoleTooltip>
        </div>
      )}
    </div>
  )
}

// ── Schema doc upload (per system) — prompt → adding → skipped ─────────────────

function SchemaDocSection({
  docs,
  datasetId,
  projectId,
  onDocsChange,
  canEdit = true,
}: {
  docs: SchemaDocument[]
  datasetId: string | null
  projectId: string
  onDocsChange: (docs: SchemaDocument[]) => void
  canEdit?: boolean
}) {
  const [state, setState] = useState<DocUploadState>({ uploading: false, error: null, isDragOver: false })
  const [mode, setMode] = useState<'prompt' | 'adding' | 'skipped'>(docs.length > 0 ? 'adding' : 'prompt')
  const ACCEPTED = '.pdf,.ddl,.sql,.txt,.doc,.docx,.png,.jpg,.jpeg'

  const doUpload = async (file: File) => {
    if (!datasetId) return
    setState((s) => ({ ...s, uploading: true, error: null, filename: file.name }))
    const fd = new FormData()
    fd.append('file', file)
    fd.append('projectId', projectId)
    fd.append('datasetId', datasetId)
    const result = await uploadSchemaDocument(fd)
    if (result.success && result.documentId) {
      const newDoc: SchemaDocument = {
        id: result.documentId,
        dataset_id: datasetId,
        project_id: null,
        doc_type: 'schema',
        filename: file.name,
        file_size: file.size,
        file_storage_path: '',
        extracted_text: null,
        created_at: new Date().toISOString(),
      }
      onDocsChange([...docs, newDoc])
    } else {
      setState((s) => ({ ...s, error: result.error ?? 'Upload failed' }))
    }
    setState((s) => ({ ...s, uploading: false }))
  }

  const handleDelete = async (docId: string) => {
    const result = await deleteSchemaDocument(docId)
    if (!result.success) {
      console.error('[deleteSchemaDocument]', result.error)
      return
    }
    onDocsChange(docs.filter((d) => d.id !== docId))
  }

  return (
    <div className="mt-5 pt-5 border-t border-[#E5E7EB]">
      <div className="flex items-center justify-between gap-3">
        <div className="text-[11px] font-semibold uppercase tracking-wider text-[#9CA3AF]">
          Supplemental documentation <span className="font-normal">· optional</span>
        </div>
        {mode !== 'skipped' && (
          <button
            type="button"
            onClick={() => setMode('skipped')}
            className="text-[12.5px] text-[#6B7280] hover:text-[#111827]"
          >
            Skip
          </button>
        )}
      </div>

      {mode === 'prompt' && (
        <div className="mt-2">
          <p className="text-[12.5px] text-[#6B7280] leading-relaxed">
            ERDs, data dictionaries, schema specs — improves AI accuracy on ambiguous fields.
          </p>
          <div className="mt-3">
            <RoleTooltip allowed={canEdit} requiredRole="Editor">
              <Button
                variant="outline"
                size="sm"
                type="button"
                disabled={!canEdit}
                onClick={() => setMode('adding')}
              >
                <Paperclip className="w-[13px] h-[13px] mr-1.5" />
                Add documentation
              </Button>
            </RoleTooltip>
          </div>
        </div>
      )}

      {mode === 'adding' && (
        <div className="mt-3">
          <UploadZone
            onFile={doUpload}
            uploading={state.uploading}
            filename={state.filename}
            isDragOver={state.isDragOver}
            onDragOver={() => setState((s) => ({ ...s, isDragOver: true }))}
            onDragLeave={() => setState((s) => ({ ...s, isDragOver: false }))}
            onDrop={doUpload}
            accept={ACCEPTED}
            hint="PDF, SQL, DDL, TXT, PNG — up to 20 MB"
            canEdit={canEdit && !!datasetId}
          />
          {state.error && (
            <div className="flex items-center gap-2 text-red-600 text-xs mt-2">
              <AlertCircle className="w-3 h-3" />{state.error}
            </div>
          )}
          <DocList docs={docs} onDelete={handleDelete} canEdit={canEdit} />
          {docs.length === 0 && (
            <div className="mt-2">
              <button
                type="button"
                onClick={() => setMode('skipped')}
                className="text-[12.5px] text-[#6B7280] hover:text-[#111827]"
              >
                Remove &amp; skip
              </button>
            </div>
          )}
        </div>
      )}

      {mode === 'skipped' && (
        <div className="mt-2 flex items-center justify-between gap-3">
          <span className="text-[12.5px] text-[#9CA3AF] inline-flex items-center gap-1.5">
            <MinusCircle className="w-[13px] h-[13px] text-[#D1D5DB]" />
            Documentation skipped — add later
          </span>
          <button
            type="button"
            onClick={() => setMode('prompt')}
            className="text-[12.5px] text-[#2358D4] hover:underline"
          >
            Add
          </button>
        </div>
      )}
    </div>
  )
}

// ── Schema browser column (lazy field-name chips) ──────────────────────────────

function SchemaColumn({
  projectId,
  label,
  side,
  tables,
}: {
  projectId: string
  label: string
  side: 'source' | 'target'
  tables: TableStats[]
}) {
  const [q, setQ] = useState('')
  const [open, setOpen] = useState<Set<string>>(new Set())
  const [fieldsCache, setFieldsCache] = useState<Record<string, SchemaField[] | 'loading' | undefined>>({})

  const toggle = async (id: string) => {
    setOpen((prev) => {
      const n = new Set(prev)
      if (n.has(id)) n.delete(id)
      else n.add(id)
      return n
    })
    if (fieldsCache[id] === undefined) {
      setFieldsCache((c) => ({ ...c, [id]: 'loading' }))
      try {
        const fields = await getTableFields(projectId, id)
        setFieldsCache((c) => ({ ...c, [id]: fields }))
      } catch {
        setFieldsCache((c) => ({ ...c, [id]: [] }))
      }
    }
  }

  const qq = q.trim().toLowerCase()
  const rows = tables.filter((t) => !qq || t.name.toLowerCase().includes(qq))

  return (
    <div className="rounded-lg border border-[#E5E7EB] bg-white overflow-hidden flex flex-col">
      <div className="flex items-center justify-between gap-2 px-4 py-2.5 border-b border-[#E5E7EB]">
        <span className="text-[13px] font-medium text-[#111827] truncate">{label}</span>
        <span className="text-[11.5px] text-[#9CA3AF] font-mono">{side}</span>
      </div>

      <div className="px-3 py-2.5 border-b border-[#E5E7EB]">
        <div className="relative">
          <Search className="w-[14px] h-[14px] text-[#9CA3AF] absolute left-2.5 top-1/2 -translate-y-1/2" />
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search tables…"
            className="w-full pl-8 pr-3 py-1.5 text-[13px] border border-[#E5E7EB] rounded-md bg-white text-[#111827] placeholder:text-[#9CA3AF] focus:outline-none focus:ring-1 focus:ring-[#3B82F6]"
          />
        </div>
      </div>

      <div className="max-h-[440px] overflow-y-auto">
        {rows.length === 0 && (
          <div className="px-4 py-6 text-center text-[12px] text-[#9CA3AF]">No tables match “{q}”.</div>
        )}
        {rows.map((t) => {
          const isOpen = open.has(t.id)
          const cached = fieldsCache[t.id]
          return (
            <div key={t.id} className="border-b border-[#F3F4F6] last:border-b-0">
              <button
                type="button"
                onClick={() => toggle(t.id)}
                className="w-full flex items-center justify-between gap-2 px-4 py-2.5 hover:bg-[#F9FAFB] text-left"
              >
                <div className="flex items-center gap-2 min-w-0">
                  <ChevronRight
                    className={`w-[13px] h-[13px] text-[#9CA3AF] shrink-0 transition-transform ${isOpen ? 'rotate-90' : ''}`}
                  />
                  <span className="font-mono text-[12.5px] text-[#111827] truncate">{t.name}</span>
                </div>
                <span className="text-[11.5px] text-[#9CA3AF] tabular-nums shrink-0">{t.field_count} fields</span>
              </button>
              {isOpen && (
                <div className="pb-2 pl-9 pr-4">
                  {cached === 'loading' || cached === undefined ? (
                    <div className="py-2 text-[11px] text-[#9CA3AF]">Loading fields…</div>
                  ) : cached.length === 0 ? (
                    <div className="py-2 text-[11px] text-[#9CA3AF]">No fields.</div>
                  ) : (
                    <div className="space-y-0.5">
                      {cached.map((f) => (
                        <div
                          key={f.id}
                          className="flex items-center gap-3 py-1 text-[12px]"
                        >
                          <span className="font-mono text-[12px] text-[#111827] truncate min-w-0 flex-1">
                            {f.name}
                          </span>
                          {f.data_type ? (
                            <span className="font-mono text-[11.5px] uppercase tracking-wider text-[#9CA3AF] shrink-0">
                              {f.data_type}
                            </span>
                          ) : null}
                          {!f.is_nullable ? (
                            <span className="font-mono text-[10.5px] uppercase tracking-wider text-[#9CA3AF] shrink-0">
                              NOT NULL
                            </span>
                          ) : null}
                          {f.is_primary_key ? (
                            <span className="inline-flex items-center rounded border border-[#E5E7EB] bg-[#F9FAFB] px-1.5 py-[1px] font-mono text-[10.5px] font-medium uppercase tracking-wider text-[#6B7280] shrink-0">
                              PK
                            </span>
                          ) : null}
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}

// ── Business Context Q&A ───────────────────────────────────────────────────────

const CONTEXT_QUESTIONS = [
  {
    q: 'What does your company sell or deliver, and to whom?',
    helper: 'One or two sentences. Example: "We manufacture custom-printed foodservice packaging — cups, sleeves, lids — and sell wholesale to coffee chains and restaurants."',
    placeholder: 'Describe what you sell and who buys it…',
    glossary: false,
  },
  {
    q: "What does the source system you're migrating from track, and how do you use it day-to-day?",
    helper: 'Example: "Legacy ERP we\'ve used since 2008 — inventory, orders, purchasing. Accounting lives separately. A few fields are repurposed."',
    placeholder: 'Describe the source system and how your team uses it…',
    glossary: false,
  },
  {
    q: 'What will the migrated data be used for in the new system, and is anything intentionally out of scope?',
    helper: 'Example: "Moving inventory and engineering items now; sales orders and historical financials stay in the old system. New system is the source of truth for production from Q3."',
    placeholder: 'Describe the intended use and anything out of scope…',
    glossary: false,
  },
  {
    q: 'Are there any codes, abbreviations, status flags, or placeholder values that mean something specific to your team?',
    helper: 'Example: "OUTSOURCED in the vendor field = drop-ship; ProductActive 0 = discontinued but searchable; WHC = hot cups, CHC = cold cups."',
    placeholder: 'List any codes, flags, or values with special meaning…',
    glossary: true,
  },
  {
    q: "Are there records you'd want to exclude, consolidate, or treat specially during the migration?",
    helper: 'Example: "Exclude items inactive 3+ years; consolidate variants by parent SKU; treat drop-ship items as a separate category."',
    placeholder: 'Describe any records to exclude, consolidate, or treat specially…',
    glossary: false,
  },
] as const

const CONTEXT_SHORT_LABELS = [
  'What you sell',
  "Source system & how it's used",
  'Scope & target use',
  'Codes & conventions',
  'Exclude / consolidate',
]

const TOTAL_QUESTIONS = CONTEXT_QUESTIONS.length
const TOTAL_QA_STEPS = TOTAL_QUESTIONS + 1

function QAProgress({ step }: { step: number }) {
  return (
    <div className="flex items-center justify-between gap-3">
      <div className="flex items-center gap-1.5">
        {Array.from({ length: TOTAL_QA_STEPS }).map((_, i) => (
          <span
            key={i}
            className="rounded-full"
            style={{ width: 6, height: 6, background: i === step ? '#2358D4' : '#E5E7EB', display: 'inline-block' }}
          />
        ))}
      </div>
      <span className="text-[12px] text-[#9CA3AF] tabular-nums">
        Question {step + 1} of {TOTAL_QA_STEPS}
      </span>
    </div>
  )
}

function BusinessContextQA({
  docs,
  projectId,
  onDocsChange,
  canEdit,
}: {
  docs: SchemaDocument[]
  projectId: string
  onDocsChange: (docs: SchemaDocument[]) => void
  canEdit: boolean
}) {
  // step: -1 = not started, 0..4 = question, 5 = documents, 6+ = done
  const [step, setStep] = useState(-1)
  const [answers, setAnswers] = useState<string[]>(Array(TOTAL_QUESTIONS).fill(''))
  const [additionalContext, setAdditionalContext] = useState('')
  const [docUploadState, setDocUploadState] = useState<DocUploadState>({
    uploading: false,
    error: null,
    isDragOver: false,
  })

  const setAnswer = (i: number, v: string) =>
    setAnswers((a) => { const n = [...a]; n[i] = v; return n })

  const docsStepCompleted = additionalContext.trim().length > 0 || docs.length > 0
  const answeredCount = answers.filter((a) => a.trim()).length + (docsStepCompleted ? 1 : 0)

  const doUpload = async (file: File) => {
    setDocUploadState((s) => ({ ...s, uploading: true, error: null, filename: file.name }))
    const fd = new FormData()
    fd.append('file', file)
    fd.append('projectId', projectId)
    const result = await uploadBusinessContextDoc(fd)
    if (result.success && result.documentId) {
      const newDoc: SchemaDocument = {
        id: result.documentId,
        dataset_id: null,
        project_id: projectId,
        doc_type: 'business_context',
        filename: file.name,
        file_size: file.size,
        file_storage_path: '',
        extracted_text: null,
        created_at: new Date().toISOString(),
      }
      onDocsChange([...docs, newDoc])
    } else {
      setDocUploadState((s) => ({ ...s, error: result.error ?? 'Upload failed' }))
    }
    setDocUploadState((s) => ({ ...s, uploading: false }))
  }

  const handleDeleteDoc = async (docId: string) => {
    const result = await deleteSchemaDocument(docId)
    if (!result.success) {
      console.error('[deleteSchemaDocument]', result.error)
      return
    }
    onDocsChange(docs.filter((d) => d.id !== docId))
  }

  const ACCURACY_PILL = (
    <span className="inline-flex items-center gap-1.5 text-[11.5px] text-[#2358D4] bg-[#EFF6FF] border border-[#DBEAFE] rounded-full px-2 py-0.5 whitespace-nowrap">
      <TrendingUp className="w-3 h-3" />
      Improves mapping accuracy ~28%
    </span>
  )

  // Not started — action row style (no expand chrome)
  if (step === -1) {
    return (
      <div className="w-full flex items-center gap-3 px-6 py-4">
        <span className="inline-flex items-center justify-center w-5 h-5 text-[#9CA3AF] shrink-0">
          <Sparkles className="w-[15px] h-[15px]" />
        </span>
        <div className="flex items-baseline gap-2 min-w-0">
          <span className="text-[14px] font-semibold text-[#111827] whitespace-nowrap">
            Business context
          </span>
          <span className="text-[12.5px] text-[#9CA3AF]">· optional</span>
        </div>
        <div className="flex-1" />
        <div className="flex items-center gap-3 shrink-0">
          {ACCURACY_PILL}
          <button
            type="button"
            onClick={() => setStep(0)}
            className="inline-flex items-center gap-1.5 text-[13px] font-medium text-white bg-[#2358D4] hover:bg-[#1E47B3] rounded-md px-3 py-1.5 transition-colors"
          >
            Start
            <ArrowRight className="w-[14px] h-[14px]" />
          </button>
        </div>
      </div>
    )
  }

  // Done — expandable summary
  if (step > TOTAL_QUESTIONS) {
    return (
      <CollapsibleRow
        icon={<Sparkles className="w-[15px] h-[15px]" />}
        title="Business context & migration rules"
        meta={`· ${answeredCount} of ${TOTAL_QA_STEPS} answered`}
        right={ACCURACY_PILL}
        defaultOpen
      >
        <div className="divide-y divide-[#F3F4F6]">
          {CONTEXT_QUESTIONS.map((cq, i) =>
            answers[i].trim() ? (
              <div key={i} className="py-3 first:pt-0 flex items-start justify-between gap-4">
                <div className="min-w-0">
                  <div className="text-[11px] font-semibold uppercase tracking-wider text-[#9CA3AF] mb-1">
                    {CONTEXT_SHORT_LABELS[i]}
                  </div>
                  <p className="text-[13px] text-[#111827] leading-relaxed">{answers[i]}</p>
                </div>
                <button
                  type="button"
                  onClick={() => setStep(i)}
                  className="text-[#9CA3AF] hover:text-[#2358D4] shrink-0 mt-0.5"
                  aria-label="Edit answer"
                >
                  <Pencil className="w-[13px] h-[13px]" />
                </button>
              </div>
            ) : (
              <div key={i} className="py-3 first:pt-0 flex items-center justify-between gap-4">
                <span className="text-[12.5px] text-[#9CA3AF] inline-flex items-center gap-1.5">
                  <MinusCircle className="w-[13px] h-[13px] text-[#D1D5DB]" />
                  {CONTEXT_SHORT_LABELS[i]} — skipped
                </span>
                <button
                  type="button"
                  onClick={() => setStep(i)}
                  className="text-[12.5px] text-[#2358D4] hover:underline shrink-0"
                >
                  Answer
                </button>
              </div>
            )
          )}
        </div>

        {docs.length > 0 && (
          <div className="mt-4 pt-4 border-t border-[#E5E7EB]">
            <div className="text-[11px] font-semibold uppercase tracking-wider text-[#9CA3AF] mb-2">
              Documents
            </div>
            <DocList docs={docs} onDelete={handleDeleteDoc} canEdit={canEdit} />
          </div>
        )}

        <div className="mt-4 pt-4 border-t border-[#E5E7EB]">
          <button
            type="button"
            onClick={() => setStep(0)}
            className="inline-flex items-center gap-1.5 text-[12.5px] text-[#6B7280] hover:text-[#111827]"
          >
            <Pencil className="w-[13px] h-[13px]" />
            Edit answers
          </button>
        </div>
      </CollapsibleRow>
    )
  }

  // In progress — expanded body
  const isDocs = step === TOTAL_QUESTIONS
  const cur = isDocs ? null : CONTEXT_QUESTIONS[step]
  const isLast = step === TOTAL_QUESTIONS - 1

  return (
    <div>
      <div className="w-full flex items-center gap-3 px-6 py-4 border-b border-[#E5E7EB]">
        <span className="inline-flex items-center justify-center w-5 h-5 text-[#9CA3AF] shrink-0">
          <Sparkles className="w-[15px] h-[15px]" />
        </span>
        <div className="flex items-baseline gap-2 min-w-0">
          <span className="text-[14px] font-semibold text-[#111827] whitespace-nowrap">
            Business context & migration rules
          </span>
          <span className="text-[12.5px] text-[#9CA3AF]">
            · {answeredCount} of {TOTAL_QA_STEPS} answered
          </span>
        </div>
        <div className="flex-1" />
        {ACCURACY_PILL}
      </div>

      <div className="px-6 pb-6 pt-4">
        {isDocs ? (
          <div key="docs">
            <QAProgress step={TOTAL_QUESTIONS} />
            <div className="text-[16px] font-medium text-[#111827] mt-4">Add any additional context</div>
            <p className="text-[12.5px] text-[#6B7280] mt-1.5 leading-relaxed">
              Write any extra notes below, or attach an ERD, data dictionary, or migration spec.
            </p>
            <div className="mt-3">
              <textarea
                value={additionalContext}
                onChange={(e) => setAdditionalContext(e.target.value)}
                rows={3}
                placeholder="Add any additional context that might help — assumptions, edge cases, exceptions…"
                className="w-full px-3 py-2 text-[13px] leading-relaxed border border-[#E5E7EB] rounded-md bg-white text-[#111827] placeholder:text-[#9CA3AF] focus:outline-none focus:ring-1 focus:ring-[#3B82F6] resize-y"
              />
            </div>
            <div className="mt-3">
              <UploadZone
                onFile={doUpload}
                uploading={docUploadState.uploading}
                filename={docUploadState.filename}
                isDragOver={docUploadState.isDragOver}
                onDragOver={() => setDocUploadState((s) => ({ ...s, isDragOver: true }))}
                onDragLeave={() => setDocUploadState((s) => ({ ...s, isDragOver: false }))}
                onDrop={doUpload}
                accept=".pdf,.txt,.md,.doc,.docx,.xlsx,.csv,.png,.jpg,.jpeg"
                hint="PDF, DOCX, XLSX, TXT — up to 20 MB"
                canEdit={canEdit}
              />
              {docUploadState.error && (
                <div className="flex items-center gap-2 text-red-600 text-xs mt-2">
                  <AlertCircle className="w-3 h-3" />{docUploadState.error}
                </div>
              )}
            </div>
            <DocList docs={docs} onDelete={handleDeleteDoc} canEdit={canEdit} />
            <div className="mt-5 pt-4 border-t border-[#F3F4F6] flex items-center justify-between gap-3">
              <div className="flex items-center gap-4">
                <button
                  type="button"
                  onClick={() => setStep(TOTAL_QUESTIONS - 1)}
                  className="text-[12.5px] text-[#6B7280] hover:text-[#111827]"
                >
                  Back
                </button>
                <button
                  type="button"
                  onClick={() => setStep(TOTAL_QUESTIONS + 1)}
                  className="text-[12.5px] text-[#6B7280] hover:text-[#111827] underline"
                >
                  Skip
                </button>
              </div>
              <button
                type="button"
                onClick={() => setStep(TOTAL_QUESTIONS + 1)}
                className="inline-flex items-center gap-1.5 text-[13px] font-medium text-white bg-[#2358D4] hover:bg-[#1E47B3] rounded-md px-3 py-1.5 transition-colors"
              >
                Done
              </button>
            </div>
          </div>
        ) : (
          <div key={step}>
            <QAProgress step={step} />
            <div className="text-[16px] font-medium text-[#111827] mt-4 leading-snug">{cur!.q}</div>
            <p className="text-[12.5px] text-[#9CA3AF] mt-1.5 leading-relaxed">{cur!.helper}</p>
            <div className="mt-3">
              <textarea
                value={answers[step]}
                onChange={(e) => setAnswer(step, e.target.value)}
                rows={3}
                placeholder={cur!.placeholder}
                className="w-full px-3 py-2 text-[13px] leading-relaxed border border-[#E5E7EB] rounded-md bg-white text-[#111827] placeholder:text-[#9CA3AF] focus:outline-none focus:ring-1 focus:ring-[#3B82F6] resize-y"
              />
            </div>
            {cur!.glossary && (
              <div className="mt-2.5">
                <button
                  type="button"
                  className="inline-flex items-center gap-1.5 text-[12.5px] text-[#2358D4] hover:underline"
                >
                  <Paperclip className="w-[13px] h-[13px]" />
                  Attach a glossary or legend
                </button>
              </div>
            )}
            <div className="mt-5 pt-4 border-t border-[#F3F4F6] flex items-center justify-between gap-3">
              <div className="flex items-center gap-4">
                {step >= 1 && (
                  <button
                    type="button"
                    onClick={() => setStep(step - 1)}
                    className="text-[12.5px] text-[#6B7280] hover:text-[#111827]"
                  >
                    Back
                  </button>
                )}
                <button
                  type="button"
                  onClick={() => setStep(step + 1)}
                  className="text-[12.5px] text-[#6B7280] hover:text-[#111827] underline"
                >
                  Skip
                </button>
              </div>
              <button
                type="button"
                onClick={() => setStep(step + 1)}
                className="inline-flex items-center gap-1.5 text-[13px] font-medium text-white bg-[#2358D4] hover:bg-[#1E47B3] rounded-md px-3 py-1.5 transition-colors"
              >
                {isLast ? 'Continue' : 'Next'}
                <ArrowRight className="w-[14px] h-[14px]" />
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}

// ── Action row (incomplete step, button on the right, no expand) ───────────────

function ActionRow({
  icon,
  title,
  meta,
  right,
}: {
  icon: React.ReactNode
  title: string
  meta?: string
  right?: React.ReactNode
}) {
  return (
    <div className="w-full flex items-center gap-3 px-6 py-4">
      <span className="inline-flex items-center justify-center w-5 h-5 text-[#9CA3AF] shrink-0">{icon}</span>
      <div className="flex items-baseline gap-2 min-w-0">
        <span className="text-[14px] font-semibold text-[#111827] whitespace-nowrap">{title}</span>
        {meta && <span className="text-[12.5px] text-[#9CA3AF] truncate">{meta}</span>}
      </div>
      <div className="flex-1" />
      <div className="flex items-center gap-3 shrink-0">{right}</div>
    </div>
  )
}

// ── Collapsible grouped-list row ───────────────────────────────────────────────

function CollapsibleRow({
  icon,
  title,
  meta,
  right,
  locked = false,
  defaultOpen = false,
  children,
}: {
  icon: React.ReactNode
  title: string
  meta?: string
  right?: React.ReactNode
  locked?: boolean
  defaultOpen?: boolean
  children?: React.ReactNode
}) {
  const [open, setOpen] = useState(defaultOpen)
  const clickable = !locked

  return (
    <div>
      <button
        type="button"
        disabled={!clickable}
        onClick={() => clickable && setOpen((v) => !v)}
        className={`w-full flex items-center gap-3 px-6 py-4 text-left transition-colors ${
          clickable ? 'hover:bg-[#F9FAFB]' : 'cursor-default'
        }`}
        aria-expanded={open}
      >
        <span
          className={`inline-flex items-center justify-center w-5 h-5 shrink-0 ${
            locked ? 'text-[#D1D5DB]' : 'text-[#9CA3AF]'
          }`}
        >
          {icon}
        </span>
        <div className="flex items-baseline gap-2 min-w-0">
          <span
            className={`text-[14px] font-semibold whitespace-nowrap ${
              locked ? 'text-[#9CA3AF]' : 'text-[#111827]'
            }`}
          >
            {title}
          </span>
          {meta && (
            <span className="text-[12.5px] text-[#9CA3AF] truncate">{meta}</span>
          )}
        </div>
        <div className="flex-1" />
        <div className="flex items-center gap-3 shrink-0">
          {right}
          {locked ? (
            <span className="inline-flex items-center justify-center w-5 h-5 text-[#D1D5DB]">
              <svg width={14} height={14} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round">
                <rect x="3" y="11" width="18" height="11" rx="2" ry="2" />
                <path d="M7 11V7a5 5 0 0 1 10 0v4" />
              </svg>
            </span>
          ) : (
            <span
              className={`inline-flex items-center justify-center w-5 h-5 text-[#6B7280] transition-transform ${
                open ? 'rotate-90' : ''
              }`}
            >
              <ChevronRight className="w-[15px] h-[15px]" />
            </span>
          )}
        </div>
      </button>
      {open && !locked && (
        <div className="px-6 pb-6 pt-4 border-t border-[#E5E7EB]">{children}</div>
      )}
    </div>
  )
}

// ── Status strip ────────────────────────────────────────────────────────────
// Mirrors the Settle MVP design's StateStrip (src/app.jsx). STUB: the metric
// values are placeholders — real figures (mapping completeness, review progress,
// issue/rule/glossary counts) span the mapping, validation, and rules subsystems
// and are not wired yet. Rendered for visual parity; items are non-navigating
// until the data and click-through targets are connected.
function StatusStrip() {
  const chev = (
    <span className="text-[#9CA3AF] text-[14.5px] font-semibold leading-none" aria-hidden="true">
      ›
    </span>
  )
  const dot = <span className="text-[#D1D5DB] shrink-0">·</span>

  return (
    <div
      title="Sample values — not yet wired to live data"
      className="h-10 shrink-0 border-b border-[#E5E7EB] bg-white px-6 flex items-center gap-x-5 text-[12.5px] text-[#6B7280]"
    >
      <span className="inline-flex items-center gap-1.5 shrink-0">
        <span className="text-[#9CA3AF] leading-none">Reviewed</span>
        <span className="text-[#111827] tabular-nums leading-none">0/50</span>
      </span>
      {dot}
      <span className="group inline-flex items-center gap-1.5 shrink-0 rounded-md px-1.5 -mx-1.5 hover:bg-[#F3F4F6] transition-colors">
        <span className="text-[#9CA3AF] leading-none">Source</span>
        <span className="text-[#111827] tabular-nums leading-none">118/140</span>
        <span className="text-[#9CA3AF] leading-none">mapped</span>
        {chev}
      </span>
      {dot}
      <span className="inline-flex items-center gap-1.5 shrink-0">
        <span className="text-[#9CA3AF] leading-none">Target</span>
        <span className="text-[#111827] tabular-nums leading-none">155/162</span>
        <span className="text-[#9CA3AF] leading-none">set</span>
      </span>
      {dot}
      <span className="group inline-flex items-center gap-1.5 shrink-0 rounded-md px-1.5 -mx-1.5 hover:bg-[#F3F4F6] transition-colors">
        <AlertTriangle className="w-[13px] h-[13px] text-[#71717A]" />
        <span className="text-[#9CA3AF] leading-none">Issues</span>
        <span className="inline-flex items-center gap-2 leading-none">
          <span className="text-[#D97706] tabular-nums leading-none">15</span>
          <span aria-hidden="true" className="w-px h-3 bg-[#D4D4D8]" />
          <span className="text-[#DC2626] tabular-nums leading-none">41</span>
        </span>
        {chev}
      </span>

      <div className="flex-1" />

      <span className="group inline-flex items-center gap-1.5 shrink-0 rounded-md px-1.5 -mx-1.5 hover:bg-[#F3F4F6] transition-colors">
        <span className="text-[#9CA3AF] leading-none">Rules</span>
        <span className="text-[#111827] tabular-nums leading-none">30</span>
        {chev}
      </span>
      {dot}
      <span className="group inline-flex items-center gap-1.5 shrink-0 rounded-md px-1.5 -mx-1.5 hover:bg-[#F3F4F6] transition-colors">
        <BookOpen className="w-[13px] h-[13px] text-[#9CA3AF]" />
        <span className="text-[#9CA3AF] leading-none">Glossary</span>
        {chev}
      </span>
    </div>
  )
}

// ── Main component ─────────────────────────────────────────────────────────────

export function ControlPlaneContent({
  projectId,
  projectName,
  sourceDatasets,
  targetDatasets,
  initialSourceDocs,
  initialTargetDocs,
  initialContextDocs,
  primarySourceDatasetId,
  primaryTargetDatasetId,
  initialConnections = {},
  isArchived = false,
  onGenerateClick,
}: ControlPlaneContentProps) {
  const { can } = useProjectRole(projectId)
  const canEdit = can('edit')

  const [sourceDocs, setSourceDocs] = useState<SchemaDocument[]>(initialSourceDocs)
  const [targetDocs, setTargetDocs] = useState<SchemaDocument[]>(initialTargetDocs)
  const [contextDocs, setContextDocs] = useState<SchemaDocument[]>(initialContextDocs)
  const [reviewed, setReviewed] = useState(false)

  // Empty-state "Start" reveals the ingestion form before a dataset exists.
  const [sourceStarted, setSourceStarted] = useState(false)
  const [targetStarted, setTargetStarted] = useState(false)

  const router = useRouter()

  const sourceAdded = sourceDatasets.length > 0
  const targetAdded = targetDatasets.length > 0
  const bothAdded = sourceAdded && targetAdded

  const canReview = bothAdded
  const canGenerate = bothAdded && reviewed

  // Reset review if a system is removed (e.g., dataset deleted later)
  useEffect(() => {
    if (!bothAdded && reviewed) setReviewed(false)
  }, [bothAdded, reviewed])

  const gateGuidance = !bothAdded
    ? 'Add source and target to continue'
    : !reviewed
    ? 'Review the schema and confirm to generate'
    : 'Everything looks ready.'

  const handleGenerate = useCallback(() => {
    if (!canGenerate) return
    if (onGenerateClick) {
      onGenerateClick()
    } else {
      // Backend integration point: replace with actual generation trigger.
      // Currently navigates to the generation UI page for demo purposes.
      router.push(`/app/projects/${projectId}/generating`)
    }
  }, [canGenerate, onGenerateClick, projectId, router])

  const sourceTables = sourceDatasets.flatMap((ds) => ds.tables)
  const targetTables = targetDatasets.flatMap((ds) => ds.tables)
  const sourceTableCount = sourceTables.length
  const sourceFieldCount = sourceTables.reduce((s, t) => s + (t.field_count ?? 0), 0)
  const targetTableCount = targetTables.length
  const targetFieldCount = targetTables.reduce((s, t) => s + (t.field_count ?? 0), 0)

  const sourceConnection = primarySourceDatasetId ? (initialConnections?.[primarySourceDatasetId] ?? null) : null
  const targetConnection = primaryTargetDatasetId ? (initialConnections?.[primaryTargetDatasetId] ?? null) : null
  const sourceMethod = deriveMethod(sourceTables, !!sourceConnection, 'source')
  const targetMethod = deriveMethod(targetTables, !!targetConnection, 'target')

  const startButton = (onClick: () => void) => (
    <RoleTooltip allowed={canEdit} requiredRole="Editor">
      <button
        type="button"
        disabled={!canEdit}
        onClick={onClick}
        className="inline-flex items-center gap-1.5 text-[13px] font-medium text-white bg-[#2358D4] hover:bg-[#1E47B3] rounded-md px-3 py-1.5 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
      >
        Start
        <ArrowRight className="w-[14px] h-[14px]" />
      </button>
    </RoleTooltip>
  )

  const connectedBadge = (label: string) => (
    <span className="inline-flex items-center gap-1.5 text-[12px] text-[#6B7280] whitespace-nowrap">
      <CheckCircle2 className="w-[13px] h-[13px] text-[#10B981]" />
      {label}
    </span>
  )

  return (
    <div className="flex-1 bg-[#FAFAFA] flex flex-col min-h-0">
      <PageHeader
        projectName={
          sourceDatasets[0]?.name && targetDatasets[0]?.name
            ? `${projectName} — ${sourceDatasets[0].name} → ${targetDatasets[0].name}`
            : projectName
        }
        title="Setup"
      >
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button
              title="Re-derive the data from the current mappings and transforms."
              className="inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-[12px] font-medium text-[#3B82F6] hover:bg-[#EFF6FF] hover:text-[#2563EB] transition-colors data-[state=open]:bg-[#EFF6FF] data-[state=open]:text-[#2563EB]"
            >
              <RefreshCw className="w-[13px] h-[13px]" />
              Regenerate
              <ChevronDown className="w-3 h-3 text-[#93C5FD]" />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuPortal>
            <DropdownMenuContent align="end" className="w-[200px]">
              <DropdownMenuItem
                disabled={!canEdit}
                onClick={() => router.push(`/app/projects/${projectId}/generating`)}
              >
                <RefreshCw className="w-[13px] h-[13px] mr-2 text-[#9CA3AF]" />
                Regenerate all data
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenuPortal>
        </DropdownMenu>

        {/* Rescan is a visual stub — no rescan endpoint wired yet. */}
        <button
          type="button"
          title="Re-check the current data against your rules — doesn't change values. (Coming soon)"
          className="inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-[12px] font-medium text-[#3B82F6] hover:bg-[#EFF6FF] hover:text-[#2563EB] transition-colors"
        >
          <ShieldCheck className="w-[13px] h-[13px]" />
          Rescan
        </button>

        <ProjectMenu
          project={{
            id: projectId,
            name: projectName,
            source_label: sourceDatasets[0]?.name ?? '',
            target_label: targetDatasets[0]?.name ?? '',
            status: isArchived ? 'archived' : 'active',
          }}
          onUpdate={() => router.refresh()}
        />
      </PageHeader>

      <StatusStrip />

      <div className="flex-1 overflow-auto">
        <div className="max-w-[1080px] mx-auto px-10 py-8 space-y-9">

          {/* Intro */}
          <div>
            <div className="text-[20px] font-semibold tracking-[-0.01em] text-[#111827]">
              Set up your migration
            </div>
            <p className="text-[13.5px] text-[#6B7280] mt-1.5 leading-relaxed">
              Connect your source data and target schema, add any context, and review the schema.
              Then generate ready-to-load data.
            </p>
          </div>

          {/* Grouped list */}
          <div className="rounded-lg border border-[#E5E7EB] bg-white overflow-hidden divide-y divide-[#F3F4F6]">

            {/* Source system */}
            {!sourceAdded && !sourceStarted ? (
              <ActionRow
                icon={<Database className="w-[15px] h-[15px]" />}
                title="Add source data"
                meta="· CSV, database, or API"
                right={startButton(() => setSourceStarted(true))}
              />
            ) : (
              <CollapsibleRow
                icon={<Database className="w-[15px] h-[15px]" />}
                title={sourceAdded ? (sourceDatasets[0]?.name ?? 'Source system') : 'Add source data'}
                meta={
                  sourceAdded
                    ? `· Source · ${sourceMethod} · ${sourceTableCount} tables · ${sourceFieldCount} fields`
                    : '· CSV, database, or API'
                }
                right={sourceAdded ? connectedBadge('Connected') : undefined}
                defaultOpen={!sourceAdded}
              >
                <div className="pt-2">
                  <IngestionCard
                    type="source"
                    title="Source System"
                    projectId={projectId}
                    initialDatasets={sourceDatasets}
                    initialConnection={sourceConnection}
                    isArchived={isArchived}
                  />
                </div>
                {sourceAdded && (
                  <SchemaDocSection
                    docs={sourceDocs}
                    datasetId={primarySourceDatasetId}
                    projectId={projectId}
                    onDocsChange={setSourceDocs}
                    canEdit={canEdit}
                  />
                )}
              </CollapsibleRow>
            )}

            {/* Target system */}
            {!targetAdded && !targetStarted ? (
              <ActionRow
                icon={<Database className="w-[15px] h-[15px]" />}
                title="Add target schema"
                meta="· DDL / schema file, or system connection"
                right={startButton(() => setTargetStarted(true))}
              />
            ) : (
              <CollapsibleRow
                icon={<Database className="w-[15px] h-[15px]" />}
                title={targetAdded ? (targetDatasets[0]?.name ?? 'Target system') : 'Add target schema'}
                meta={
                  targetAdded
                    ? `· Target · ${targetMethod} · ${targetTableCount} tables · ${targetFieldCount} fields`
                    : '· DDL / schema file, or system connection'
                }
                right={targetAdded ? connectedBadge('Parsed') : undefined}
                defaultOpen={!targetAdded}
              >
                <div className="pt-2">
                  <IngestionCard
                    type="target"
                    title="Target System"
                    projectId={projectId}
                    initialDatasets={targetDatasets}
                    initialConnection={targetConnection}
                    isArchived={isArchived}
                  />
                </div>
                {targetAdded && (
                  <SchemaDocSection
                    docs={targetDocs}
                    datasetId={primaryTargetDatasetId}
                    projectId={projectId}
                    onDocsChange={setTargetDocs}
                    canEdit={canEdit}
                  />
                )}
              </CollapsibleRow>
            )}

            {/* Business context Q&A */}
            <BusinessContextQA
              docs={contextDocs}
              projectId={projectId}
              onDocsChange={setContextDocs}
              canEdit={canEdit}
            />

            {/* Schema review — locked until both systems added */}
            {!bothAdded ? (
              <CollapsibleRow
                icon={<Table2 className="w-[15px] h-[15px]" />}
                title="Review schema"
                meta="· available once both systems are added"
                locked
              />
            ) : (
              <CollapsibleRow
                icon={<Table2 className="w-[15px] h-[15px]" />}
                title="Schema"
                meta={`· ${sourceTableCount} source tables · ${targetTableCount} target tables`}
              >
                <div className="grid grid-cols-2 gap-5">
                  <SchemaColumn
                    projectId={projectId}
                    label={sourceDatasets[0]?.name ?? 'Source'}
                    side="source"
                    tables={sourceTables}
                  />
                  <SchemaColumn
                    projectId={projectId}
                    label={targetDatasets[0]?.name ?? 'Target'}
                    side="target"
                    tables={targetTables}
                  />
                </div>
              </CollapsibleRow>
            )}

          </div>

          {/* Generate footer */}
          <div className="flex items-center justify-between gap-4 rounded-lg border border-[#E5E7EB] bg-[#F9FAFB] px-5 py-3.5">
            <div>
              <label
                className={`inline-flex items-center gap-2.5 ${
                  canReview ? 'cursor-pointer' : 'cursor-not-allowed'
                }`}
              >
                <input
                  type="checkbox"
                  checked={reviewed}
                  disabled={!canReview}
                  onChange={(e) => setReviewed(e.target.checked)}
                  className="w-4 h-4 rounded border-[#D1D5DB] disabled:opacity-50"
                  style={{ accentColor: '#2358D4' }}
                />
                <span
                  className={`text-[13px] ${
                    canReview ? 'text-[#111827]' : 'text-[#9CA3AF]'
                  }`}
                >
                  I&apos;ve reviewed — tables and fields look correct
                </span>
              </label>
              <div
                className={`text-[12.5px] mt-1.5 pl-[26px] ${
                  reviewed ? 'text-[#047857]' : 'text-[#9CA3AF]'
                }`}
              >
                {gateGuidance}
              </div>
            </div>

            <RoleTooltip allowed={canEdit} requiredRole="Editor">
              <button
                type="button"
                disabled={!canGenerate || !canEdit}
                onClick={handleGenerate}
                className={`inline-flex items-center gap-2 rounded-md px-4 py-2 text-[14px] font-medium transition-colors shrink-0 ${
                  canGenerate && canEdit
                    ? 'bg-[#2358D4] hover:bg-[#1E47B3] text-white'
                    : 'bg-[#E5E7EB] text-[#9CA3AF] cursor-not-allowed'
                }`}
              >
                <Sparkles className="w-[15px] h-[15px]" />
                Generate ready-to-load data
              </button>
            </RoleTooltip>
          </div>

        </div>
      </div>
    </div>
  )
}
