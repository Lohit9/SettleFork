'use client'

import { useState, useEffect } from 'react'
import { useRouter } from 'next/navigation'
import { getDataPreview } from '@/lib/actions/data-overview'
import { getStagedMappings, getStagedDataPreview, checkStagingFreshness, stageAllData } from '@/lib/actions/staging'
import type { TableOption } from '@/lib/actions/data-overview'
import type { StagedMappingOption, RowIssue } from '@/lib/actions/staging'
import { AlertTriangle } from '@/components/icons'

interface DataPreviewProps {
  projectId: string
  tables: TableOption[]
}

const PAGE_SIZE = 10

export default function DataPreview({ projectId, tables }: DataPreviewProps) {
  const router = useRouter()

  // ── View mode ──────────────────────────────────────────────────────────────
  const [viewMode, setViewMode] = useState<'source' | 'transformed'>('source')

  // Source Data tab only shows tables from source datasets (target tables have 0 rows)
  const sourceTables = tables.filter((t) => t.role === 'source')

  // ── Source mode state ──────────────────────────────────────────────────────
  const [selectedTableId, setSelectedTableId] = useState<string>(sourceTables[0]?.id ?? '')
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
  /** Per-row issue arrays for the current page (parallel to stagedRows) */
  const [rowIssues, setRowIssues] = useState<RowIssue[][]>([])
  /** Issue count per target field across ALL staged rows (not just current page) */
  const [flaggedFields, setFlaggedFields] = useState<Record<string, number>>({})
  /** Total rows with at least one issue across the entire mapping */
  const [totalFlaggedRowsAll, setTotalFlaggedRowsAll] = useState(0)
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
      // Check staleness for this mapping in parallel
      checkStagingFreshness(selectedMappingId).then(setStalenessInfo).catch(() => {})
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedMappingId, viewMode])

  async function fetchStagedPage(mappingId: string, p: number) {
    setStagedLoading(true)
    setStagedError(null)
    try {
      const result = await getStagedDataPreview(mappingId, p, PAGE_SIZE)
      setStagedRows(result.rows)
      setStagedTotal(result.totalRows)
      setStagedFields(result.stagedFields)
      setRowIssues(result.rowIssues)
      setFlaggedFields(result.flaggedFields)
      setTotalFlaggedRowsAll(result.totalFlaggedRows)
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
  // Use field order from the fields table (ordinal_position) rather than
  // Object.keys() on JSONB, which gives arbitrary hash order.
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
            <label className="text-sm font-medium text-gray-700 whitespace-nowrap">Select Table:</label>
            <select
              value={selectedTableId}
              onChange={(e) => setSelectedTableId(e.target.value)}
              className="border border-gray-300 rounded-lg px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500"
            >
              {datasetOrder.map((dsName) => (
                <optgroup key={dsName} label={dsName}>
                  {tablesByDataset.get(dsName)!.map((t) => (
                    <option key={t.id} value={t.id}>{t.name}</option>
                  ))}
                </optgroup>
              ))}
            </select>
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
              <span className="w-4 h-4 border-2 border-indigo-600 border-t-transparent rounded-full animate-spin" />
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
                <label className="text-sm font-medium text-gray-700 whitespace-nowrap">Target Table:</label>
                <select
                  value={selectedMappingId}
                  onChange={(e) => setSelectedMappingId(e.target.value)}
                  className="border border-gray-300 rounded-lg px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500"
                >
                  {stagedMappings.map((m) => (
                    <option key={m.tableMappingId} value={m.tableMappingId}>
                      {m.targetTableName} ← {m.sourceTableName}
                    </option>
                  ))}
                </select>
                {selectedMapping && (
                  <span className="text-xs text-gray-400">
                    {selectedMapping.rowCount.toLocaleString()} rows
                    {selectedMapping.isStaged ? (
                      <span className="ml-1 text-green-600 font-medium">· staged</span>
                    ) : (
                      <span className="ml-1 text-gray-400">· passthrough</span>
                    )}
                    {stagedColumns.length > 0 && (
                      <span className="ml-2 text-gray-400">
                        · {stagedFields.length} transformed · {stagedColumns.length - stagedFields.length} passthrough
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
                rowIssues={rowIssues}
                flaggedFields={flaggedFields}
                totalFlaggedRows={totalFlaggedRowsAll}
                onNavigateToValidate={() =>
                  router.push(
                    `/app/projects/${projectId}/data-quality?stage=source&severity=blocking&status=open`
                  )
                }
              />
            </>
          )}
        </>
      )}
    </div>
  )
}

