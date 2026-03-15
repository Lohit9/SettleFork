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
        const buffer = Buffer.from(await file.arrayBuffer())
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const pdfParse = require('pdf-parse') as (buf: Buffer) => Promise<{ text: string }>
        const pdfData = await pdfParse(buffer)
        extractedText = pdfData.text?.trim() || null
      } else if (['.sql', '.ddl', '.txt'].includes(ext)) {
        extractedText = (await file.text()).trim() || null
      }
      // .doc/.docx: deferred (no parser in MVP)
      // .png/.jpg/.jpeg: OCR deferred
    } catch (parseErr) {
      // Non-fatal — still save the file, just without extracted text
      console.error('[uploadSchemaDocument] text extraction failed:', parseErr)
    }

    // Create DB record
    const { data: doc, error: dbError } = await supabase
      .from('schema_documents')
      .insert({
        dataset_id: datasetId,
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
    .order('created_at', { ascending: true })

  if (error) throw new Error(error.message)
  return (data || []) as SchemaDocument[]
}
