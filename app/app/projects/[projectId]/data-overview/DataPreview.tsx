'use client'

import { useState, useEffect } from 'react'
import { getDataPreview } from '@/lib/actions/data-overview'
import type { TableOption } from '@/lib/actions/data-overview'

interface DataPreviewProps {
  tables: TableOption[]
}

const PAGE_SIZE = 10

export default function DataPreview({ tables }: DataPreviewProps) {
  const [selectedTableId, setSelectedTableId] = useState<string>(tables[0]?.id ?? '')
  const [page, setPage] = useState(1)
  const [rows, setRows] = useState<Record<string, unknown>[]>([])
  const [totalRows, setTotalRows] = useState(0)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const selectedTable = tables.find((t) => t.id === selectedTableId)

  useEffect(() => {
    if (!selectedTableId) return
    setPage(1)
    fetchPage(selectedTableId, 1)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedTableId])

  async function fetchPage(tableId: string, p: number) {
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
    fetchPage(selectedTableId, p)
  }

  const columns = rows.length > 0 ? Object.keys(rows[0]) : []
  const totalPages = Math.ceil(totalRows / PAGE_SIZE)

  // Group tables by dataset for the dropdown
  const datasetOrder: string[] = []
  const tablesByDataset = new Map<string, TableOption[]>()
  for (const t of tables) {
    if (!tablesByDataset.has(t.datasetName)) {
      tablesByDataset.set(t.datasetName, [])
      datasetOrder.push(t.datasetName)
    }
    tablesByDataset.get(t.datasetName)!.push(t)
  }

  return (
    <div className="flex flex-col gap-4">
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
      </div>

      {!selectedTableId ? (
        <div className="bg-white border border-gray-200 rounded-xl p-10 text-center">
          <p className="text-sm text-gray-500">Select a table to preview data.</p>
        </div>
      ) : (
        <div className="bg-white border border-gray-200 rounded-xl overflow-hidden">
          {/* Card header */}
          <div className="px-5 py-3 border-b border-gray-100 flex items-center justify-between">
            <span className="text-sm font-semibold text-gray-900">Data Preview</span>
            <span className="text-xs text-gray-500">
              Sample data preview (first {PAGE_SIZE} rows)
            </span>
          </div>

          {loading ? (
            <div className="p-10 text-center">
              <div className="inline-block w-5 h-5 border-2 border-indigo-600 border-t-transparent rounded-full animate-spin" />
            </div>
          ) : error ? (
            <div className="p-6 text-center text-sm text-red-600">{error}</div>
          ) : rows.length === 0 ? (
            <div className="p-10 text-center text-sm text-gray-500">No rows uploaded for this table.</div>
          ) : (
            <>
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead className="bg-gray-50 border-b border-gray-100">
                    <tr>
                      {columns.map((col) => (
                        <th
                          key={col}
                          className="text-left px-4 py-3 text-xs font-semibold text-gray-700 whitespace-nowrap"
                        >
                          {col}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((row, i) => (
                      <tr key={i} className="border-b border-gray-100 last:border-b-0 hover:bg-gray-50">
                        {columns.map((col) => (
                          <td key={col} className="px-4 py-2.5 text-gray-700 text-xs whitespace-nowrap max-w-[200px] truncate">
                            {row[col] == null ? (
                              <span className="text-gray-300 italic">null</span>
                            ) : (
                              String(row[col])
                            )}
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              {/* Pagination */}
              {totalPages > 1 && (
                <div className="px-5 py-3 border-t border-gray-100 flex items-center justify-between text-xs text-gray-600">
                  <span>
                    Showing {(page - 1) * PAGE_SIZE + 1}–{Math.min(page * PAGE_SIZE, totalRows)} of{' '}
                    {totalRows.toLocaleString()} rows
                  </span>
                  <div className="flex items-center gap-1">
                    <button
                      onClick={() => goToPage(page - 1)}
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
                          onClick={() => goToPage(p)}
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
                      onClick={() => goToPage(page + 1)}
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
      )}
    </div>
  )
}
