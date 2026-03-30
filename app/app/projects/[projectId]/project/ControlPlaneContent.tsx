'use client'

import { useState, useRef } from 'react'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { FileText, Upload, CheckCircle2, X, AlertCircle } from '@/components/icons'
import { IngestionCard } from './IngestionCard'
import { PageHeader } from '@/components/app/PageHeader'
import {
  uploadSchemaDocument,
  deleteSchemaDocument,
  uploadBusinessContextDoc,
} from '@/lib/actions/schema-documents'
import type { DatasetWithTableStats } from '@/lib/actions/datasets'
import type { SchemaDocument } from '@/lib/types/database'

interface DocUploadState {
  uploading: boolean
  error: string | null
  isDragOver: boolean
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
}

function humanFileSize(bytes: number | null): string {
  if (!bytes) return ''
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

function fileIcon(filename: string): React.ReactNode {
  const ext = filename.toLowerCase().split('.').pop()
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
}: {
  docs: SchemaDocument[]
  onDelete: (id: string) => void
}) {
  if (docs.length === 0) return null
  return (
    <div className="space-y-2 mt-3">
      {docs.map((doc) => (
        <div
          key={doc.id}
          className="flex items-center justify-between p-2 bg-gray-50 rounded border border-gray-200"
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
            <button
              onClick={() => onDelete(doc.id)}
              className="text-gray-400 hover:text-red-500 transition-colors"
              title="Delete"
            >
              <X className="w-4 h-4" />
            </button>
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
}: {
  label: string
  docs: SchemaDocument[]
  datasetId: string | null
  projectId: string
  onDocsChange: (docs: SchemaDocument[]) => void
}) {
  const [state, setState] = useState<DocUploadState>({ uploading: false, error: null, isDragOver: false })
  const fileInputRef = useRef<HTMLInputElement>(null)
  const ACCEPTED = '.pdf,.ddl,.sql,.txt,.doc,.docx,.png,.jpg,.jpeg'

  const doUpload = async (file: File) => {
    if (!datasetId) return
    setState((s) => ({ ...s, uploading: true, error: null }))
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
    try {
      await deleteSchemaDocument(docId)
      onDocsChange(docs.filter((d) => d.id !== docId))
    } catch (err) {
      console.error('[deleteSchemaDocument]', err)
    }
  }

  return (
    <div className="space-y-3">
      <h3 className="text-sm font-semibold text-gray-900">{label}</h3>

      <div
        onDrop={(e) => { e.preventDefault(); setState((s) => ({ ...s, isDragOver: false })); const f = e.dataTransfer.files[0]; if (f) doUpload(f) }}
        onDragOver={(e) => { e.preventDefault(); setState((s) => ({ ...s, isDragOver: true })) }}
        onDragLeave={() => setState((s) => ({ ...s, isDragOver: false }))}
        className={`border-2 border-dashed rounded-lg p-5 text-center transition-colors ${state.isDragOver ? 'border-indigo-500 bg-indigo-50' : 'border-gray-300 hover:border-gray-400'}`}
      >
        {state.uploading ? (
          <div className="space-y-1">
            <svg className="animate-spin w-6 h-6 text-indigo-600 mx-auto" fill="none" viewBox="0 0 24 24">
              <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
              <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v4l3-3-3-3v4a8 8 0 00-8 8h4z" />
            </svg>
            <p className="text-xs text-gray-500">Uploading…</p>
          </div>
        ) : (
          <div className="space-y-1.5">
            <Upload className="w-6 h-6 text-gray-400 mx-auto" />
            <p className="text-xs text-gray-500">Upload DDL, ERD, or data dictionary files</p>
            <p className="text-xs text-gray-400">PDF, SQL, DDL, TXT, PNG, JPG · Max 20MB</p>
            <input ref={fileInputRef} type="file" accept={ACCEPTED} className="hidden"
              onChange={(e) => { const f = e.target.files?.[0]; if (f) doUpload(f); e.target.value = '' }} />
            <Button variant="outline" size="sm" type="button"
              onClick={() => fileInputRef.current?.click()} disabled={!datasetId}>
              Upload Files
            </Button>
          </div>
        )}
      </div>

      {state.error && (
        <div className="flex items-center gap-2 text-red-600 text-xs">
          <AlertCircle className="w-3 h-3" />{state.error}
        </div>
      )}

      <DocList docs={docs} onDelete={handleDelete} />
    </div>
  )
}

// ── Business context upload zone (project-scoped, single zone) ────────────────

function BusinessContextSection({
  docs,
  projectId,
  onDocsChange,
}: {
  docs: SchemaDocument[]
  projectId: string
  onDocsChange: (docs: SchemaDocument[]) => void
}) {
  const [state, setState] = useState<DocUploadState>({ uploading: false, error: null, isDragOver: false })
  const fileInputRef = useRef<HTMLInputElement>(null)
  const ACCEPTED = '.pdf,.txt,.doc,.docx,.xlsx,.csv,.png,.jpg,.jpeg'

  const doUpload = async (file: File) => {
    setState((s) => ({ ...s, uploading: true, error: null }))
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
    try {
      await deleteSchemaDocument(docId)
      onDocsChange(docs.filter((d) => d.id !== docId))
    } catch (err) {
      console.error('[deleteSchemaDocument]', err)
    }
  }

  return (
    <div
      onDrop={(e) => { e.preventDefault(); setState((s) => ({ ...s, isDragOver: false })); const f = e.dataTransfer.files[0]; if (f) doUpload(f) }}
      onDragOver={(e) => { e.preventDefault(); setState((s) => ({ ...s, isDragOver: true })) }}
      onDragLeave={() => setState((s) => ({ ...s, isDragOver: false }))}
      className={`border-2 border-dashed rounded-lg p-6 text-center transition-colors ${state.isDragOver ? 'border-violet-500 bg-violet-50' : 'border-gray-300 hover:border-gray-400'}`}
    >
      {state.uploading ? (
        <div className="space-y-1">
          <svg className="animate-spin w-6 h-6 text-violet-600 mx-auto" fill="none" viewBox="0 0 24 24">
            <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
            <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v4l3-3-3-3v4a8 8 0 00-8 8h4z" />
          </svg>
          <p className="text-xs text-gray-500">Uploading…</p>
        </div>
      ) : (
        <div className="space-y-1.5">
          <FileText className="w-6 h-6 text-gray-400 mx-auto" />
          <p className="text-xs text-gray-600">Upload business rules, migration requirements, or other context documents</p>
          <p className="text-xs text-gray-400">PDF, DOCX, TXT, XLSX, CSV · Max 20MB</p>
          <input ref={fileInputRef} type="file" accept={ACCEPTED} className="hidden"
            onChange={(e) => { const f = e.target.files?.[0]; if (f) doUpload(f); e.target.value = '' }} />
          <Button variant="outline" size="sm" type="button" onClick={() => fileInputRef.current?.click()}>
            Upload Files
          </Button>
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
}: ControlPlaneContentProps) {
  const [sourceDocs, setSourceDocs] = useState<SchemaDocument[]>(initialSourceDocs)
  const [targetDocs, setTargetDocs] = useState<SchemaDocument[]>(initialTargetDocs)
  const [contextDocs, setContextDocs] = useState<SchemaDocument[]>(initialContextDocs)

  const handleDeleteContextDoc = async (docId: string) => {
    try {
      await deleteSchemaDocument(docId)
      setContextDocs((prev) => prev.filter((d) => d.id !== docId))
    } catch (err) {
      console.error('[deleteSchemaDocument]', err)
    }
  }

  return (
    <div className="flex-1 bg-gray-50 flex flex-col min-h-0">
      <PageHeader
        projectName={projectName}
        title="Project Setup"
        subtitle="Configure source and target system connections"
      />
      <div className="flex-1 overflow-auto p-8">
      <div className="max-w-6xl mx-auto space-y-8">
        {/* Data Ingestion */}
        <div className="space-y-4">
          <h2 className="text-lg font-semibold text-gray-900">Data Ingestion</h2>
          <div className="grid md:grid-cols-2 gap-6">
            <IngestionCard type="source" title="Source Schema" projectId={projectId} initialDatasets={sourceDatasets} />
            <IngestionCard type="target" title="Target Schema" projectId={projectId} initialDatasets={targetDatasets} />
          </div>
        </div>

        {/* Schema Documentation */}
        <Card>
          <CardHeader>
            <CardTitle>Schema Documentation</CardTitle>
            <p className="text-sm text-gray-500">
              DDL scripts, ERDs, data dictionaries, and schema specifications. Used to verify and
              enrich inferred schemas — these are the authoritative source for structural metadata.
            </p>
          </CardHeader>
          <CardContent>
            <div className="grid md:grid-cols-2 gap-8">
              <SchemaDocSection
                label="Source Schema Files"
                docs={sourceDocs}
                datasetId={primarySourceDatasetId}
                projectId={projectId}
                onDocsChange={setSourceDocs}
              />
              <SchemaDocSection
                label="Target Schema Files"
                docs={targetDocs}
                datasetId={primaryTargetDatasetId}
                projectId={projectId}
                onDocsChange={setTargetDocs}
              />
            </div>
          </CardContent>
        </Card>

        {/* Business Context */}
        <Card>
          <CardHeader>
            <CardTitle>Business Context &amp; Migration Rules</CardTitle>
            <p className="text-sm text-gray-500">
              Migration requirements, business rules, value mappings, and stakeholder specifications.
              Used to improve mapping and transformation accuracy — these inform AI reasoning but do
              not override structural schema metadata.
            </p>
          </CardHeader>
          <CardContent className="space-y-4">
            <BusinessContextSection
              docs={contextDocs}
              projectId={projectId}
              onDocsChange={setContextDocs}
            />
            <DocList docs={contextDocs} onDelete={handleDeleteContextDoc} />
          </CardContent>
        </Card>
      </div>
      </div>
    </div>
  )
}
