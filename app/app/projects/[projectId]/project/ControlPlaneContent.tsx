'use client'

import { useState, useRef, useCallback } from 'react'
import { useRouter } from 'next/navigation'
import { Button } from '@/components/ui/button'
import { FileText, Upload, CheckCircle2, X, AlertCircle, ChevronRight } from '@/components/icons'
import { FileSpreadsheet } from 'lucide-react'
import { IngestionCard } from './IngestionCard'
import { PageHeader } from '@/components/app/PageHeader'
import { type ProjectInfo } from '@/components/app/ProjectInfoPopover'
import { useProjectRole } from '@/lib/hooks/useProjectRole'
import { RoleTooltip } from '@/components/app/RoleTooltip'
import {
  uploadSchemaDocument,
  deleteSchemaDocument,
  uploadBusinessContextDoc,
} from '@/lib/actions/schema-documents'
import type { DatasetWithTableStats } from '@/lib/actions/datasets'
import type { DBConnectionInfo, SchemaDocument } from '@/lib/types/database'

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
  projectInfo?: ProjectInfo
}

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

// ── Reusable doc list ─────────────────────────────────────────────────────────

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
          className="flex items-center justify-between p-2 bg-gray-50 rounded border border-gray-100"
        >
          <div className="flex items-center gap-2 min-w-0">
            {fileIcon(doc.filename)}
            <span className="text-sm text-gray-900 truncate">{doc.filename}</span>
            {doc.file_size && (
              <span className="text-xs text-gray-400 flex-shrink-0">
                {humanFileSize(doc.file_size)}
              </span>
            )}
          </div>
          <div className="flex items-center gap-2 flex-shrink-0 ml-2">
            <CheckCircle2 className="w-4 h-4 text-green-500" />
            <RoleTooltip allowed={canEdit} requiredRole="Editor">
              <button
                onClick={canEdit ? () => onDelete(doc.id) : undefined}
                disabled={!canEdit}
                className="text-gray-400 hover:text-red-500 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
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

// ── Schema doc upload zone (source or target) ─────────────────────────────────

function SchemaDocSection({
  label,
  docs,
  datasetId,
  projectId,
  onDocsChange,
  canEdit = true,
}: {
  label: string
  docs: SchemaDocument[]
  datasetId: string | null
  projectId: string
  onDocsChange: (docs: SchemaDocument[]) => void
  canEdit?: boolean
}) {
  const [state, setState] = useState<DocUploadState>({ uploading: false, error: null, isDragOver: false })
  const fileInputRef = useRef<HTMLInputElement>(null)
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
    <div className="space-y-3">
      <h3 className="text-xs font-medium text-gray-500">{label}</h3>

      <div
        onDrop={(e) => { e.preventDefault(); setState((s) => ({ ...s, isDragOver: false })); const f = e.dataTransfer.files[0]; if (f) doUpload(f) }}
        onDragOver={(e) => { e.preventDefault(); setState((s) => ({ ...s, isDragOver: true })) }}
        onDragLeave={() => setState((s) => ({ ...s, isDragOver: false }))}
        className={`border-[1.5px] border-dashed rounded-lg p-4 text-center transition-colors ${state.isDragOver ? 'border-blue-500 bg-blue-50' : 'border-settle-slate-300 hover:border-settle-slate-400'}`}
      >
        {state.uploading ? (
          <div className="flex flex-col items-center justify-center py-6">
            <div className="flex items-center gap-2.5">
              <div className="w-4 h-4 border-2 border-primary/30 border-t-primary rounded-full animate-spin flex-shrink-0" />
              <span className="text-sm text-gray-700">Uploading {state.filename ?? 'file'}...</span>
            </div>
            <p className="text-xs text-gray-400 mt-1.5 ml-[26px]">
              Processing document · this may take a moment
            </p>
          </div>
        ) : (
          <div className="space-y-1.5">
            <Upload className="w-5 h-5 text-settle-slate-400 mx-auto" />
            <p className="text-xs font-medium text-settle-slate-600">Upload DDL, ERD, or data dictionary files</p>
            <p className="text-[10px] text-settle-slate-400">PDF, SQL, DDL, TXT, PNG, JPG · Max 20MB</p>
            <input ref={fileInputRef} type="file" accept={ACCEPTED} className="hidden"
              onChange={(e) => { const f = e.target.files?.[0]; if (f) doUpload(f); e.target.value = '' }} />
            <RoleTooltip allowed={canEdit} requiredRole="Editor">
              <Button variant="outline" size="sm" type="button"
                onClick={() => fileInputRef.current?.click()} disabled={!datasetId || !canEdit}>
                Upload Files
              </Button>
            </RoleTooltip>
          </div>
        )}
      </div>

      {state.error && (
        <div className="flex items-center gap-2 text-red-600 text-xs">
          <AlertCircle className="w-3 h-3" />{state.error}
        </div>
      )}

      <DocList docs={docs} onDelete={handleDelete} canEdit={canEdit} />
    </div>
  )
}

