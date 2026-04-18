'use client'

import { useState, useEffect, useRef } from 'react'
import { useRouter } from 'next/navigation'
import { getFieldProfiles, getFieldQualityIssues } from '@/lib/actions/data-overview'
import type { TableOption, ProfilingData } from '@/lib/actions/data-overview'
import { Select, SelectContent, SelectGroup, SelectItem, SelectLabel, SelectTrigger, SelectValue } from '@/components/ui/select'
import { X, AlertTriangle } from '@/components/icons'

interface DataProfilingProps {
  projectId: string
  tables: TableOption[]
  isArchived?: boolean
  onNavigateToPreview?: (tableId: string) => void
}

type FieldIssue = {
  id: string
  severity: string
  title: string
  description: string
  affected_records: number
  issue_kind: string | null
  status: string
}

export default function DataProfiling({
  projectId,
  tables,
  isArchived = false,
  onNavigateToPreview,
}: DataProfilingProps) {
  const router = useRouter()

  const profilableTables = isArchived ? tables : tables.filter((t) => t.row_count > 0)

  const [selectedTableId, setSelectedTableId] = useState<string>(profilableTables[0]?.id ?? '')
  const [data, setData] = useState<ProfilingData | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // ── Quality issues popover ──────────────────────────────────────────────────
  const [openQualityPopover, setOpenQualityPopover] = useState<string | null>(null)
  const [popoverIssues, setPopoverIssues] = useState<FieldIssue[]>([])
  const [loadingIssues, setLoadingIssues] = useState(false)
  const [popoverPosition, setPopoverPosition] = useState<'below' | 'above'>('below')
  const popoverRef = useRef<HTMLDivElement>(null)
  const triggerRefs = useRef<Record<string, HTMLButtonElement | null>>({})

  useEffect(() => {
    if (!selectedTableId) return
    fetchProfile(selectedTableId)
    setOpenQualityPopover(null)
  }, [selectedTableId])

  useEffect(() => {
    if (!openQualityPopover) return
    setLoadingIssues(true)
    setPopoverIssues([])
    getFieldQualityIssues(projectId, openQualityPopover)
      .then(({ issues }) => setPopoverIssues(issues))
      .finally(() => setLoadingIssues(false))
  }, [openQualityPopover, projectId])

  // Flip popover above trigger when there isn't enough space below
  useEffect(() => {
    if (openQualityPopover && triggerRefs.current[openQualityPopover]) {
      const trigger = triggerRefs.current[openQualityPopover]
      if (trigger) {
        const rect = trigger.getBoundingClientRect()
        const spaceBelow = window.innerHeight - rect.bottom
        setPopoverPosition(spaceBelow < 300 ? 'above' : 'below')
      }
    }
  }, [openQualityPopover])

  // Close popover on outside click
  useEffect(() => {
    if (!openQualityPopover) return
    function handleClick(e: MouseEvent) {
      if (popoverRef.current && !popoverRef.current.contains(e.target as Node)) {
        setOpenQualityPopover(null)
      }
    }
    document.addEventListener('mousedown', handleClick)
    return () => document.removeEventListener('mousedown', handleClick)
  }, [openQualityPopover])

  async function fetchProfile(tableId: string) {
    setLoading(true)
    setError(null)
    try {
      const result = await getFieldProfiles(projectId, tableId)
      setData(result)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load profiling data')
    } finally {
      setLoading(false)
    }
  }

  function navigateToDataPreview(tableId: string) {
    setOpenQualityPopover(null)
    if (onNavigateToPreview) {
      onNavigateToPreview(tableId)
    } else {
      router.push(
        `/app/projects/${projectId}/data-overview?tab=preview&tableId=${tableId}`
      )
    }
  }

  // Total issues across all fields in the current table. Uses the same
  // per-field logic as the "Data quality" column: prefer the quality_issues
  // row count when present, otherwise fall back to field_profiles.format_issues_count.
  // This keeps the top counter consistent with what's visible in the column —
  // without it, a single quality_issues row anywhere in the table would hide
  // every field's format_issues_count from the total.
  const totalQualityIssues = data?.fields.reduce(
    (s, f) => s + (f.qualityIssues.total > 0 ? f.qualityIssues.total : f.format_issues_count),
    0
  ) ?? 0
  const hasBlocking = data?.fields.some((f) => f.qualityIssues.blocking > 0) ?? false

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
      <div className="flex-1 flex items-center justify-center p-8">
        <div className="text-center">
          <p className="text-sm font-medium text-gray-900 mb-1">No data to profile</p>
          <p className="text-sm text-gray-500">
            Upload CSV files as source data to see profiling statistics. Tables created from DDL files do not have row data.
          </p>
        </div>
      </div>
    )
  }

  return (
    <div className="flex flex-col gap-4">
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
        <div className="flex-1 flex items-center justify-center p-8">
          <div className="text-center">
            <p className="text-sm text-gray-500">Select a table to view profiling data.</p>
          </div>
        </div>
      ) : loading ? (
        <div className="bg-white border border-gray-100 rounded-lg p-10 text-center">
          <div className="inline-block w-5 h-5 border-2 border-primary border-t-transparent rounded-full animate-spin" />
        </div>
      ) : error ? (
        <div className="bg-white border border-gray-100 rounded-lg p-6 text-center text-sm text-red-600">{error}</div>
      ) : !data ? (
        <div className="flex-1 flex items-center justify-center p-8">
          <div className="text-center">
            <p className="text-sm text-gray-500">No profiling data found for this table.</p>
          </div>
        </div>
      ) : (
        <>
          {/* Summary pills */}
          <div className="flex items-center gap-2">
            <div className="flex items-center gap-2 px-3 py-1.5 rounded-lg border border-gray-100 bg-white">
              <span className="text-xs text-gray-500">Rows</span>
              <span className="text-sm font-medium text-settle-slate-900">{data.table.row_count.toLocaleString()}</span>
            </div>
            <div className="flex items-center gap-2 px-3 py-1.5 rounded-lg border border-gray-100 bg-white">
              <span className="text-xs text-gray-500">Fields</span>
              <span className="text-sm font-medium text-settle-slate-900">{data.fields.length}</span>
            </div>
            <div className="flex items-center gap-2 px-3 py-1.5 rounded-lg border border-gray-100 bg-white">
              <span className="text-xs text-gray-500">Issues</span>
              <span className="text-sm font-medium text-settle-slate-900">
                {totalQualityIssues}
              </span>
            </div>
          </div>

          {/* Field-level table */}
          <div className="bg-white border border-gray-100 rounded-lg" style={{ overflowX: 'clip', overflowY: 'visible' }}>
            <div className="px-5 py-3 border-b border-gray-100">
              <span className="text-sm font-semibold text-settle-slate-900">Field-level profiling</span>
            </div>

            {data.fields.length === 0 ? (
              <div className="p-6 text-center text-sm text-gray-500">No fields found.</div>
            ) : (
              <table className="w-full text-sm">
                <thead className="bg-gray-50 border-b border-gray-100">
                  <tr>
                    <th className="text-left px-5 py-3 text-xs font-medium text-gray-500">Field name</th>
                    <th className="text-right px-5 py-3 text-xs font-medium text-gray-500">Null %</th>
                    <th className="text-right px-5 py-3 text-xs font-medium text-gray-500">Cardinality</th>
                    <th className="text-right px-5 py-3 text-xs font-medium text-gray-500">Unique %</th>
                    <th className="text-right px-5 py-3 text-xs font-medium text-gray-500">Data quality</th>
                  </tr>
                </thead>
                <tbody>
                  {data.fields.map((f) => (
                    <tr key={f.id} className="border-b border-gray-100 last:border-b-0 hover:bg-gray-50 transition-colors">
                      <td className="px-5 py-3 text-settle-slate-900 font-mono text-sm">{f.name}</td>
                      <td className="px-5 py-3 text-right text-sm text-settle-slate-600">
                        {f.null_percentage.toFixed(1)}%
                      </td>
                      <td className="px-5 py-3 text-right text-sm text-settle-slate-600">
                        {f.cardinality.toLocaleString()}
                      </td>
                      <td className="px-5 py-3 text-right text-sm text-settle-slate-600">
                        {f.unique_percentage.toFixed(1)}%
                      </td>
                      <td className="px-5 py-3 text-right">
                        <div className="relative inline-block">
                          {(() => {
                            // Unified display count: prefer materialised quality_issues rows,
                            // fall back to upload-time format_issues_count. Both paths open the
                            // same popover; the popover body branches on which data exists.
                            const displayCount =
                              f.qualityIssues.total > 0
                                ? f.qualityIssues.total
                                : f.format_issues_count
                            if (displayCount === 0) {
                              return <span className="text-sm text-settle-slate-300">—</span>
                            }
                            return (
                              <button
                                ref={(el) => { triggerRefs.current[f.id] = el }}
                                onClick={() =>
                                  setOpenQualityPopover(
                                    openQualityPopover === f.id ? null : f.id
                                  )
                                }
                                className={`text-sm cursor-pointer ${
                                  f.qualityIssues.blocking > 0
                                    ? 'text-red-600 hover:text-red-800'
                                    : 'text-amber-600 hover:text-amber-800'
                                }`}
                              >
                                {displayCount} {displayCount === 1 ? 'issue' : 'issues'}
                              </button>
                            )
                          })()}

                          {/* Quality issues popover */}
                          {openQualityPopover === f.id && (() => {
                            const displayCount =
                              f.qualityIssues.total > 0
                                ? f.qualityIssues.total
                                : f.format_issues_count
                            // Show the format-only fallback when no quality_issues rows
                            // have been materialised for this field but the upload-time
                            // profiling flagged format violations.
                            const showFormatFallback =
                              !loadingIssues &&
                              popoverIssues.length === 0 &&
                              f.format_issues_count > 0
                            return (
                            <div
                              ref={popoverRef}
                              className={`absolute right-0 z-50 w-80 bg-white rounded-lg shadow-lg border border-slate-200 ${
                                popoverPosition === 'above' ? 'bottom-full mb-2' : 'top-full mt-2'
                              }`}
                            >
                              <div className="flex items-center justify-between px-4 pt-4 pb-3">
                                <h4 className="text-sm font-semibold text-gray-900">
                                  {f.name}
                                  <span className="ml-1.5 font-normal text-gray-500">
                                    — {displayCount} issue{displayCount !== 1 ? 's' : ''}
                                  </span>
                                </h4>
                                <button
                                  onClick={() => setOpenQualityPopover(null)}
                                  className="text-slate-400 hover:text-slate-600 shrink-0"
                                >
                                  <X className="h-4 w-4" />
                                </button>
                              </div>

                              <div className="px-4 pb-3 max-h-72 overflow-y-auto">
                                {loadingIssues ? (
                                  <div className="flex items-center gap-2 py-3 text-xs text-gray-400">
                                    <span className="w-3.5 h-3.5 border-2 border-gray-200 border-t-gray-400 rounded-full animate-spin" />
                                    Loading…
                                  </div>
                                ) : showFormatFallback ? (
                                  <div className="text-xs">
                                    <div className="flex items-start gap-1.5">
                                      <AlertTriangle className="w-4 h-4 text-amber-500 shrink-0 mt-0.5" />
                                      <div>
                                        <p className="text-gray-700 leading-relaxed">
                                          {f.format_issues_count.toLocaleString()} value{f.format_issues_count !== 1 ? 's' : ''} don&apos;t match the expected format for type <span className="font-mono">{f.data_type}</span>.
                                        </p>
                                        <p className="text-gray-400 mt-0.5">
                                          Open Data Preview to inspect the offending values.
                                        </p>
                                      </div>
                                    </div>
                                  </div>
                                ) : (
                                  <div className="space-y-3">
                                    {popoverIssues.map((issue) => (
                                      <div key={issue.id} className="text-xs">
                                        <div className="flex items-start gap-1.5">
                                          {issue.severity === 'blocking' ? (
                                            <AlertTriangle className="w-4 h-4 text-red-500 shrink-0 mt-0.5" />
                                          ) : (
                                            <AlertTriangle className="w-4 h-4 text-amber-500 shrink-0 mt-0.5" />
                                          )}
                                          <div>
                                            <p className="text-gray-700 leading-relaxed">
                                              {issue.description}
                                            </p>
                                            {issue.affected_records > 0 && (
                                              <p className="text-gray-400 mt-0.5">
                                                {issue.affected_records.toLocaleString()} record{issue.affected_records !== 1 ? 's' : ''}
                                              </p>
                                            )}
                                          </div>
                                        </div>
                                      </div>
                                    ))}
                                  </div>
                                )}
                              </div>

                              <div className="px-4 py-3 border-t border-gray-100 flex items-center justify-between gap-2">
                                <p className="text-[11px] text-gray-400 leading-tight">
                                  {showFormatFallback
                                    ? 'Format issues · detected at upload'
                                    : 'Source issues · re-validated after staging'}
                                </p>
                                <button
                                  onClick={() => navigateToDataPreview(selectedTableId)}
                                  className="text-xs text-blue-600 hover:text-blue-800 font-medium whitespace-nowrap shrink-0"
                                >
                                  View in Data Preview →
                                </button>
                              </div>
                            </div>
                            )
                          })()}
                        </div>
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
