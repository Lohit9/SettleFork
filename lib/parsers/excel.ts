import * as XLSX from 'xlsx'

const MAX_CHARS = 100_000
const TRUNCATION_SUFFIX = '\n[Truncated — content exceeds 100K character limit for AI context]'

/**
 * Convert an Excel workbook buffer into a structured plain-text representation
 * suitable for injection into Claude prompts.
 *
 * Each sheet is emitted as:
 *   --- Sheet: {name} ---
 *   col1 | col2 | col3
 *   ---
 *   val1 | val2 | val3
 *   ...
 *
 * Returns an error string (not a throw) if the file is unreadable.
 */
export function parseExcelToText(buffer: Buffer): string {
  let workbook: XLSX.WorkBook
  try {
    workbook = XLSX.read(buffer, { type: 'buffer' })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return `[Excel parsing failed: ${msg}]`
  }

  const sections: string[] = []

  for (const sheetName of workbook.SheetNames) {
    const sheet = workbook.Sheets[sheetName]
    if (!sheet) continue

    // sheet_to_json with header:1 gives us an array of arrays
    const rows = XLSX.utils.sheet_to_json<unknown[]>(sheet, {
      header: 1,
      defval: '',
    })

    // Filter completely blank rows
    const nonEmptyRows = rows.filter((row) =>
      row.some((cell) => String(cell ?? '').trim() !== '')
    )
    if (nonEmptyRows.length === 0) continue

    const lines: string[] = [`--- Sheet: ${sheetName} ---`]

    // Detect header row heuristic:
    // First row is treated as a header if it has no empty cells and there are
    // at least 2 data rows below it with a similar column count.
    const firstRow = nonEmptyRows[0]
    const firstRowHasAllCells =
      firstRow.length > 0 &&
      firstRow.every((cell) => String(cell ?? '').trim() !== '')
    const dataRows = nonEmptyRows.slice(1)
    const hasDataRows = dataRows.length >= 1
    const isHeader = firstRowHasAllCells && hasDataRows

    const formatRow = (row: unknown[]) =>
      row.map((cell) => String(cell ?? '').trim()).join(' | ')

    if (isHeader) {
      lines.push(formatRow(firstRow))
      lines.push('---')
      for (const row of dataRows) {
        lines.push(formatRow(row))
      }
    } else {
      for (const row of nonEmptyRows) {
        lines.push(formatRow(row))
      }
    }

    sections.push(lines.join('\n'))
  }

  if (sections.length === 0) {
    return '[Excel file contained no readable data]'
  }

  const result = sections.join('\n\n')

  if (result.length > MAX_CHARS) {
    return result.slice(0, MAX_CHARS) + TRUNCATION_SUFFIX
  }

  return result
}