// ── Business context upload zone (project-scoped, single zone) ────────────────

function BusinessContextSection({
  docs,
  projectId,
  onDocsChange,
  canEdit = true,
}: {
  docs: SchemaDocument[]
  projectId: string
  onDocsChange: (docs: SchemaDocument[]) => void
  canEdit?: boolean
}) {
  const [state, setState] = useState<DocUploadState>({ uploading: false, error: null, isDragOver: false })
  const fileInputRef = useRef<HTMLInputElement>(null)
  const ACCEPTED = '.pdf,.txt,.md,.doc,.docx,.xlsx,.csv,.png,.jpg,.jpeg'

  const doUpload = async (file: File) => {
    setState((s) => ({ ...s, uploading: true, error: null, filename: file.name }))
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
    <div
      onDrop={(e) => { e.preventDefault(); setState((s) => ({ ...s, isDragOver: false })); const f = e.dataTransfer.files[0]; if (f) doUpload(f) }}
      onDragOver={(e) => { e.preventDefault(); setState((s) => ({ ...s, isDragOver: true })) }}
      onDragLeave={() => setState((s) => ({ ...s, isDragOver: false }))}
      className={`border-[1.5px] border-dashed rounded-lg p-4 text-center transition-colors ${state.isDragOver ? 'border-blue-500 bg-blue-50' : 'border-settle-slate-300 hover:border-settle-slate-400'}`}
    >
      {state.uploading ? (
        <div className="flex flex-col items-center justify-center py-6">
          <div className="flex items-center gap-2.5">
            <div className="w-4 h-4 border-2 border-primary/30 border-t-primary rounded-full animate-spin flex-shrink-0" />
            <span className="text-sm text-gray-700">Uploading {state.filename ?? 'file'}...</span>
          </div>
          <p className="text-xs text-gray-400 mt-1.5 ml-[26px]">
            Indexing for AI context · this may take a moment
          </p>
        </div>
      ) : (
        <div className="space-y-1.5">
          <FileText className="w-5 h-5 text-settle-slate-400 mx-auto" />
          <p className="text-xs font-medium text-settle-slate-600">Upload business rules, migration requirements, or other context documents</p>
          <p className="text-[10px] text-settle-slate-400">PDF, DOCX, TXT, MD, XLSX, CSV · Max 20MB</p>
          <input ref={fileInputRef} type="file" accept={ACCEPTED} className="hidden"
            onChange={(e) => { const f = e.target.files?.[0]; if (f) doUpload(f); e.target.value = '' }} />
          <RoleTooltip allowed={canEdit} requiredRole="Editor">
            <Button variant="outline" size="sm" type="button" onClick={() => fileInputRef.current?.click()} disabled={!canEdit}>
              Upload Files
            </Button>
          </RoleTooltip>
        </div>
      )}

      {state.error && (
        <div className="flex items-center justify-center gap-2 text-red-600 text-xs mt-2">
          <AlertCircle className="w-3 h-3" />{state.error}
        </div>
      )}
    </div>
  )
}

// ── CollapsibleSection ────────────────────────────────────────────────────────

function CollapsibleSection({
  id,
  title,
  badge,
  description,
  isOpen,
  onToggle,
  children,
}: {
  id: string
  title: string
  badge?: string
  description?: string
  isOpen: boolean
  onToggle: () => void
  children: React.ReactNode
}) {
  return (
    <div className="bg-white border border-gray-100 rounded-lg overflow-hidden shadow-sm">
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={isOpen}
        aria-controls={`${id}-panel`}
        className="w-full flex items-center gap-2.5 px-4 py-3 text-left hover:bg-settle-slate-50 transition-colors"
      >
        <ChevronRight
          className={`w-3.5 h-3.5 text-settle-slate-400 flex-shrink-0 transition-transform ${
            isOpen ? 'rotate-90' : ''
          }`}
        />
        <span className="text-sm font-semibold text-settle-slate-900">{title}</span>
        {badge && (
          <span className="text-[10px] font-medium text-settle-slate-500 bg-settle-slate-100 px-2 py-0.5 rounded-full">
            {badge}
          </span>
        )}
        {description && (
          <span className="text-[11px] text-settle-slate-400 ml-auto truncate max-w-[50%]">
            {description}
          </span>
        )}
      </button>
      {isOpen && (
        <div id={`${id}-panel`} className="border-t border-gray-100 px-5 pb-5">
          {children}
        </div>
      )}
    </div>
  )
}