// ── Shared DataTable sub-component ────────────────────────────────────────────

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
  rowIssues,
  flaggedFields,
  totalFlaggedRows,
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
   * - Three-state cell rendering is always active
   */
  stagedFields?: string[]
  /** Per-row issue arrays for the current page (parallel to rows) */
  rowIssues?: RowIssue[][]
  /** Issue count per target field across ALL staged rows — drives column header badges */
  flaggedFields?: Record<string, number>
  /** Total rows with at least one issue across the entire mapping */
  totalFlaggedRows?: number
  onNavigateToValidate?: () => void
}) {
  // showDiff is true whenever stagedFields is provided (i.e. transformed mode).
  // We intentionally do NOT gate on stagedFields.length > 0 or < columns.length
  // so that "0 transformed · N passthrough" and "N transformed · 0 passthrough"
  // also render correctly with full three-state styling.
  const stagedSet = stagedFields !== undefined ? new Set(stagedFields) : null
  const showDiff = stagedSet !== null
  const hasFlaggedRows = (totalFlaggedRows ?? 0) > 0

  // Build flagged field summaries for the summary banner.
  // Counts come from flaggedFields (server, all pages).
  // Issue-type labels are inferred from the current page's rowIssues — the type
  // is consistent for a given field across pages, so sampling the current page
  // is reliable. Fields not seen this page default to the generic "issues" label.
  const fieldLabelFromPage = new Map<string, string>()
  for (const issueArr of rowIssues ?? []) {
    for (const issue of issueArr) {
      if (!fieldLabelFromPage.has(issue.field)) {
        fieldLabelFromPage.set(
          issue.field,
          issue.issue === 'null_primary_key'
            ? 'null PKs'
            : issue.issue === 'null_required_field'
            ? 'null required'
            : 'issues'
        )
      }
    }
  }
  const flaggedFieldSummaries = Object.entries(flaggedFields ?? {}).map(([field, count]) => ({
    field,
    count,
    issueType: fieldLabelFromPage.get(field) ?? 'issues',
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
                  ? 'bg-indigo-600 text-white border-indigo-600'
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

      {/* ── Flagged rows summary banner ──────────────────────────────────────── */}
      {hasFlaggedRows && (
        <div className="px-5 py-2.5 bg-red-50 border-b border-red-200 flex items-center gap-2 text-sm">
          <AlertTriangle className="w-4 h-4 text-red-500 flex-shrink-0" />
          <span className="text-red-800">
            <strong>{totalFlaggedRows} row{totalFlaggedRows !== 1 ? 's' : ''} flagged</strong>
            {flaggedFieldSummaries.length > 0 && (
              <span className="text-red-700">
                {' — '}
                {flaggedFieldSummaries.slice(0, 4).map((f, i) => (
                  <span key={f.field}>
                    {i > 0 && ', '}
                    {f.field}: {f.count} {f.issueType}
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
              className="ml-auto text-xs text-indigo-600 hover:text-indigo-800 font-medium whitespace-nowrap"
            >
              Fix in Validate tab →
            </button>
          )}
        </div>
      )}

      {/* ── Table body ──────────────────────────────────────────────────────── */}
      {loading ? (
        <div className="p-10 text-center">
          <div className="inline-block w-5 h-5 border-2 border-indigo-600 border-t-transparent rounded-full animate-spin" />
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
                    const fieldIssueCount = flaggedFields?.[col] ?? 0
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
                            ? `${fieldIssueCount} row${fieldIssueCount !== 1 ? 's' : ''} have issues in this column`
                            : showDiff
                            ? isTransformed
                              ? 'Transform applied'
                              : 'Source passthrough — not yet transformed'
                            : undefined
                        }
                      >
                        {col}
                        {/* Green dot for transformed columns with no issues */}
                        {showDiff && isTransformed && fieldIssueCount === 0 && (
                          <span
                            className="ml-1.5 inline-block align-middle rounded-full bg-green-500"
                            style={{ width: 6, height: 6 }}
                          />
                        )}
                        {/* Red warning badge for columns with issues */}
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
                  const issues = rowIssues?.[i] ?? []
                  const issueFieldSet = new Set(issues.map((iss) => iss.field))
                  // Apply a subtle row tint only when the MAJORITY of columns have issues
                  const majorityFlagged = new Set(issues.map((iss) => iss.field)).size > columns.length / 2
                  return (
                    <tr
                      key={i}
                      className={`border-b border-gray-100 last:border-b-0 ${
                        majorityFlagged ? 'bg-red-50/50' : 'hover:bg-gray-50'
                      }`}
                    >
                      {columns.map((col) => {
                        const isTransformed = stagedSet ? stagedSet.has(col) : true
                        const cellHasIssue = issueFieldSet.has(col)
                        const issueForCell = issues.find((iss) => iss.field === col)
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
                            title={issueForCell?.description}
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
                <span className="text-red-500">Issues</span>
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
