'use client'

import { useState, useEffect } from 'react'
import { getDataPreview } from '@/lib/actions/data-overview'
import { getStagedMappings, getStagedDataPreview } from '@/lib/actions/staging'
import type { TableOption } from '@/lib/actions/data-overview'
import type { StagedMappingOption } from '@/lib/actions/staging'

interface DataPreviewProps {
  projectId: string
  tables: TableOption[]
}

const PAGE_SIZE = 10

export default function DataPreview({ projectId, tables }: DataPreviewProps) {
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
  /** Target field names whose transforms have been applied to staged_data_rows */
  const [stagedFields, setStagedFields] = useState<string[]>([])

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
      fetchStagedPage(selectedMappingId, 1)
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
    } catch (e) {
      setStagedError(e instanceof Error ? e.message : 'Failed to load transformed data')
    } finally {
      setStagedLoading(false)
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
              <div className="flex items-center gap-3">
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
                  </span>
                )}
              </div>

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
  /** When provided, columns IN this set have been transformed; others are source passthrough */
  stagedFields?: string[]
}) {
  // Only show differentiation when some (but not all) fields are staged
  const stagedSet = stagedFields ? new Set(stagedFields) : null
  const showDiff = stagedSet !== null && stagedSet.size > 0 && stagedSet.size < columns.length

  return (
    <div className="bg-white border border-gray-200 rounded-xl overflow-hidden">
      <div className="px-5 py-3 border-b border-gray-100 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <span className="text-sm font-semibold text-gray-900">{label}</span>
          {showDiff && (
            <span className="text-xs text-gray-400 font-normal">
              <span className="text-green-600 font-medium">{stagedSet!.size} transformed</span>
              {' · '}
              {columns.length - stagedSet!.size} passthrough
            </span>
          )}
        </div>
        <div className="flex items-center gap-2">
          {badge && (
            <span className="text-xs font-medium px-2 py-0.5 bg-violet-100 text-violet-700 rounded-full">
              {badge}
            </span>
          )}
          <span className="text-xs text-gray-500">First {pageSize} rows per page</span>
        </div>
      </div>

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
                    return (
                      <th
                        key={col}
                        className={`text-left px-4 py-3 text-xs font-semibold whitespace-nowrap ${
                          showDiff && !isTransformed
                            ? 'text-gray-400'
                            : 'text-gray-700'
                        }`}
                        title={showDiff ? (isTransformed ? 'Transform applied' : 'Source passthrough — not yet transformed') : undefined}
                      >
                        {col}
                        {showDiff && isTransformed && (
                          <span className="ml-1 inline-block w-1.5 h-1.5 rounded-full bg-green-400 align-middle" />
                        )}
                      </th>
                    )
                  })}
                </tr>
              </thead>
              <tbody>
                {rows.map((row, i) => (
                  <tr key={i} className="border-b border-gray-100 last:border-b-0 hover:bg-gray-50">
                    {columns.map((col) => {
                      const isTransformed = stagedSet ? stagedSet.has(col) : true
                      return (
                        <td
                          key={col}
                          className={`px-4 py-2.5 text-xs whitespace-nowrap max-w-[200px] truncate ${
                            showDiff && !isTransformed ? 'text-gray-400' : 'text-gray-700'
                          }`}
                        >
                          {row[col] == null ? (
                            <span className="text-gray-300 italic">null</span>
                          ) : (
                            String(row[col])
                          )}
                        </td>
                      )
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {totalPages > 1 && (
            <div className="px-5 py-3 border-t border-gray-100 flex items-center justify-between text-xs text-gray-600">
              <span>
                Showing {(page - 1) * pageSize + 1}–{Math.min(page * pageSize, totalRows)} of{' '}
                {totalRows.toLocaleString()} rows
              </span>
              <div className="flex items-center gap-1">
                <button
                  onClick={() => onGoToPage(page - 1)}
                  disabled={page === 1}
                  className="px-2 py-1 rounded border border-gray-200 disabled:opacity-40 hover:bg-gray-50"
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
                          : 'border-gray-200 hover:bg-gray-50'
                      }`}
                    >
                      {p}
                    </button>
                  )
                })}
                {totalPages > 5 && page < totalPages && <span>…</span>}
                <button
                  onClick={() => onGoToPage(page + 1)}
                  disabled={page === totalPages}
                  className="px-2 py-1 rounded border border-gray-200 disabled:opacity-40 hover:bg-gray-50"
                >
                  Next ›
                </button>
              </div>
            </div>
          )}
        </>
      )}
    </div>
  )
}