// ── Main component ────────────────────────────────────────────────────────────

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
  projectInfo,
}: ControlPlaneContentProps) {
  const { can } = useProjectRole(projectId)
  const canEdit = can('edit')

  const [sourceDocs, setSourceDocs] = useState<SchemaDocument[]>(initialSourceDocs)
  const [targetDocs, setTargetDocs] = useState<SchemaDocument[]>(initialTargetDocs)
  const [contextDocs, setContextDocs] = useState<SchemaDocument[]>(initialContextDocs)

  const router = useRouter()

  const [openSections, setOpenSections] = useState<Set<string>>(
    new Set(['source', 'target', 'schema-docs', 'business-context'])
  )

  const toggleSection = useCallback((id: string) => {
    setOpenSections((prev) => {
      const next = new Set(prev)
      if (next.has(id)) {
        next.delete(id)
      } else {
        next.add(id)
      }
      return next
    })
  }, [])

  const handleDeleteContextDoc = async (docId: string) => {
    const result = await deleteSchemaDocument(docId)
    if (!result.success) {
      console.error('[deleteSchemaDocument]', result.error)
      return
    }
    setContextDocs((prev) => prev.filter((d) => d.id !== docId))
  }

  const sourceTableCount = sourceDatasets.reduce((sum, ds) => sum + ds.tables.length, 0)
  const sourceFieldCount = sourceDatasets.reduce(
    (sum, ds) => sum + ds.tables.reduce((s, t) => s + (t.field_count ?? 0), 0),
    0
  )
  const targetTableCount = targetDatasets.reduce((sum, ds) => sum + ds.tables.length, 0)
  const targetFieldCount = targetDatasets.reduce(
    (sum, ds) => sum + ds.tables.reduce((s, t) => s + (t.field_count ?? 0), 0),
    0
  )
  const sourceBadge = sourceTableCount > 0
    ? `${sourceTableCount} tables · ${sourceFieldCount} fields`
    : undefined
  const targetBadge = targetTableCount > 0
    ? `${targetTableCount} tables · ${targetFieldCount} fields`
    : undefined

  return (
    <div className="flex-1 bg-gray-50 flex flex-col min-h-0">
      <PageHeader
        projectName={projectName}
        title="Project Setup"
        subtitle="Configure source and target system connections"
        projectInfo={projectInfo}
      />
      <div className="flex-1 overflow-auto">
      <div className="px-5 py-4 space-y-3">
        {/* Source / Target systems */}
        <div className={`grid md:grid-cols-2 gap-3 ${
          openSections.has('source') && openSections.has('target')
            ? 'items-stretch'
            : 'items-start'
        }`}>
          <CollapsibleSection
            id="source"
            title="Source system"
            badge={sourceBadge}
            description="Read-only access"
            isOpen={openSections.has('source')}
            onToggle={() => toggleSection('source')}
          >
            <div className="pt-3">
              <IngestionCard
                type="source"
                title="Source System"
                projectId={projectId}
                initialDatasets={sourceDatasets}
                initialConnection={primarySourceDatasetId ? (initialConnections?.[primarySourceDatasetId] ?? null) : null}
                isArchived={isArchived}
              />
            </div>
          </CollapsibleSection>

          <CollapsibleSection
            id="target"
            title="Target system"
            badge={targetBadge}
            isOpen={openSections.has('target')}
            onToggle={() => toggleSection('target')}
          >
            <div className="pt-3">
              <IngestionCard
                type="target"
                title="Target System"
                projectId={projectId}
                initialDatasets={targetDatasets}
                initialConnection={primaryTargetDatasetId ? (initialConnections?.[primaryTargetDatasetId] ?? null) : null}
                isArchived={isArchived}
              />
            </div>
          </CollapsibleSection>
        </div>

        {/* Schema Documentation */}
        <CollapsibleSection
          id="schema-docs"
          title="Schema documentation"
          badge={`${sourceDocs.length + targetDocs.length} files`}
          description="DDL scripts, ERDs, data dictionaries, schema specifications"
          isOpen={openSections.has('schema-docs')}
          onToggle={() => toggleSection('schema-docs')}
        >
          <div className="grid md:grid-cols-2 gap-4 pt-3">
            <SchemaDocSection
              label="Source schema files"
              docs={sourceDocs}
              datasetId={primarySourceDatasetId}
              projectId={projectId}
              onDocsChange={setSourceDocs}
              canEdit={canEdit}
            />
            <SchemaDocSection
              label="Target schema files"
              docs={targetDocs}
              datasetId={primaryTargetDatasetId}
              projectId={projectId}
              onDocsChange={setTargetDocs}
              canEdit={canEdit}
            />
          </div>
        </CollapsibleSection>

        {/* Business Context */}
        <CollapsibleSection
          id="business-context"
          title="Business context & migration rules"
          badge={`${contextDocs.length} files`}
          description="Informs AI reasoning — does not override structural metadata"
          isOpen={openSections.has('business-context')}
          onToggle={() => toggleSection('business-context')}
        >
          <div className="space-y-4 pt-3">
            <BusinessContextSection
              docs={contextDocs}
              projectId={projectId}
              onDocsChange={setContextDocs}
              canEdit={canEdit}
            />
            <DocList docs={contextDocs} onDelete={handleDeleteContextDoc} canEdit={canEdit} />
          </div>
        </CollapsibleSection>

      </div>
      </div>
    </div>
  )
}
