'use client'

import { useState, useRef } from 'react'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { FileText, Upload, CheckCircle2, X, AlertCircle } from '@/components/icons'
import { IngestionCard } from './IngestionCard'
import { uploadSchemaDocument, deleteSchemaDocument } from '@/lib/actions/schema-documents'
import type { DatasetWithTableStats } from '@/lib/actions/datasets'
import type { SchemaDocument } from '@/lib/types/database'

interface SchemaDocUploadState {
  uploading: boolean
  error: string | null
  isDragOver: boolean
}

interface ControlPlaneContentProps {
  projectId: string
  sourceDatasets: DatasetWithTableStats[]
  targetDatasets: DatasetWithTableStats[]
  initialSourceDocs: SchemaDocument[]
  initialTargetDocs: SchemaDocument[]
  // dataset IDs used as the schema doc target (first of each role)
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
  const [state, setState] = useState<SchemaDocUploadState>({
    uploading: false,
    error: null,
    isDragOver: false,
  })
  const fileInputRef = useRef<HTMLInputElement>(null)
  const ACCEPTED = '.pdf,.ddl,.sql,.txt,.doc,.docx,.png,.jpg,.jpeg'

  const doUpload = async (file: File) => {
    if (!datasetId) return
    setState((s) => ({ ...s, uploading: true, error: null }))
    const formData = new FormData()
    formData.append('file', file)
    formData.append('projectId', projectId)
    formData.append('datasetId', datasetId)
    const result = await uploadSchemaDocument(formData)
    if (result.success && result.documentId) {
      // Add optimistic entry; real data has correct id
      const newDoc: SchemaDocument = {
        id: result.documentId,
        dataset_id: datasetId,
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

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (file) doUpload(file)
    e.target.value = ''
  }

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault()
    setState((s) => ({ ...s, isDragOver: false }))
    const file = e.dataTransfer.files[0]
    if (file) doUpload(file)
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
    <div className="space-y-4">
      <h3 className="text-sm font-semibold text-gray-900">{label}</h3>

      <div
        onDrop={handleDrop}
        onDragOver={(e) => { e.preventDefault(); setState((s) => ({ ...s, isDragOver: true })) }}
        onDragLeave={() => setState((s) => ({ ...s, isDragOver: false }))}
        className={`border-2 border-dashed rounded-lg p-6 text-center transition-colors ${
          state.isDragOver
            ? 'border-[#4F46E5] bg-indigo-50'
            : 'border-gray-300 hover:border-gray-400'
        }`}
      >
        <div className="space-y-2">
          {state.uploading ? (
            <>
              <svg className="animate-spin w-7 h-7 text-[#4F46E5] mx-auto" fill="none" viewBox="0 0 24 24">
                <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v4l3-3-3-3v4a8 8 0 00-8 8h4z" />
              </svg>
              <p className="text-xs text-gray-500">Uploading…</p>
            </>
          ) : (
            <>
              <Upload className="w-7 h-7 text-gray-400 mx-auto" />
              <p className="text-xs text-gray-500">Upload DDL, ERD, or documentation</p>
              <p className="text-xs text-gray-400">PDF, SQL, DDL, TXT, DOC, DOCX, PNG, JPG · Max 20MB</p>
              <input
                ref={fileInputRef}
                type="file"
                accept={ACCEPTED}
                className="hidden"
                onChange={handleFileChange}
              />
              <Button
                variant="outline"
                size="sm"
                type="button"
                onClick={() => fileInputRef.current?.click()}
                disabled={!datasetId}
              >
                Upload Files
              </Button>
            </>
          )}
        </div>
      </div>

      {state.error && (
        <div className="flex items-center gap-2 text-red-600 text-xs">
          <AlertCircle className="w-3 h-3" />
          {state.error}
        </div>
      )}

      {docs.length > 0 && (
        <div className="space-y-2">
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
                  onClick={() => handleDelete(doc.id)}
                  className="text-gray-400 hover:text-red-500 transition-colors"
                  title="Delete"
                >
                  <X className="w-4 h-4" />
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

export function ControlPlaneContent({
  projectId,
  sourceDatasets,
  targetDatasets,
  initialSourceDocs,
  initialTargetDocs,
  primarySourceDatasetId,
  primaryTargetDatasetId,
}: ControlPlaneContentProps) {
  const [sourceDocs, setSourceDocs] = useState<SchemaDocument[]>(initialSourceDocs)
  const [targetDocs, setTargetDocs] = useState<SchemaDocument[]>(initialTargetDocs)

  return (
    <div className="flex-1 bg-gray-50 p-8">
      <div className="max-w-6xl mx-auto space-y-8">
        {/* Page Header */}
        <div>
          <h1 className="text-2xl font-semibold text-gray-900 mb-1">Control Plane</h1>
          <p className="text-sm text-gray-500">Configure source and target system connections</p>
        </div>

        {/* Data Ingestion */}
        <div className="space-y-4">
          <h2 className="text-lg font-semibold text-gray-900">Data Ingestion</h2>
          <div className="grid md:grid-cols-2 gap-6">
            <IngestionCard
              type="source"
              title="Source Schema"
              projectId={projectId}
              initialDatasets={sourceDatasets}
            />
            <IngestionCard
              type="target"
              title="Target Schema"
              projectId={projectId}
              initialDatasets={targetDatasets}
            />
          </div>
        </div>

        {/* Schema Documents */}
        <Card>
          <CardHeader>
            <CardTitle>Schema Documents</CardTitle>
            <p className="text-sm text-gray-500">
              Upload DDL scripts, ERD diagrams, or documentation to provide additional context.
              Text content is extracted and used for AI-assisted mapping.
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
      </div>
    </div>
  )
}
