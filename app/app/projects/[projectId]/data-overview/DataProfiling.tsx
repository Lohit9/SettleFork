'use client'

import { useState, useEffect } from 'react'
import { useRouter } from 'next/navigation'
import { getFieldProfiles, getFieldQualityIssues } from '@/lib/actions/data-overview'
import type { TableOption, ProfilingData } from '@/lib/actions/data-overview'
import { Select, SelectContent, SelectGroup, SelectItem, SelectLabel, SelectTrigger, SelectValue } from '@/components/ui/select'
import { X, AlertTriangle } from '@/components/icons'
import { Popover, PopoverContent, PopoverPortal, PopoverTrigger, PopoverClose } from '@/components/ui/popover'

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

type ProfileField = ProfilingData['fields'][number]

/**
 * Schema-aware issues derived from enriched structural metadata + the
 * upload-time profile. These are approximate (sample-values based) and
 * intentionally only surface when no materialised `quality_issues` rows
 * exist for the field — `runSourceDataChecks` is the authoritative source
 * once staging has run.
 */
type SchemaAwareIssue =
  | { kind: 'not_null'; affected: number }
  | { kind: 'check_in_list'; violations: string[]; totalSamples: number }

function deriveSchemaAwareIssues(f: ProfileField): SchemaAwareIssue[] {
  const out: SchemaAwareIssue[] = []

  if (!f.is_nullable && f.null_percentage > 0) {
    const affected =
      f.null_count > 0
        ? f.null_count
        : Math.max(1, Math.ceil((f.total_rows * f.null_percentage) / 100))
    out.push({ kind: 'not_null', affected })
  }

  const cc = f.check_constraint
  if (cc && cc.type === 'in_list' && cc.allowedValues?.length) {
    const allowed = new Set(cc.allowedValues.map((v) => v.toLowerCase()))
    const samples = f.sample_values ?? []
    const violations: string[] = []
    for (const raw of samples) {
      if (raw === null || raw === undefined) continue
      const s = String(raw).trim()
      if (!s) continue
      if (!allowed.has(s.toLowerCase())) violations.push(s)
    }
    if (violations.length > 0) {
      out.push({ kind: 'check_in_list', violations, totalSamples: samples.length })
    }
  }

  return out
}

/**
 * Returns the number rendered in the "Data quality" column for a field.
 * Priority cascade:
 *   1. materialised quality_issues rows (authoritative post-staging)
 *   2. upload-time format_issues_count + schema-aware approximations
 * This keeps the top "Issues" counter aligned with the per-row display.
 */
