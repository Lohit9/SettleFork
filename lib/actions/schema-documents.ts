'use server'

import { createClient } from '@/lib/supabase/server'
import { SchemaDocument } from '@/lib/types/database'
import { validateSchemaDocUpload } from '@/lib/upload/validate'

export interface UploadSchemaDocResult {
  success: boolean
  documentId?: string
  error?: string
}

export async function uploadSchemaDocument(formData: FormData): Promise<UploadSchemaDocResult> {
  try {
    const supabase = await createClient()
    const {
      data: { user },
    } = await supabase.auth.getUser()
    if (!user) return { success: false, error: 'Not authenticated' }

    const file = formData.get('file') as File
    const projectId = formData.get('projectId') as string
    const datasetId = formData.get('datasetId') as string

    if (!file || !projectId || !datasetId) {
      return { success: false, error: 'Missing required fields' }
    }

    const validation = validateSchemaDocUpload(file)
    if (!validation.valid) return { success: false, error: validation.reason }

    const sanitizedFilename = validation.sanitizedFilename ?? file.name
    const storagePath = `${user.id}/${projectId}/schemas/${sanitizedFilename}`

    // Upload to storage
    const { error: storageError } = await supabase.storage
      .from('project-files')
      .upload(storagePath, file, { upsert: true })

    if (storageError) {
      return { success: false, error: 'Storage upload failed: ' + storageError.message }
    }

    // Extract text content for text-based formats
    let extractedText: string | null = null
    const ext = sanitizedFilename.toLowerCase().match(/\.[^.]+$/)?.[0] ?? ''

    try {
      if (ext === '.pdf') {
        // pdf-parse is a CJS module; .default may not appear in TypeScript typings
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const pdfParseModule = await import('pdf-parse') as any
        const pdfParse: (buf: Buffer) => Promise<{ text: string }> = pdfParseModule.default ?? pdfParseModule
        const buffer = Buffer.from(await file.arrayBuffer())
        const pdfData = await pdfParse(buffer)
        extractedText = pdfData.text?.trim() || null
        if (!extractedText) {
          console.warn('[uploadSchemaDocument] No text extracted from PDF (may be scanned/image-only):', sanitizedFilename)
        }
      } else if (['.sql', '.ddl', '.txt'].includes(ext)) {
        extractedText = (await file.text()).trim() || null
      }
      // .doc/.docx: deferred (no parser in MVP)
      // .png/.jpg/.jpeg: OCR deferred
    } catch (parseErr) {
      // Non-fatal — still save the file, just without extracted text
      console.error('[uploadSchemaDocument] text extraction failed:', parseErr)
    }

    // Create DB record — schema docs are dataset-scoped, doc_type = 'schema'
    const { data: doc, error: dbError } = await supabase
      .from('schema_documents')
      .insert({
        dataset_id: datasetId,
        project_id: null,
        doc_type: 'schema',
        filename: sanitizedFilename,
        file_size: file.size,
        file_storage_path: storagePath,
        extracted_text: extractedText,
      })
      .select()
      .single()

    if (dbError || !doc) {
      // Clean up storage if DB insert fails
      await supabase.storage.from('project-files').remove([storagePath])
      return { success: false, error: dbError?.message || 'Failed to create document record' }
    }

    // Trigger schema enrichment for all existing tables in this dataset
    // Fire-and-forget: a newly uploaded doc with no extracted text won't enrich anything
    if (extractedText) {
      try {
        const { enrichAllTablesInDataset } = await import('@/lib/actions/schema-enrichment')
        const result = await enrichAllTablesInDataset(datasetId)
        if (result.totalCorrections > 0) {
          console.log(`[schema-documents] Enrichment: ${result.totalCorrections} field(s) corrected across ${result.tableCount} table(s)`)
        }
      } catch (enrichErr) {
        console.warn('[schema-documents] Schema enrichment failed (non-fatal):', enrichErr)
      }
    }

    return { success: true, documentId: doc.id }
  } catch (err) {
    console.error('[uploadSchemaDocument]', err)
    return {
      success: false,
      error: err instanceof Error ? err.message : 'An unexpected error occurred',
    }
  }
}

export async function deleteSchemaDocument(documentId: string): Promise<void> {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) throw new Error('Not authenticated')

  const { data: doc } = await supabase
    .from('schema_documents')
    .select('file_storage_path')
    .eq('id', documentId)
    .single()

  if (!doc) throw new Error('Document not found')

  // Delete from storage
  await supabase.storage.from('project-files').remove([doc.file_storage_path])

  // Delete DB record (RLS ensures user owns it)
  const { error } = await supabase.from('schema_documents').delete().eq('id', documentId)
  if (error) throw new Error(error.message)
}

