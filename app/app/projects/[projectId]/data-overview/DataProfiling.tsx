'use client'

import { useState, useEffect } from 'react'
import { getFieldProfiles } from '@/lib/actions/data-overview'
import type { TableOption, ProfilingData } from '@/lib/actions/data-overview'
import { Select, SelectContent, SelectGroup, SelectItem, SelectLabel, SelectTrigger, SelectValue } from '@/components/ui/select'

interface DataProfilingProps {
  tables: TableOption[]
  isArchived?: boolean
}

function StatCard({
  label,
  value,
  red,
}: {
  label: string
  value: string | number
  red?: boolean
}) {
  return (
    <div className="bg-white border border-gray-200 rounded-xl px-6 py-5 flex-1">
      <p className="text-xs text-gray-500 font-medium mb-1">{label}</p>
      <p className={`text-3xl font-semibold ${red ? 'text-red-500' : 'text-gray-900'}`}>
        {typeof value === 'number' ? value.toLocaleString() : value}
      </p>
    </div>
  )
}

export default function DataProfiling({ tables, isArchived = false }: DataProfilingProps) {
  // For archived projects, show all tables (row_count is zeroed but aggregate stats are preserved)
  // For active projects, only tables with data have profiling stats
  const profilableTables = isArchived ? tables : tables.filter((t) => t.row_count > 0)

  const [selectedTableId, setSelectedTableId] = useState<string>(profilableTables[0]?.id ?? '')
  const [data, setData] = useState<ProfilingData | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!selectedTableId) return
    fetchProfile(selectedTableId)
  }, [selectedTableId])

  async function fetchProfile(tableId: string) {
    setLoading(true)
    setError(null)
    try {
      const result = await getFieldProfiles(tableId)
      setData(result)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load profiling data')
    } finally {
      setLoading(false)
    }
  }

  // Group profilable tables for the dropdown
  const datasetOrder: string[] = []
  const tablesByDataset = new Map<string, TableOption[]>()
  for (const t of profilableTables) {
    if (!tablesByDataset.has(t.datasetName)) {
      tablesByDataset.set(t.datasetName, [])
      datasetOrder.push(t.datasetName)
    }
    tablesByDataset.get(t.datasetName)!.push(t)
  }

  if (profilableTables.length === 0) {
    return (
      <div className="bg-white border border-gray-200 rounded-xl p-10 text-center">
        <p className="text-sm font-medium text-gray-700">No data to profile</p>
        <p className="text-sm text-gray-500 mt-1">
          Upload CSV files as source data to see profiling statistics.
          Tables created from DDL files do not have row data.
        </p>
      </div>
    )
  }

  return (
    <div className="flex flex-col gap-4">
      {/* Table selector */}
      <div className="flex items-center gap-3">
        <label className="text-sm font-medium text-gray-700 whitespace-nowrap">Select Table:</label>
        <Select
          value={selectedTableId}
          onValueChange={(val) => setSelectedTableId(val)}
        >
          <SelectTrigger className="h-9 text-sm w-[240px]">
            <SelectValue placeholder="Select table…" />
          </SelectTrigger>
          <SelectContent>
            {datasetOrder.map((dsName) => (
              <SelectGroup key={dsName}>
                <SelectLabel>{dsName}</SelectLabel>
                {tablesByDataset.get(dsName)!.map((t) => (
                  <SelectItem key={t.id} value={t.id}>{t.name}</SelectItem>
                ))}
              </SelectGroup>
            ))}
          </SelectContent>
        </Select>
      </div>

      {!selectedTableId ? (
        <div className="bg-white border border-gray-200 rounded-xl p-10 text-center">
          <p className="text-sm text-gray-500">Select a table to view profiling data.</p>
        </div>
      ) : loading ? (
        <div className="bg-white border border-gray-200 rounded-xl p-10 text-center">
          <div className="inline-block w-5 h-5 border-2 border-indigo-600 border-t-transparent rounded-full animate-spin" />
        </div>
      ) : error ? (
        <div className="bg-white border border-gray-200 rounded-xl p-6 text-center text-sm text-red-600">{error}</div>
      ) : !data ? (
        <div className="bg-white border border-gray-200 rounded-xl p-10 text-center text-sm text-gray-500">
          No profiling data found for this table.
        </div>
      ) : (
        <>
          {/* Summary cards */}
          <div className="flex gap-4">
            <StatCard label="Total Rows" value={data.table.row_count} />
            <StatCard label="Total Fields" value={data.fields.length} />
            <StatCard
              label="Format Issues"
              value={data.totalFormatIssues}
              red={data.totalFormatIssues > 0}
            />
          </div>

          {/* Field-level table */}
          <div className="bg-white border border-gray-200 rounded-xl overflow-hidden">
            <div className="px-5 py-3 border-b border-gray-100">
              <span className="text-sm font-semibold text-gray-900">Field-Level Profiling</span>
            </div>

            {data.fields.length === 0 ? (
              <div className="p-6 text-center text-sm text-gray-500">No fields found.</div>
            ) : (
              <table className="w-full text-sm">
                <thead className="bg-gray-50 border-b border-gray-100">
                  <tr>
                    <th className="text-left px-5 py-3 text-xs font-semibold text-gray-700">Field Name</th>
                    <th className="text-right px-5 py-3 text-xs font-semibold text-gray-700">Null %</th>
                    <th className="text-right px-5 py-3 text-xs font-semibold text-gray-700">Cardinality</th>
                    <th className="text-right px-5 py-3 text-xs font-semibold text-gray-700">Unique %</th>
                    <th className="text-right px-5 py-3 text-xs font-semibold text-gray-700">Format Issues</th>
                  </tr>
                </thead>
                <tbody>
                  {data.fields.map((f) => (
                    <tr key={f.id} className="border-b border-gray-100 last:border-b-0 hover:bg-gray-50">
                      <td className="px-5 py-3 text-gray-900 font-medium">{f.name}</td>
                      <td className="px-5 py-3 text-right text-gray-600">
                        {f.null_percentage.toFixed(1)}%
                      </td>
                      <td className="px-5 py-3 text-right text-gray-600">
                        {f.cardinality.toLocaleString()}
                      </td>
                      <td className="px-5 py-3 text-right text-gray-600">
                        {f.unique_percentage.toFixed(1)}%
                      </td>
                      <td className={`px-5 py-3 text-right font-semibold ${f.format_issues_count > 0 ? 'text-red-500' : 'text-gray-400'}`}>
                        {f.format_issues_count}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </>
      )}
    </div>
  )
}
