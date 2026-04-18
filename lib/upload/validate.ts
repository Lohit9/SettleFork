export interface CSVValidationResult {
  valid: boolean
  reason?: string
  sanitizedFilename?: string
}

export function validateCSVUpload(file: File): CSVValidationResult {
  if (file.size > 10 * 1024 * 1024) {
    return { valid: false, reason: 'File exceeds 10MB limit' }
  }

  const allowedTypes = ['text/csv', 'application/vnd.ms-excel', 'text/plain', 'application/csv']
  const hasValidType = allowedTypes.includes(file.type) || file.name.toLowerCase().endsWith('.csv')
  if (!hasValidType) {
    return { valid: false, reason: 'Only CSV files are accepted (.csv)' }
  }

  if (file.name.includes('../') || file.name.includes('/') || file.name.includes('\\')) {
    return { valid: false, reason: 'Invalid filename: path traversal not allowed' }
  }

  const dotIdx = file.name.lastIndexOf('.')
  const basename = dotIdx >= 0 ? file.name.slice(0, dotIdx) : file.name
  const ext = dotIdx >= 0 ? file.name.slice(dotIdx) : '.csv'
  const sanitized = basename.replace(/\s+/g, '_').replace(/[^a-zA-Z0-9._-]/g, '_')
  const sanitizedFilename = sanitized + ext

  return { valid: true, sanitizedFilename }
}

export interface SchemaDocValidationResult {
  valid: boolean
  reason?: string
  sanitizedFilename?: string
}

export function validateSchemaDocUpload(file: File): SchemaDocValidationResult {
  if (file.size > 20 * 1024 * 1024) {
    return { valid: false, reason: 'File exceeds 20MB limit' }
  }

  // .xlsx/.xls/.xlsb and .csv accept Excel / CSV schema exports: these go
  // through AI-powered DDL conversion (lib/ai/ddl-conversion.ts) on the
  // server, since parseDDL won't recognise a spreadsheet directly.
  const allowedExtensions = [
    '.pdf',
    '.ddl',
    '.sql',
    '.txt',
    '.doc',
    '.docx',
    '.xlsx',
    '.xls',
    '.xlsb',
    '.csv',
    '.png',
    '.jpg',
    '.jpeg',
  ]
  const ext = file.name.toLowerCase().match(/\.[^.]+$/)?.[0]
  if (!ext || !allowedExtensions.includes(ext)) {
    return {
      valid: false,
      reason: `File type not allowed. Accepted: ${allowedExtensions.join(', ')}`,
    }
  }

  if (file.name.includes('../') || file.name.includes('/') || file.name.includes('\\')) {
    return { valid: false, reason: 'Invalid filename: path traversal not allowed' }
  }

  const dotIdx = file.name.lastIndexOf('.')
  const basename = dotIdx >= 0 ? file.name.slice(0, dotIdx) : file.name
  const sanitized = basename.replace(/\s+/g, '_').replace(/[^a-zA-Z0-9._-]/g, '_')
  const sanitizedFilename = sanitized + ext

  return { valid: true, sanitizedFilename }
}
