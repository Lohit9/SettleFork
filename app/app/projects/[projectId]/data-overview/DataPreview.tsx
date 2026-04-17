'use client'

import { useState, useEffect, useMemo } from 'react'
import { useRouter } from 'next/navigation'
import { getDataPreview, getTargetFieldConstraints, getStagedParentValues } from '@/lib/actions/data-overview'
import { getStagedMappings, getStagedDataPreview, checkStagingFreshness, stageAllData } from '@/lib/actions/staging'
import type { TableOption, TargetFieldConstraint } from '@/lib/actions/data-overview'
import type { StagedMappingOption } from '@/lib/actions/staging'
import { AlertTriangle } from '@/components/icons'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'

interface DataPreviewProps {
  projectId: string
  tables: TableOption[]
  isArchived?: boolean
  archivedAt?: string | null
  initialSelectedTableId?: string
}

const PAGE_SIZE = 10

export default function DataPreview({ projectId, tables, isArchived = false, archivedAt, initialSelectedTableId }: DataPreviewProps) {
  const router = useRouter()

  // ── View mode ──────────────────────────────────────────────────────────────
  const [viewMode, setViewMode] = useState<'source' | 'transformed'>('source')

  // Source Data tab only shows tables from source datasets (target tables have 0 rows)
  const sourceTables = tables.filter((t) => t.role === 'source')

  // ── Source mode state ──────────────────────────────────────────────────────
  const [selectedTableId, setSelectedTableId] = useState<string>(
    initialSelectedTableId ?? sourceTables[0]?.id ?? ''
  )
  const [page, setPage] = useState(1)
  const [rows, setRows] = useState<Record<string, unknown>[]>([])
  const [totalRows, setTotalRows] = useState(0)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // ── Transformed mode state ─────────────────────────────────────────────────
  const [stagedMappings, setStagedMappings] = useState<StagedMappingOption[]>([])
  const [stagedMappingsLoading, setStagedMappingsLoading] = useState(false)
  const [selectedMappingId, setSelectedMappingId] = useState<string>('')
  const [stagedPage, setStagedPage] = useState(1)
  const [stagedRows, setStagedRows] = useState<Record<string, unknown>[]>([])
  const [stagedTotal, setStagedTotal] = useState(0)
  const [stagedLoading, setStagedLoading] = useState(false)
  const [stagedError, setStagedError] = useState<string | null>(null)
  /** Target field names that have an applied transformation (from transformations table) */
  const [stagedFields, setStagedFields] = useState<string[]>([])
  /** Target field constraints for live constraint checking in the staged view */
  const [targetFieldConstraints, setTargetFieldConstraints] = useState<TargetFieldConstraint[]>([])
  /**
   * Valid FK parent values keyed by target field name.
   * Only populated for FK fields whose parent table has been staged.
   * If a field name is missing from this map, FK checking is skipped for it.
   */
  const [validFKValues, setValidFKValues] = useState<Map<string, Set<string>>>(new Map())
  /** Staleness info for the selected mapping */
  const [stalenessInfo, setStalenessInfo] = useState<{
    isStale: boolean
    sourceModifiedAt: string | null
    stagedAt: string | null
  } | null>(null)
  const [isRegenerating, setIsRegenerating] = useState(false)

  const selectedTable = sourceTables.find((t) => t.id === selectedTableId)

  // ── Source data fetching ───────────────────────────────────────────────────
  useEffect(() => {
    if (viewMode === 'source' && selectedTableId) {
      setPage(1)
      fetchSourcePage(selectedTableId, 1)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedTableId, viewMode])

  async function fetchSourcePage(tableId: string, p: number) {
    setLoading(true)
    setError(null)
    try {
      const result = await getDataPreview(tableId, p, PAGE_SIZE)
      setRows(result.rows)
      setTotalRows(result.totalRows)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load data')
    } finally {
      setLoading(false)
    }
  }

  function goToPage(p: number) {
    setPage(p)
    fetchSourcePage(selectedTableId, p)
  }

  // ── Transformed data fetching ──────────────────────────────────────────────
  useEffect(() => {
    if (viewMode === 'transformed') {
      setStagedMappingsLoading(true)
      getStagedMappings(projectId).then((mappings) => {
        setStagedMappings(mappings)
        if (mappings.length > 0 && !selectedMappingId) {
          setSelectedMappingId(mappings[0].tableMappingId)
        }
        setStagedMappingsLoading(false)
      })
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [viewMode])

  useEffect(() => {
    if (viewMode === 'transformed' && selectedMappingId) {
      setStagedPage(1)
      setStalenessInfo(null)
      fetchStagedPage(selectedMappingId, 1)
      checkStagingFreshness(selectedMappingId).then(setStalenessInfo).catch(() => {})
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedMappingId, viewMode])

  // Fetch target field constraints whenever the selected mapping or staged mappings change.
  // This runs client-side: once we know the targetTableId for the selected mapping we
  // pull the field-level nullability and CHECK constraint metadata for the staged view.
  useEffect(() => {
    if (!selectedMappingId || !stagedMappings.length) {
      setTargetFieldConstraints([])
      return
    }
    const mapping = stagedMappings.find((m) => m.tableMappingId === selectedMappingId)
    if (!mapping?.targetTableId) {
      setTargetFieldConstraints([])
      return
    }
    getTargetFieldConstraints(mapping.targetTableId)
      .then(setTargetFieldConstraints)
      .catch(() => setTargetFieldConstraints([]))
  }, [selectedMappingId, stagedMappings])

  // Pre-load valid FK parent values for each FK field in the current target table.
  // This runs once per mapping selection and feeds the DataTable's FK integrity check.
  useEffect(() => {
    const fkFields = targetFieldConstraints.filter(
      (f) => f.is_foreign_key && f.fk_reference
    )

    if (fkFields.length === 0) {
      setValidFKValues(new Map())
      return
    }

    async function loadFKValues() {
      const newMap = new Map<string, Set<string>>()

      await Promise.all(
        fkFields.map(async (field) => {
          // fk_reference format: "TABLE_NAME.field_name"
          const [parentTableName, parentFieldName] = (field.fk_reference ?? '').split('.')
          if (!parentTableName || !parentFieldName) return

          const values = await getStagedParentValues(
            projectId,
            parentTableName,
            parentFieldName
          ).catch(() => [] as string[])

          // Only add to map if we actually got data — empty means parent not yet staged
          if (values.length > 0) {
            newMap.set(field.name, new Set(values))
          }
        })
      )

      setValidFKValues(newMap)
    }

    loadFKValues()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [targetFieldConstraints, projectId])

  async function fetchStagedPage(mappingId: string, p: number) {
    setStagedLoading(true)
    setStagedError(null)
    try {
      const result = await getStagedDataPreview(mappingId, p, PAGE_SIZE)
      setStagedRows(result.rows)
      setStagedTotal(result.totalRows)
      setStagedFields(result.stagedFields)
      // rowIssues / flaggedFields from the server are cross-referenced source issues
      // and are intentionally NOT used — constraint checking is done client-side below.
    } catch (e) {
      setStagedError(e instanceof Error ? e.message : 'Failed to load transformed data')
    } finally {
      setStagedLoading(false)
    }
  }

  async function handleRegenerateStagedData() {
    setIsRegenerating(true)
    try {
      const result = await stageAllData(projectId)
      if (result.success && selectedMappingId) {
        await fetchStagedPage(selectedMappingId, stagedPage)
        const fresh = await checkStagingFreshness(selectedMappingId)
        setStalenessInfo(fresh)
      }
    } catch {
      // Non-critical — user can retry
    } finally {
      setIsRegenerating(false)
    }
  }

  function goToStagedPage(p: number) {
    setStagedPage(p)
    fetchStagedPage(selectedMappingId, p)
  }

  // ── Helpers ────────────────────────────────────────────────────────────────
  const columns = selectedTable?.fieldNames ?? (rows.length > 0 ? Object.keys(rows[0]) : [])
  const totalPages = Math.ceil(totalRows / PAGE_SIZE)

  const selectedMapping = stagedMappings.find((m) => m.tableMappingId === selectedMappingId)
  const stagedTargetTable = tables.find((t) => t.id === selectedMapping?.targetTableId)
  const stagedColumns =
    stagedTargetTable?.fieldNames ?? (stagedRows.length > 0 ? Object.keys(stagedRows[0]) : [])
  const stagedTotalPages = Math.ceil(stagedTotal / PAGE_SIZE)

  // Group source-only tables by dataset for the Source Data dropdown
  const datasetOrder: string[] = []
  const tablesByDataset = new Map<string, TableOption[]>()
  for (const t of sourceTables) {
    if (!tablesByDataset.has(t.datasetName)) {
      tablesByDataset.set(t.datasetName, [])
      datasetOrder.push(t.datasetName)
    }
    tablesByDataset.get(t.datasetName)!.push(t)
  }

  if (isArchived) {
    const purgeDate = archivedAt
      ? new Date(archivedAt).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' })
      : null
    return (
      <div className="flex flex-col items-center justify-center py-24 text-center">
        <svg className="w-10 h-10 text-gray-300 mb-4" fill="none" stroke="currentColor" strokeWidth="1.5" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" d="M20.25 7.5l-.625 10.632a2.25 2.25 0 01-2.247 2.118H6.622a2.25 2.25 0 01-2.247-2.118L3.75 7.5M10 11.25h4M3.375 7.5h17.25c.621 0 1.125-.504 1.125-1.125v-1.5c0-.621-.504-1.125-1.125-1.125H3.375c-.621 0-1.125.504-1.125 1.125v1.5c0 .621.504 1.125 1.125 1.125z" />
        </svg>
        <h3 className="text-base font-medium text-gray-700 mb-1.5">Data preview is not available</h3>
        <p className="text-sm text-gray-500 max-w-sm">
          Source data was purged{purgeDate ? ` on ${purgeDate}` : ' when this project was archived'}.
          Schema structure and field definitions are still available in Schema Overview.
        </p>
      </div>
    )
  }

  return (
    <div className="flex flex-col gap-4">
      {/* Source / Transformed toggle */}
      <div className="flex items-center gap-1 p-1 bg-gray-100 rounded-lg w-fit">
        <button
          onClick={() => setViewMode('source')}
          className={`px-4 py-1.5 text-sm font-medium rounded-md transition-colors ${
            viewMode === 'source'
              ? 'bg-white text-gray-900 shadow-sm'
              : 'text-gray-500 hover:text-gray-700'
          }`}
        >
          Source Data
        </button>
        <button
          onClick={() => setViewMode('transformed')}
          className={`px-4 py-1.5 text-sm font-medium rounded-md transition-colors ${
            viewMode === 'transformed'
              ? 'bg-white text-gray-900 shadow-sm'
              : 'text-gray-500 hover:text-gray-700'
          }`}
        >
          Transformed Data
        </button>
      </div>

      {/* ── SOURCE MODE ─────────────────────────────────────────────────────── */}
      {viewMode === 'source' && (
        <>
          {/* Table selector */}
          <div className="flex items-center gap-3">
            <label className="text-[11px] font-medium text-settle-slate-500 whitespace-nowrap">Select Table:</label>
            <Select
              value={selectedTableId}
              onValueChange={(val) => setSelectedTableId(val)}
            >
              <SelectTrigger className="h-9 text-sm w-[240px]">
                <SelectValue placeholder="Select table…" />
              </SelectTrigger>
              <SelectContent>
                {datasetOrder.map((dsName) => (
                  tablesByDataset.get(dsName)!.map((t) => (
                    <SelectItem key={t.id} value={t.id}>{dsName} — {t.name}</SelectItem>
                  ))
                ))}
              </SelectContent>
            </Select>
            {selectedTable && (
              <span className="text-xs text-gray-400">
                {selectedTable.row_count.toLocaleString()} rows
              </span>
            )}
          </div>

          {!selectedTableId ? (
            <div className="bg-white border border-gray-200 rounded-xl p-10 text-center">
              <p className="text-sm text-gray-500">Select a table to preview data.</p>
            </div>
          ) : (
            /* Source view: no flags, no targetFields — just raw data */
            <DataTable
              columns={columns}
              rows={rows}
              loading={loading}
              error={error}
              page={page}
              totalPages={totalPages}
              totalRows={totalRows}
              onGoToPage={goToPage}
              pageSize={PAGE_SIZE}
              label="Data Preview"
            />
          )}
        </>
      )}

      {/* ── TRANSFORMED MODE ────────────────────────────────────────────────── */}
      {viewMode === 'transformed' && (
        <>
          {stagedMappingsLoading ? (
            <div className="flex items-center gap-2 text-sm text-gray-500">
              <span className="w-4 h-4 border-2 border-primary border-t-transparent rounded-full animate-spin" />
              Loading transformed data…
            </div>
          ) : stagedMappings.length === 0 ? (
            <div className="bg-white border border-gray-200 rounded-xl p-10 text-center">
              <div className="text-3xl mb-3">🔄</div>
              <p className="font-medium text-gray-700 mb-1">No mappings yet</p>
              <p className="text-sm text-gray-500 max-w-sm mx-auto">
                Complete the <strong>Mapping</strong> step first to see how your source data maps to the target schema.
              </p>
            </div>
          ) : (
            <>
              {/* Mapping selector */}
              <div className="flex items-center gap-3 flex-wrap">
                <label className="text-[11px] font-medium text-settle-slate-500 whitespace-nowrap">Target Table:</label>
                <Select
                  value={selectedMappingId}
                  onValueChange={(val) => setSelectedMappingId(val)}
                >
                  <SelectTrigger className="h-9 text-sm w-[240px]">
                    <SelectValue placeholder="Select mapping…" />
                  </SelectTrigger>
                  <SelectContent>
                    {stagedMappings.map((m) => (
                      <SelectItem key={m.tableMappingId} value={m.tableMappingId}>
                        {m.targetTableName} ← {m.sourceTableName}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                {selectedMapping && (
                  <span className="text-xs text-gray-400">
                    {selectedMapping.rowCount.toLocaleString()} rows
                    {selectedMapping.isStaged ? (
                      <span className="ml-1 text-green-600 font-medium">· staged</span>
                    ) : (
                      <span className="ml-1 text-gray-400">· not staged</span>
                    )}
                    {stagedColumns.length > 0 && (
                      <span className="ml-2 text-gray-400">
                        · {stagedFields.length} transformed {stagedFields.length === 1 ? 'field' : 'fields'} · {stagedColumns.length - stagedFields.length} passthrough {(stagedColumns.length - stagedFields.length) === 1 ? 'field' : 'fields'}
                      </span>
                    )}
                  </span>
                )}
              </div>

              {/* Staleness banner */}
              {stalenessInfo?.isStale && (
                <div className="flex items-start gap-3 bg-amber-50 border border-amber-200 rounded-lg px-4 py-3">
                  <span className="text-amber-600 text-base leading-none mt-0.5 flex-shrink-0">⚠</span>
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium text-amber-800">Staged data may be outdated</p>
                    <p className="text-xs text-amber-700 mt-0.5">
                      Source data was modified{' '}
                      {stalenessInfo.sourceModifiedAt
                        ? `on ${new Date(stalenessInfo.sourceModifiedAt).toLocaleString()}`
                        : 'recently'}{' '}
                      (staged{' '}
                      {stalenessInfo.stagedAt
                        ? `on ${new Date(stalenessInfo.stagedAt).toLocaleString()}`
                        : 'earlier'}
                      ).
                    </p>
                  </div>
                  <button
                    onClick={handleRegenerateStagedData}
                    disabled={isRegenerating}
                    className="flex-shrink-0 px-3 py-1.5 text-xs font-medium bg-amber-600 hover:bg-amber-700 text-white rounded-lg disabled:opacity-50 flex items-center gap-1.5"
                  >
                    {isRegenerating ? (
                      <>
                        <span className="w-3 h-3 border-2 border-white/30 border-t-white rounded-full animate-spin" />
                        Staging…
                      </>
                    ) : 'Regenerate Staged Data'}
                  </button>
                </div>
              )}

              {/* Transformed view: targetFields drives client-side constraint checking */}
              <DataTable
                columns={stagedColumns}
                rows={stagedRows}
                loading={stagedLoading}
                error={stagedError}
                page={stagedPage}
                totalPages={stagedTotalPages}
                totalRows={stagedTotal}
                onGoToPage={goToStagedPage}
                pageSize={PAGE_SIZE}
                label="Transformed Data Preview"
                badge="Target format"
                stagedFields={stagedFields}
                targetFields={targetFieldConstraints}
                validFKValues={validFKValues}
                onNavigateToValidate={() => {
                  const params = new URLSearchParams({
                    stage: 'target-ready',
                    severity: 'blocking',
                    status: 'open',
                  })
                  if (stagedTargetTable?.id) params.set('tableId', stagedTargetTable.id)
                  router.push(`/app/projects/${projectId}/data-quality?${params.toString()}`)
                }}
              />
            </>
          )}
        </>
      )}
    </div>
  )
}

// ── Shared DataTable sub-component ────────────────────────────────────────────

/** Parse max character length from VARCHAR(N) or CHAR(N) data type strings. */
function getMaxLength(dataType: string): number | null {
  const match = dataType.match(/(?:VAR)?CHAR\s*\(\s*(\d+)\s*\)/i)
  return match ? parseInt(match[1], 10) : null
}

function DataTable({
  columns,
  rows,
  loading,
  error,
  page,
  totalPages,
  totalRows,
  onGoToPage,
  pageSize,
  label,
  badge,
  stagedFields,
  targetFields,
  validFKValues,
  onNavigateToValidate,
}: {
  columns: string[]
  rows: Record<string, unknown>[]
  loading: boolean
  error: string | null
  page: number
  totalPages: number
  totalRows: number
  onGoToPage: (p: number) => void
  pageSize: number
  label: string
  badge?: string
  /**
   * When provided (even as an empty array) the table is in "transformed mode":
   * - Fields in this set are "transformed" (bold)
   * - All other fields are "passthrough" (muted)
   */
  stagedFields?: string[]
  /**
   * Target schema field constraints. When provided, cells are checked client-side
   * against NOT NULL, length, and CHECK constraints. Only used in the staged/transformed view.
   * Source view never receives this prop.
   */
  targetFields?: TargetFieldConstraint[]
  /**
   * Valid FK parent values keyed by target field name.
   * Only populated for FK fields whose parent table has been staged.
   * If a field name is absent, FK checking is skipped for it.
   */
  validFKValues?: Map<string, Set<string>>
  onNavigateToValidate?: () => void
}) {
  const stagedSet = stagedFields !== undefined ? new Set(stagedFields) : null
  const showDiff = stagedSet !== null

  // ── Client-side constraint checking ───────────────────────────────────────
  // Runs only when targetFields is provided (transformed view).
  // Evaluation order per cell:
  //   1. NOT NULL check
  //   2. VARCHAR/CHAR length check
  //   3. CHECK in_list
  //   4. CHECK regex
  //   5. CHECK range
  //   6. FK referential integrity
  const cellFlags = useMemo<Map<string, string>[]>(() => {
    if (!targetFields || targetFields.length === 0) return rows.map(() => new Map())

    const fieldMap = new Map(targetFields.map((f) => [f.name, f]))

    return rows.map((row) => {
      const flags = new Map<string, string>()

      for (const col of columns) {
        const field = fieldMap.get(col)
        if (!field) continue

        const rawVal = row[col]
        // Normalise to a trimmed string or null
        const strVal = rawVal == null ? null : String(rawVal).trim()
        const isEmpty = strVal === null || strVal === ''

        // 1. NOT NULL — skip auto-generated PKs which may legitimately be absent
        if (!field.is_nullable && !field.is_primary_key && isEmpty) {
          flags.set(col, `${col} is NOT NULL in target but value is empty`)
          continue
        }

        // All further checks only apply when a value is present
        if (isEmpty) continue

        // 2. VARCHAR / CHAR length
        const maxLen = getMaxLength(field.data_type)
        if (maxLen !== null && strVal!.length > maxLen) {
          flags.set(
            col,
            `Value is ${strVal!.length} chars, max allowed is ${maxLen} (${field.data_type})`
          )
          continue
        }

        // 3–5. CHECK constraints
        if (field.check_constraint) {
          const cc = field.check_constraint

          if (cc.type === 'in_list') {
            if (!cc.allowedValues.includes(strVal!)) {
              const preview = cc.allowedValues.slice(0, 5).join(', ')
              const more = cc.allowedValues.length > 5 ? ` (+${cc.allowedValues.length - 5} more)` : ''
              flags.set(col, `"${strVal}" not in allowed values: ${preview}${more}`)
            }
            continue
          }

          if (cc.type === 'regex' && cc.pattern) {
            try {
              if (!new RegExp(cc.pattern).test(strVal!)) {
                flags.set(col, `"${strVal}" doesn't match pattern ${cc.pattern}`)
              }
            } catch {
              // Invalid regex pattern — skip
            }
            continue
          }

          if (cc.type === 'range') {
            const numVal = parseFloat(strVal!)
            if (!isNaN(numVal)) {
              if (cc.min !== undefined && numVal < cc.min) {
                flags.set(col, `Value ${numVal} is below minimum ${cc.min}`)
              } else if (cc.max !== undefined && numVal > cc.max) {
                flags.set(col, `Value ${numVal} exceeds maximum ${cc.max}`)
              }
            }
            continue
          }
        }

        // 6. FK referential integrity — only when parent data is available
        if (validFKValues) {
          const validSet = validFKValues.get(col)
          if (validSet) {
            // Trim both sides to handle CHAR-padded values
            const trimmed = strVal!.trim()
            const matched =
              validSet.has(trimmed) ||
              [...validSet].some((v) => v.trim() === trimmed)
            if (!matched) {
              flags.set(col, `Orphaned FK: "${trimmed}" not found in parent table`)
            }
          }
        }
      }

      return flags
    })
  }, [rows, columns, targetFields, validFKValues])

  // Derive per-column flagged counts and total flagged rows for the current page
  const constraintFlaggedFields = useMemo<Record<string, number>>(() => {
    const counts: Record<string, number> = {}
    for (const rowFlags of cellFlags) {
      for (const [field] of rowFlags) {
        counts[field] = (counts[field] ?? 0) + 1
      }
    }
    return counts
  }, [cellFlags])

  const constraintFlaggedRowCount = useMemo(
    () => cellFlags.filter((m) => m.size > 0).length,
    [cellFlags]
  )

  // Only show the flags banner when we're in transformed mode with target constraints loaded
  const hasFlaggedRows = targetFields && targetFields.length > 0 && constraintFlaggedRowCount > 0

  // Build the banner summary: field name + count for flagged columns
  const flaggedFieldSummaries = Object.entries(constraintFlaggedFields).map(([field, count]) => ({
    field,
    count,
  }))

  function renderPagination(className?: string) {
    if (totalPages <= 1) return null
    return (
      <div className={`flex items-center gap-1 ${className ?? ''}`}>
        <button
          onClick={() => onGoToPage(page - 1)}
          disabled={page === 1}
          className="px-2 py-1 rounded border border-gray-200 disabled:opacity-40 hover:bg-gray-50 text-gray-600"
        >
          ‹ Prev
        </button>
        {Array.from({ length: Math.min(totalPages, 5) }, (_, i) => {
          const p = i + 1
          return (
            <button
              key={p}
              onClick={() => onGoToPage(p)}
              className={`px-2 py-1 rounded border ${
                p === page
                  ? 'bg-primary text-white border-primary'
                  : 'border-gray-200 hover:bg-gray-50 text-gray-600'
              }`}
            >
              {p}
            </button>
          )
        })}
        {totalPages > 5 && page < totalPages && <span className="text-gray-400">…</span>}
        <button
          onClick={() => onGoToPage(page + 1)}
          disabled={page === totalPages}
          className="px-2 py-1 rounded border border-gray-200 disabled:opacity-40 hover:bg-gray-50 text-gray-600"
        >
          Next ›
        </button>
      </div>
    )
  }

  return (
    <div className="bg-white border border-gray-200 rounded-xl overflow-hidden">

      {/* ── Header row ──────────────────────────────────────────────────────── */}
      <div className="px-5 py-3 border-b border-gray-100 flex items-center justify-between">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="text-sm font-semibold text-gray-900">{label}</span>
          {showDiff && (
            <>
              <span className="text-xs font-medium px-1.5 py-0.5 bg-green-100 text-green-700 rounded">
                {stagedSet!.size} transformed
              </span>
              <span className="text-xs text-gray-500">
                · {columns.length - stagedSet!.size} passthrough
              </span>
            </>
          )}
        </div>
        {badge && (
          <span className="text-xs font-medium px-2 py-0.5 bg-violet-100 text-violet-700 rounded-full">
            {badge}
          </span>
        )}
      </div>

      {/* ── Constraint violations banner (transformed view only) ─────────────── */}
      {hasFlaggedRows && (
        <div className="px-5 py-2.5 bg-red-50 border-b border-red-200 flex items-center gap-2 text-sm">
          <AlertTriangle className="w-4 h-4 text-red-500 flex-shrink-0" />
          <span className="text-red-800">
            <strong>
              {constraintFlaggedRowCount} row{constraintFlaggedRowCount !== 1 ? 's' : ''} on this page
              have constraint violations
            </strong>
            {flaggedFieldSummaries.length > 0 && (
              <span className="text-red-700">
                {' — '}
                {flaggedFieldSummaries.slice(0, 4).map((f, i) => (
                  <span key={f.field}>
                    {i > 0 && ', '}
                    {f.field}: {f.count}
                  </span>
                ))}
                {flaggedFieldSummaries.length > 4 && (
                  <span> + {flaggedFieldSummaries.length - 4} more</span>
                )}
              </span>
            )}
          </span>
          {onNavigateToValidate && (
            <button
              onClick={onNavigateToValidate}
              className="ml-auto text-xs text-primary hover:text-blue-800 font-medium whitespace-nowrap"
            >
              Fix in Validate tab →
            </button>
          )}
        </div>
      )}

      {/* ── Table body ──────────────────────────────────────────────────────── */}
      {loading ? (
        <div className="p-10 text-center">
          <div className="inline-block w-5 h-5 border-2 border-primary border-t-transparent rounded-full animate-spin" />
        </div>
      ) : error ? (
        <div className="p-6 text-center text-sm text-red-600">{error}</div>
      ) : rows.length === 0 ? (
        <div className="p-10 text-center text-sm text-gray-500">No rows found.</div>
      ) : (
        <>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-gray-50 border-b border-gray-100">
                <tr>
                  {columns.map((col) => {
                    const isTransformed = stagedSet ? stagedSet.has(col) : true
                    const fieldIssueCount = constraintFlaggedFields[col] ?? 0
                    return (
                      <th
                        key={col}
                        className={`text-left px-4 py-3 text-xs whitespace-nowrap ${
                          fieldIssueCount > 0
                            ? 'text-red-600 font-semibold'
                            : showDiff && !isTransformed
                            ? 'text-gray-400 font-medium'
                            : 'text-gray-700 font-semibold'
                        }`}
                        title={
                          fieldIssueCount > 0
                            ? `${fieldIssueCount} row${fieldIssueCount !== 1 ? 's' : ''} have constraint violations in this column`
                            : showDiff
                            ? isTransformed
                              ? 'Transform applied'
                              : 'Source passthrough — not yet transformed'
                            : undefined
                        }
                      >
                        {col}
                        {/* Green dot for transformed columns with no violations */}
                        {showDiff && isTransformed && fieldIssueCount === 0 && (
                          <span
                            className="ml-1.5 inline-block align-middle rounded-full bg-green-500"
                            style={{ width: 6, height: 6 }}
                          />
                        )}
                        {/* Red warning badge for columns with constraint violations */}
                        {fieldIssueCount > 0 && (
                          <span className="ml-1.5 text-red-500 text-[10px] font-medium align-middle bg-red-100 px-1 rounded">
                            ⚠ {fieldIssueCount}
                          </span>
                        )}
                      </th>
                    )
                  })}
                </tr>
              </thead>
              <tbody>
                {rows.map((row, i) => {
                  const rowFlags = cellFlags[i] ?? new Map<string, string>()
                  const flaggedColCount = rowFlags.size
                  // Subtle row tint only when the majority of columns are flagged
                  const majorityFlagged = flaggedColCount > columns.length / 2
                  return (
                    <tr
                      key={i}
                      className={`border-b border-gray-100 last:border-b-0 transition-colors ${
                        majorityFlagged
                          ? 'bg-red-50/50'
                          : showDiff
                          ? 'hover:bg-gray-50 even:bg-gray-50/30'
                          : 'hover:bg-gray-50 even:bg-gray-50/50'
                      }`}
                    >
                      {columns.map((col) => {
                        const isTransformed = stagedSet ? stagedSet.has(col) : true
                        const violationMsg = rowFlags.get(col)
                        const cellHasIssue = Boolean(violationMsg)
                        return (
                          <td
                            key={col}
                            className={`px-4 py-2.5 text-xs whitespace-nowrap max-w-[200px] truncate ${
                              cellHasIssue
                                ? 'bg-red-50 text-red-600 italic'
                                : showDiff && !isTransformed
                                ? 'text-gray-400'
                                : showDiff && isTransformed
                                ? 'font-medium text-gray-900'
                                : 'text-gray-700'
                            }`}
                            title={violationMsg}
                          >
                            {row[col] == null ? (
                              cellHasIssue ? (
                                <span className="flex items-center gap-1 font-mono not-italic">
                                  <AlertTriangle className="w-3 h-3 text-red-500 flex-shrink-0" />
                                  <span className="italic">null</span>
                                </span>
                              ) : (
                                <span className="text-gray-300 italic font-mono">null</span>
                              )
                            ) : cellHasIssue ? (
                              <span className="flex items-center gap-1 font-mono not-italic">
                                <AlertTriangle className="w-3 h-3 text-red-500 flex-shrink-0" />
                                {String(row[col])}
                              </span>
                            ) : (
                              String(row[col])
                            )}
                          </td>
                        )
                      })}
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>

          {/* ── Footer: pagination + legend ─────────────────────────────────── */}
          <div className="px-5 py-3 border-t border-gray-100 flex items-center justify-between text-xs text-gray-500">
            <span>
              Showing {(page - 1) * pageSize + 1}–{Math.min(page * pageSize, totalRows)} of{' '}
              {totalRows.toLocaleString()} rows
            </span>
            {showDiff ? (
              <span className="text-gray-400">
                <span className="text-gray-400">Passthrough</span>
                {' in muted · '}
                <strong className="text-gray-700 font-medium">Transformed</strong>
                {' in bold · '}
                <span className="text-red-500">Violations</span>
                {' in red'}
              </span>
            ) : (
              renderPagination()
            )}
          </div>

          {/* Pagination row when legend is also showing (transformed mode) */}
          {showDiff && (
            <div className="px-5 pb-3 flex items-center justify-end">
              {renderPagination('text-xs')}
            </div>
          )}
        </>
      )}
    </div>
  )
}