export async function getSchemaDocuments(datasetId: string): Promise<SchemaDocument[]> {
  const supabase = await createClient()
  const { data, error } = await supabase
    .from('schema_documents')
    .select('*')
    .eq('dataset_id', datasetId)
    .eq('doc_type', 'schema')
    .order('created_at', { ascending: true })

  if (error) throw new Error(error.message)
  return (data || []) as SchemaDocument[]
}

// ── Business Context Documents ─────────────────────────────────────────────────

export interface UploadBusinessContextResult {
  success: boolean
  documentId?: string
  error?: string
}

export async function uploadBusinessContextDoc(
  formData: FormData
): Promise<UploadBusinessContextResult> {
  try {
    const supabase = await createClient()
    const {
      data: { user },
    } = await supabase.auth.getUser()
    if (!user) return { success: false, error: 'Not authenticated' }

    const file = formData.get('file') as File
    const projectId = formData.get('projectId') as string

    if (!file || !projectId) return { success: false, error: 'Missing required fields' }

    // Verify project ownership
    const { data: project } = await supabase
      .from('projects')
      .select('id')
      .eq('id', projectId)
      .eq('user_id', user.id)
      .single()
    if (!project) return { success: false, error: 'Project not found or access denied' }

    // Validate file size (20 MB limit)
    const MAX_BYTES = 20 * 1024 * 1024
    if (file.size > MAX_BYTES) return { success: false, error: 'File exceeds 20 MB limit' }

    const sanitizedFilename = file.name.replace(/[^a-zA-Z0-9._\-() ]/g, '_').trim() || 'document'
    const storagePath = `${user.id}/${projectId}/context/${sanitizedFilename}`

    const { error: storageError } = await supabase.storage
      .from('project-files')
      .upload(storagePath, file, { upsert: true })
    if (storageError) return { success: false, error: 'Storage upload failed: ' + storageError.message }

    // Extract text for supported formats
    let extractedText: string | null = null
    const ext = sanitizedFilename.toLowerCase().match(/\.[^.]+$/)?.[0] ?? ''
    try {
      if (ext === '.pdf') {
        // pdf-parse is a CJS module; .default may not appear in TypeScript typings
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const pdfParseModule = await import('pdf-parse') as any
        const pdfParse: (buf: Buffer) => Promise<{ text: string }> = pdfParseModule.default ?? pdfParseModule
        const buffer = Buffer.from(await file.arrayBuffer())
        const pdfData = await pdfParse(buffer)
        extractedText = pdfData.text?.trim() || null
        if (!extractedText) {
          console.warn('[uploadBusinessContextDoc] No text extracted from PDF (may be scanned/image-only):', sanitizedFilename)
        }
      } else if (['.sql', '.ddl', '.txt', '.csv'].includes(ext)) {
        extractedText = (await file.text()).trim() || null
      }
      // .xlsx, .docx, .png, .jpg: text extraction deferred
    } catch (parseErr) {
      console.error('[uploadBusinessContextDoc] text extraction failed:', parseErr)
    }

    const { data: doc, error: dbError } = await supabase
      .from('schema_documents')
      .insert({
        dataset_id: null,
        project_id: projectId,
        doc_type: 'business_context',
        filename: sanitizedFilename,
        file_size: file.size,
        file_storage_path: storagePath,
        extracted_text: extractedText,
      })
      .select()
      .single()

    if (dbError || !doc) {
      await supabase.storage.from('project-files').remove([storagePath])
      return { success: false, error: dbError?.message || 'Failed to create document record' }
    }

    return { success: true, documentId: doc.id }
  } catch (err) {
    console.error('[uploadBusinessContextDoc]', err)
    return {
      success: false,
      error: err instanceof Error ? err.message : 'An unexpected error occurred',
    }
  }
}

export async function getBusinessContextDocs(projectId: string): Promise<SchemaDocument[]> {
  const supabase = await createClient()
  const { data, error } = await supabase
    .from('schema_documents')
    .select('*')
    .eq('project_id', projectId)
    .eq('doc_type', 'business_context')
    .order('created_at', { ascending: true })

  if (error) throw new Error(error.message)
  return (data || []) as SchemaDocument[]
}