function displayIssueCount(f: ProfileField, schemaAwareCount: number): number {
  if (f.qualityIssues.total > 0) return f.qualityIssues.total
  return f.format_issues_count + schemaAwareCount
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
  // row count when present, otherwise fall back to format_issues_count plus
  // schema-aware approximations (NOT NULL violations, CHECK IN-list misses).
  // This keeps the top counter aligned with what's visible in the column —
  // without it, a single quality_issues row anywhere in the table would hide
  // every field's upload-time findings from the total.
  const totalQualityIssues = data?.fields.reduce((s, f) => {
    const schemaAware = deriveSchemaAwareIssues(f).length
    return s + displayIssueCount(f, schemaAware)
  }, 0) ?? 0
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
                  {data.fields.map((f) => {
                    const schemaAwareIssues = deriveSchemaAwareIssues(f)
                    const displayCount = displayIssueCount(f, schemaAwareIssues.length)
                    const hasStructuralViolation = schemaAwareIssues.length > 0
                    // Blocking (red) if quality_issues flagged blocking OR a structural
                    // violation was detected from enriched metadata. Format-only misses
                    // stay amber.
                    const isBlockingTone =
                      f.qualityIssues.blocking > 0 || hasStructuralViolation
                    // Fallback popover body covers the pre-staging case where no
                    // quality_issues rows exist yet but we detected upload-time issues.
                    const hasFallbackContent =
                      f.format_issues_count > 0 || schemaAwareIssues.length > 0
                    return (
                    <tr key={f.id} className="border-b border-gray-100 last:border-b-0 hover:bg-gray-50 transition-colors">
                      <td className="px-5 py-3 text-settle-slate-900 font-mono text-sm">
                        <div className="flex items-center gap-1.5 flex-wrap">
                          <span>{f.name}</span>
                          {f.is_primary_key && (
                            <span
                              title="Primary key"
                              className="inline-flex items-center rounded px-1.5 py-0 text-[10px] font-semibold tracking-wide font-sans bg-indigo-50 text-indigo-700 border border-indigo-100"
                            >
                              PK
                            </span>
                          )}
                          {f.is_foreign_key && (
                            <span
                              title={f.fk_reference ? `References ${f.fk_reference}` : 'Foreign key'}
                              className="inline-flex items-center rounded px-1.5 py-0 text-[10px] font-semibold tracking-wide font-sans bg-sky-50 text-sky-700 border border-sky-100"
                            >
                              FK
                            </span>
                          )}
                        </div>
                        {f.is_foreign_key && f.fk_reference && (
                          <div className="mt-0.5 text-[11px] font-sans font-normal text-settle-slate-400">
                            → {f.fk_reference}
                          </div>
                        )}
                      </td>
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
                          {displayCount === 0 ? (
                            <span className="text-sm text-settle-slate-300">—</span>
                          ) : (
                            <Popover
                              open={openQualityPopover === f.id}
                              onOpenChange={(o) => setOpenQualityPopover(o ? f.id : null)}
                            >
                              <PopoverTrigger asChild>
                                <button
                                  className={`text-sm cursor-pointer ${
                                    isBlockingTone
                                      ? 'text-red-600 hover:text-red-800'
                                      : 'text-amber-600 hover:text-amber-800'
                                  }`}
                                >
                                  {displayCount} {displayCount === 1 ? 'issue' : 'issues'}
                                </button>
                              </PopoverTrigger>

                              {/* Quality issues popover */}
                              <PopoverPortal>
                                <PopoverContent
                                  align="end"
                                  sideOffset={8}
                                  className="w-80 p-0 rounded-lg border-slate-200 overflow-visible"
                                >
                                  {(() => {
                                    // Show the upload-time fallback (format + schema-aware) when
                                    // no quality_issues rows have been materialised for this field.
                                    const showFallback =
                                      !loadingIssues &&
                                      popoverIssues.length === 0 &&
                                      hasFallbackContent
                                    return (
                            <>
                              <div className="flex items-center justify-between px-4 pt-4 pb-3">
                                <h4 className="text-sm font-semibold text-gray-900">
                                  {f.name}
                                  <span className="ml-1.5 font-normal text-gray-500">
                                    — {displayCount} issue{displayCount !== 1 ? 's' : ''}
                                  </span>
                                </h4>
                                <PopoverClose asChild>
                                  <button
                                    className="text-slate-400 hover:text-slate-600 shrink-0"
                                  >
                                    <X className="h-4 w-4" />
                                  </button>
                                </PopoverClose>
                              </div>

                              <div className="px-4 pb-3 max-h-72 overflow-y-auto">
                                {loadingIssues ? (
                                  <div className="flex items-center gap-2 py-3 text-xs text-gray-400">
                                    <span className="w-3.5 h-3.5 border-2 border-gray-200 border-t-gray-400 rounded-full animate-spin" />
                                    Loading…
                                  </div>
                                ) : showFallback ? (
                                  <div className="space-y-3 text-xs">
                                    {schemaAwareIssues.map((issue, idx) => (
                                      <div key={`sa-${idx}`}>
                                        <div className="flex items-start gap-1.5">
                                          <AlertTriangle className="w-4 h-4 text-red-500 shrink-0 mt-0.5" />
                                          <div>
                                            {issue.kind === 'not_null' ? (
                                              <>
                                                <p className="text-gray-700 leading-relaxed">
                                                  Schema says <span className="font-mono">NOT NULL</span> but ~{issue.affected.toLocaleString()} row{issue.affected !== 1 ? 's' : ''} have null values.
                                                </p>
                                                <p className="text-gray-400 mt-0.5">
                                                  Structural violation · {f.schema_source.replace('_', ' ')}
                                                </p>
                                              </>
                                            ) : (
                                              <>
                                                <p className="text-gray-700 leading-relaxed">
                                                  Sample values outside the allowed list: <span className="font-mono">{issue.violations.slice(0, 3).map((v) => v.length > 20 ? `${v.slice(0, 20)}…` : v).join(', ')}</span>{issue.violations.length > 3 && ` (+${issue.violations.length - 3} more)`}
                                                </p>
                                                <p className="text-gray-400 mt-0.5">
                                                  Approximate — based on {issue.totalSamples} sampled value{issue.totalSamples !== 1 ? 's' : ''}. Run validation for an exact count.
                                                </p>
                                              </>
                                            )}
                                          </div>
                                        </div>
                                      </div>
                                    ))}
                                    {f.format_issues_count > 0 && (
                                      <div>
                                        <div className="flex items-start gap-1.5">
                                          <AlertTriangle className="w-4 h-4 text-amber-500 shrink-0 mt-0.5" />
                                          <div>
                                            <p className="text-gray-700 leading-relaxed">
                                              {f.format_issues_count.toLocaleString()} value{f.format_issues_count !== 1 ? 's' : ''} don&apos;t match the expected format for type <span className="font-mono">{f.data_type}</span>.
                                            </p>
                                            <p className="text-gray-400 mt-0.5">
                                              Format issue · detected at upload
                                            </p>
                                          </div>
                                        </div>
                                      </div>
                                    )}
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
                                  {showFallback
                                    ? 'Upload-time findings · re-check after staging'
                                    : 'Source issues · re-validated after staging'}
                                </p>
                                <button
                                  onClick={() => navigateToDataPreview(selectedTableId)}
                                  className="text-xs text-blue-600 hover:text-blue-800 font-medium whitespace-nowrap shrink-0"
                                >
                                  View in Data Preview →
                                </button>
                              </div>
                            </>
                                    )
                                  })()}
                                </PopoverContent>
                              </PopoverPortal>
                            </Popover>
                          )}
                        </div>
                      </td>
                    </tr>
                    )
                  })}
                </tbody>
              </table>
            )}
          </div>
        </>
      )}
    </div>
  )
}
