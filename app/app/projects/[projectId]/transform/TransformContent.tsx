'use client'

import { useState, useEffect, useTransition, useCallback, useRef } from 'react'
import { useRouter } from 'next/navigation'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import {
  RefreshCw,
  ChevronDown,
  ChevronRight,
  ArrowRight,
  AlertCircle,
  CheckCircle2,
  Zap,
  Save,
  Database,
} from '@/components/icons'
import {
  generateTransform,
  updateTransformSQL,
  testTransformation,
  saveTransformation,
  autoGenerateAllTransforms,
  applyTransform,
  previewTransformDistinct,
} from '@/lib/actions/transformations'
import type { TransformPageData, DatasetGroup, TableGroup, FieldItem } from '@/lib/actions/transformations'
import { stageAllData } from '@/lib/actions/staging'

// ── Types ──────────────────────────────────────────────────────────────────────

interface Props {
  projectId: string
  initialData: TransformPageData
}

type LocalStatus = 'draft' | 'tested' | 'saved' | 'applied' | 'stale'

interface LocalTransform {
  transformationId: string | null
  description: string
  sql: string
  badge: 'ai' | 'modified' | 'none'
  status: LocalStatus
}

interface PreviewRow {
  before: string | null
  after: string | null
  count?: number
}

// ── Helpers ────────────────────────────────────────────────────────────────────

function countNeedsTransform(datasets: DatasetGroup[]): number {
  let n = 0
  for (const ds of datasets) {
    for (const tbl of ds.tables) {
      for (const f of tbl.fields) {
        if (f.needsTransform) n++
      }
    }
  }
  return n
}

function findField(
  datasets: DatasetGroup[],
  fieldMappingId: string
): { field: FieldItem; table: TableGroup; dataset: DatasetGroup } | null {
  for (const ds of datasets) {
    for (const tbl of ds.tables) {
      for (const f of tbl.fields) {
        if (f.fieldMappingId === fieldMappingId) {
          return { field: f, table: tbl, dataset: ds }
        }
      }
    }
  }
  return null
}

/** Detect rows where the after value is likely from the ELSE clause.
 *  Heuristic: any `after` value that is shared by 2+ distinct `before` values. */
function detectElseRows(rows: PreviewRow[]): Set<number> {
  const afterCount = new Map<string, number>()
  for (const row of rows) {
    if (row.after != null) {
      afterCount.set(row.after, (afterCount.get(row.after) ?? 0) + 1)
    }
  }
  const elseValues = new Set<string>()
  afterCount.forEach((cnt, val) => { if (cnt >= 2) elseValues.add(val) })

  const elseIndices = new Set<number>()
  rows.forEach((row, i) => {
    if (row.after != null && elseValues.has(row.after)) elseIndices.add(i)
  })
  return elseIndices
}

// ── TransformContent ──────────────────────────────────────────────────────────

export default function TransformContent({ projectId, initialData }: Props) {
  const router = useRouter()
  const [data, setData] = useState<TransformPageData>(initialData)
  const [selectedMappingId, setSelectedMappingId] = useState<string | null>(null)
  const [expandedDatasets, setExpandedDatasets] = useState<Set<string>>(
    new Set(initialData.datasets.map((d) => d.datasetId))
  )
  const [expandedTables, setExpandedTables] = useState<Set<string>>(
    new Set(
      initialData.datasets.flatMap((d) =>
        d.tables.length > 0 ? [d.tables[0].tableMappingId] : []
      )
    )
  )
  const [localTransform, setLocalTransform] = useState<LocalTransform | null>(null)

  // Preview state
  const [previewMode, setPreviewMode] = useState<'sample' | 'distinct'>('sample')
  const [previewLoading, setPreviewLoading] = useState(false)
  const [previewError, setPreviewError] = useState<string | null>(null)
  const [previewResults, setPreviewResults] = useState<PreviewRow[]>([])

  // Action states
  const [showSaveWarning, setShowSaveWarning] = useState(false)
  const [autoGenProgress, setAutoGenProgress] = useState<string | null>(null)
  const [applyResult, setApplyResult] = useState<{ rowsAffected: number } | null>(null)
  const [toast, setToast] = useState<{ message: string; type: 'success' | 'error' } | null>(null)
  const [stagingError, setStagingError] = useState<string | null>(null)

  const [isGenerating, startGenerating] = useTransition()
  const [isSaving, startSaving] = useTransition()
  const [isAutoGen, startAutoGen] = useTransition()
  const [isApplying, startApplying] = useTransition()
  const [isStaging, startStaging] = useTransition()

  const sqlUpdateTimeout = useRef<ReturnType<typeof setTimeout> | null>(null)
  const previewTimeout = useRef<ReturnType<typeof setTimeout> | null>(null)

  const needsTransformCount = countNeedsTransform(data.datasets)

  // ── Auto-preview: debounced on sql + selectedMappingId + previewMode ────────

  useEffect(() => {
    const sql = localTransform?.sql
    if (!sql?.trim() || !selectedMappingId) {
      setPreviewResults([])
      setPreviewError(null)
      return
    }

    setPreviewLoading(true)
    if (previewTimeout.current) clearTimeout(previewTimeout.current)

    previewTimeout.current = setTimeout(async () => {
      try {
        if (previewMode === 'distinct') {
          const result = await previewTransformDistinct(selectedMappingId, sql)
          if (result.success && result.results) {
            setPreviewResults(result.results)
            setPreviewError(null)
          } else {
            setPreviewError(result.error ?? 'Preview failed')
            setPreviewResults([])
          }
        } else {
          const result = await testTransformation(selectedMappingId, sql)
          if (result.success && result.results) {
            setPreviewResults(result.results)
            setPreviewError(null)
            // Reflect tested status in local transform
            setLocalTransform((prev) =>
              prev && prev.status === 'draft'
                ? { ...prev, status: 'tested', transformationId: result.transformationId ?? prev.transformationId }
                : prev
            )
          } else {
            setPreviewError(result.error ?? 'Preview failed')
            setPreviewResults([])
          }
        }
      } catch (err) {
        setPreviewError(err instanceof Error ? err.message : 'Preview failed')
        setPreviewResults([])
      } finally {
        setPreviewLoading(false)
      }
    }, 500)

    return () => {
      if (previewTimeout.current) clearTimeout(previewTimeout.current)
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [localTransform?.sql, selectedMappingId, previewMode])

  // ── Toast helper ──────────────────────────────────────────────────────────

  function showToast(message: string, type: 'success' | 'error') {
    setToast({ message, type })
    setTimeout(() => setToast(null), 4000)
  }

  // ── Select a field ────────────────────────────────────────────────────────

  const handleSelectField = useCallback(
    (fieldMappingId: string) => {
      setSelectedMappingId(fieldMappingId)
      setPreviewResults([])
      setPreviewError(null)
      setPreviewMode('sample')
      setApplyResult(null)

      const found = findField(data.datasets, fieldMappingId)
      if (!found) return

      const { field } = found
      if (field.transformation) {
        setLocalTransform({
          transformationId: field.transformation.id,
          description: field.transformation.description ?? '',
          sql: field.transformation.generated_sql,
          badge: field.transformation.is_ai_generated ? 'ai' : 'modified',
          status: field.transformation.status as LocalStatus,
        })
      } else {
        setLocalTransform({
          transformationId: null,
          description: '',
          sql: '',
          badge: 'none',
          status: 'draft',
        })
      }
    },
    [data.datasets]
  )

  // ── Clear ─────────────────────────────────────────────────────────────────

  function handleClear() {
    setLocalTransform((prev) =>
      prev ? { ...prev, description: '', sql: '', badge: 'none', status: 'draft' } : null
    )
    setPreviewResults([])
    setPreviewError(null)
    setApplyResult(null)
  }

  // ── Generate Transform ────────────────────────────────────────────────────

  function handleGenerate() {
    if (!selectedMappingId || !localTransform) return
    const desc = localTransform.description.trim()
    if (!desc) { showToast('Enter a description first', 'error'); return }

    startGenerating(async () => {
      const result = await generateTransform(selectedMappingId, desc)
      if (!result.success || !result.sql) {
        showToast(result.error ?? 'Generation failed', 'error')
        return
      }
      setLocalTransform((prev) =>
        prev ? {
          ...prev,
          sql: result.sql!,
          transformationId: result.transformationId ?? prev.transformationId,
          badge: 'ai',
          status: 'draft',
        } : null
      )
      setPreviewResults([])
      setPreviewError(null)
      setApplyResult(null)
      refreshFieldTransformation(selectedMappingId, result.transformationId ?? null, result.sql!, 'ai', desc, 'draft')
    })
  }

  // ── SQL manual edit ───────────────────────────────────────────────────────

  function handleSqlChange(newSql: string) {
    const prevStatus = localTransform?.status
    const newStatus: LocalStatus = prevStatus === 'applied' ? 'stale' : 'draft'

    setLocalTransform((prev) =>
      prev ? { ...prev, sql: newSql, badge: 'modified', status: newStatus } : null
    )
    setPreviewResults([])
    setPreviewError(null)
    setApplyResult(null)

    // Debounce persist to DB
    if (sqlUpdateTimeout.current) clearTimeout(sqlUpdateTimeout.current)
    sqlUpdateTimeout.current = setTimeout(() => {
      if (localTransform?.transformationId) {
        updateTransformSQL(localTransform.transformationId, newSql).catch(() => {})
      }
    }, 1000)
  }

  // ── Save ──────────────────────────────────────────────────────────────────

  function handleSave() {
    if (!localTransform?.transformationId) return
    if (localTransform.status === 'draft') { setShowSaveWarning(true); return }
    doSave()
  }

  function doSave() {
    setShowSaveWarning(false)
    if (!localTransform?.transformationId) return

    startSaving(async () => {
      const result = await saveTransformation(localTransform.transformationId!)
      if (!result.success) { showToast(result.error ?? 'Save failed', 'error'); return }
      setLocalTransform((prev) => prev ? { ...prev, status: 'saved' } : null)
      refreshFieldStatus(selectedMappingId!, 'saved')
      showToast('Transformation saved', 'success')
    })
  }

  // ── Apply Transform ───────────────────────────────────────────────────────

  function handleApply() {
    if (!selectedMappingId || !localTransform?.sql) return
    setApplyResult(null)

    startApplying(async () => {
      const result = await applyTransform(selectedMappingId, localTransform.sql)
      if (!result.success) {
        showToast(result.error ?? 'Apply failed', 'error')
        return
      }
      setLocalTransform((prev) => prev ? { ...prev, status: 'applied' } : null)
      refreshFieldStatus(selectedMappingId, 'applied')
      setApplyResult({ rowsAffected: result.rowsAffected })
      showToast(`Applied to ${result.rowsAffected.toLocaleString()} rows`, 'success')
    })
  }

  // ── Auto-Generate All ─────────────────────────────────────────────────────

  function handleAutoGenerate() {
    setAutoGenProgress('Generating transforms...')
    startAutoGen(async () => {
      const result = await autoGenerateAllTransforms(projectId)
      setAutoGenProgress(null)
      if (!result.success) { showToast(result.error ?? 'Auto-generation failed', 'error'); return }
      showToast(
        `Generated ${result.generated} transform${result.generated !== 1 ? 's' : ''}${result.failed > 0 ? `, ${result.failed} failed` : ''}`,
        result.failed > 0 ? 'error' : 'success'
      )
      router.refresh()
    })
  }

  // ── Stage All Data ────────────────────────────────────────────────────────

  function handleStageAll() {
    setStagingError(null)
    startStaging(async () => {
      const result = await stageAllData(projectId)
      if (!result.success && result.error) {
        setStagingError(result.error)
        showToast('Staging failed: ' + result.error, 'error')
        return
      }
      const totalRows = result.tables.reduce((s, t) => s + t.rowCount, 0)
      showToast(
        `Staged ${totalRows.toLocaleString()} rows across ${result.tables.length} table${result.tables.length !== 1 ? 's' : ''}`,
        'success'
      )
      router.refresh()
    })
  }

  // ── Refresh field state helpers ───────────────────────────────────────────

  function refreshFieldTransformation(
    fmId: string,
    transId: string | null,
    sql: string,
    badge: 'ai' | 'modified',
    description: string,
    status: LocalStatus
  ) {
    setData((prev) => ({
      ...prev,
      datasets: prev.datasets.map((ds) => ({
        ...ds,
        tables: ds.tables.map((tbl) => ({
          ...tbl,
          fields: tbl.fields.map((f) => {
            if (f.fieldMappingId !== fmId) return f
            return {
              ...f,
              needsTransform: true,
              transformation: f.transformation
                ? { ...f.transformation, generated_sql: sql, is_ai_generated: badge === 'ai', description, status, test_results: null }
                : transId
                ? { id: transId, field_mapping_id: fmId, description, generated_sql: sql, is_ai_generated: badge === 'ai', test_results: null, status, created_at: new Date().toISOString() }
                : null,
            }
          }),
        })),
      })),
    }))
  }

  function refreshFieldStatus(fmId: string, status: LocalStatus) {
    setData((prev) => ({
      ...prev,
      datasets: prev.datasets.map((ds) => ({
        ...ds,
        tables: ds.tables.map((tbl) => ({
          ...tbl,
          fields: tbl.fields.map((f) => {
            if (f.fieldMappingId !== fmId || !f.transformation) return f
            return { ...f, transformation: { ...f.transformation, status } }
          }),
        })),
      })),
    }))
  }

  // ── UI helpers ────────────────────────────────────────────────────────────

  const selectedContext = selectedMappingId ? findField(data.datasets, selectedMappingId) : null

  function statusBadge() {
    if (!localTransform) return null
    const s = localTransform.status
    if (s === 'applied') return (
      <Badge className="bg-green-100 text-green-700 hover:bg-green-100 border border-green-200">
        <CheckCircle2 className="w-3 h-3 mr-1" />Applied
      </Badge>
    )
    if (s === 'stale') return (
      <Badge className="bg-yellow-100 text-yellow-700 hover:bg-yellow-100 border border-yellow-200">
        <AlertCircle className="w-3 h-3 mr-1" />Stale
      </Badge>
    )
    if (s === 'saved') return (
      <Badge className="bg-blue-100 text-blue-700 hover:bg-blue-100 border border-blue-200">
        <CheckCircle2 className="w-3 h-3 mr-1" />Saved
      </Badge>
    )
    if (s === 'tested') return (
      <Badge className="bg-green-100 text-green-700 hover:bg-green-100 border border-green-200">
        <CheckCircle2 className="w-3 h-3 mr-1" />Tested
      </Badge>
    )
    return (
      <Badge className="bg-gray-100 text-gray-600 hover:bg-gray-100 border border-gray-200">
        Untested
      </Badge>
    )
  }

  function sqlBadge() {
    if (!localTransform || localTransform.badge === 'none') return null
    if (localTransform.badge === 'ai') return (
      <Badge className="bg-amber-100 text-amber-700 hover:bg-amber-100 border border-amber-200 text-xs">
        AI-Generated
      </Badge>
    )
    return (
      <Badge className="bg-gray-100 text-gray-600 hover:bg-gray-100 border border-gray-200 text-xs">
        Modified
      </Badge>
    )
  }

  // ── No mappings state ──────────────────────────────────────────────────────

  if (!data.hasMappings) {
    return (
      <div className="flex-1 flex items-center justify-center p-8">
        <div className="text-center max-w-md">
          <div className="w-16 h-16 bg-gray-100 rounded-full flex items-center justify-center mx-auto mb-4">
            <ArrowRight className="w-8 h-8 text-gray-400" />
          </div>
          <h3 className="text-lg font-semibold text-gray-900 mb-2">No mappings found</h3>
          <p className="text-sm text-gray-600 mb-4">
            Generate mappings in the Mapping tab to enable transformations.
          </p>
          <Button variant="outline" onClick={() => router.push(`/app/projects/${projectId}/mapping`)}>
            Go to Mapping
          </Button>
        </div>
      </div>
    )
  }

  // ── Main layout ────────────────────────────────────────────────────────────

  const elseIndices = detectElseRows(previewResults)

  return (
    <div className="flex-1 bg-gray-50 flex flex-col overflow-hidden relative">

      {/* Toast */}
      {toast && (
        <div className={`fixed bottom-6 right-6 z-50 px-4 py-3 rounded-lg shadow-lg text-sm font-medium ${
          toast.type === 'success' ? 'bg-green-600 text-white' : 'bg-red-600 text-white'
        }`}>
          {toast.message}
        </div>
      )}

      {/* ── Top bar ────────────────────────────────────────────────────────── */}
      <div className="bg-white border-b border-gray-200 px-6 py-4 flex items-center justify-between flex-shrink-0">
        <div>
          <h1 className="text-xl font-semibold text-gray-900">Select Fields to Transform</h1>
          <p className="text-sm text-gray-500 mt-0.5">
            {needsTransformCount} field{needsTransformCount !== 1 ? 's' : ''} require transformation
          </p>
        </div>
        <div className="flex items-center gap-3">
          {stagingError && (
            <p className="text-xs text-red-600 max-w-xs text-right">{stagingError}</p>
          )}
          <Button
            size="sm"
            variant="outline"
            className="gap-2 text-xs"
            onClick={handleAutoGenerate}
            disabled={isAutoGen || isStaging}
          >
            <Zap className="w-3 h-3" />
            {isAutoGen ? (autoGenProgress ?? 'Generating...') : 'Auto-Generate All Transforms'}
          </Button>
          <Button
            size="sm"
            className="bg-[#4F46E5] hover:bg-[#4338CA] text-white gap-2"
            onClick={handleStageAll}
            disabled={isStaging || isAutoGen}
          >
            <Database className="w-3 h-3" />
            {isStaging ? (
              <span className="flex items-center gap-1.5">
                <span className="w-3 h-3 border-2 border-white/30 border-t-white rounded-full animate-spin" />
                Staging data…
              </span>
            ) : 'Stage All Data'}
          </Button>
        </div>
      </div>

      {/* ── Body: sidebar + split panel ────────────────────────────────────── */}
      <div className="flex-1 flex overflow-hidden">

        {/* ── Left Sidebar ── */}
        <div className="w-72 bg-white border-r border-gray-200 flex flex-col flex-shrink-0">
          <div className="flex-1 overflow-auto p-3 space-y-2">
            {data.datasets.length === 0 ? (
              <p className="text-xs text-gray-500 text-center py-8">
                All fields are compatible — no transformations required.
              </p>
            ) : (
              data.datasets.map((ds) => (
                <DatasetNode
                  key={ds.datasetId}
                  dataset={ds}
                  expanded={expandedDatasets.has(ds.datasetId)}
                  expandedTables={expandedTables}
                  selectedMappingId={selectedMappingId}
                  onToggleDataset={(id) => setExpandedDatasets((prev) => {
                    const next = new Set(prev); next.has(id) ? next.delete(id) : next.add(id); return next
                  })}
                  onToggleTable={(id) => setExpandedTables((prev) => {
                    const next = new Set(prev); next.has(id) ? next.delete(id) : next.add(id); return next
                  })}
                  onSelectField={handleSelectField}
                />
              ))
            )}
          </div>
        </div>

        {/* ── Right area: empty state OR split panel ── */}
        <div className="flex-1 flex flex-col overflow-hidden">
          {!selectedContext ? (
            <div className="flex-1 flex items-center justify-center p-8">
              <div className="text-center max-w-md">
                <div className="w-16 h-16 bg-gray-100 rounded-full flex items-center justify-center mx-auto mb-4">
                  <ArrowRight className="w-8 h-8 text-gray-400" />
                </div>
                <h3 className="text-lg font-semibold text-gray-900 mb-2">Select a field to transform</h3>
                <p className="text-sm text-gray-600">
                  Choose a field from the left panel to define or edit its transformation logic.
                </p>
              </div>
            </div>
          ) : (
            <>
              {/* Split panel header */}
              <div className="bg-white border-b border-gray-200 px-6 py-3 flex items-center justify-between flex-shrink-0">
                <div className="flex items-center gap-3">
                  <span className="text-sm font-semibold text-gray-900">Transform Field</span>
                  <div className="flex items-center gap-1.5 text-sm text-gray-500">
                    <span className="font-medium text-gray-700">
                      {selectedContext.table.sourceTableName}.{selectedContext.field.sourceFieldName}
                    </span>
                    <ArrowRight className="w-3.5 h-3.5 text-gray-400" />
                    <span className="font-medium text-gray-700">
                      {selectedContext.field.targetFieldName}
                    </span>
                  </div>
                </div>
                <div className="flex-shrink-0">{statusBadge()}</div>
              </div>

              {/* Split panel body */}
              <div className="flex-1 flex overflow-hidden">

                {/* ── Left column: Transform Logic (~55%) ── */}
                <div className="flex flex-col overflow-hidden border-r border-gray-200" style={{ flex: '0 0 55%' }}>
                  <div className="flex-1 overflow-auto p-5 space-y-4">

                    {/* NL Description */}
                    <div className="bg-white rounded-lg border border-gray-200 p-4">
                      <label className="block text-sm font-medium text-gray-900 mb-2">
                        Describe how this field should be transformed
                      </label>
                      <Textarea
                        value={localTransform?.description ?? ''}
                        onChange={(e) =>
                          setLocalTransform((prev) =>
                            prev ? { ...prev, description: e.target.value } : null
                          )
                        }
                        placeholder="e.g., Convert account type values to uppercase and map 'Prospect' to 'PROSPECT', 'Customer' to 'CUSTOMER', and any other values to 'OTHER'"
                        className="min-h-20 resize-none text-sm"
                      />
                      <div className="mt-3 flex items-center gap-3">
                        <Button
                          className="bg-[#4F46E5] hover:bg-[#4338CA] text-white gap-2"
                          onClick={handleGenerate}
                          disabled={isGenerating}
                        >
                          <RefreshCw className={`w-4 h-4 ${isGenerating ? 'animate-spin' : ''}`} />
                          {isGenerating ? 'Generating...' : 'Generate Transform'}
                        </Button>
                        <button
                          className="text-sm text-gray-500 hover:text-gray-700 underline-offset-2 hover:underline"
                          onClick={handleClear}
                        >
                          Clear
                        </button>
                      </div>
                    </div>

                    {/* No transform needed info */}
                    {!selectedContext.field.needsTransform && !localTransform?.sql && (
                      <div className="bg-blue-50 border border-blue-200 rounded-lg p-4">
                        <div className="flex items-start gap-2">
                          <AlertCircle className="w-4 h-4 text-blue-600 mt-0.5 flex-shrink-0" />
                          <div>
                            <p className="text-sm font-medium text-blue-900">No transformation needed</p>
                            <p className="text-xs text-blue-700 mt-0.5">
                              This field maps directly. Use the form above to add a transform if needed.
                            </p>
                          </div>
                        </div>
                      </div>
                    )}

                    {/* Stale warning banner */}
                    {localTransform?.status === 'stale' && (
                      <div className="bg-yellow-50 border border-yellow-300 rounded-lg p-3">
                        <div className="flex items-start gap-2">
                          <AlertCircle className="w-4 h-4 text-yellow-600 mt-0.5 flex-shrink-0" />
                          <p className="text-sm text-yellow-800">
                            Transform has been modified since last apply.
                            Click <strong>Apply Transform</strong> to update the staged data.
                          </p>
                        </div>
                      </div>
                    )}

                    {/* Generated SQL */}
                    {localTransform?.sql && (
                      <div className="bg-white rounded-lg border border-gray-200">
                        <div className="px-4 py-2.5 border-b border-gray-200 flex items-center justify-between">
                          <div className="flex items-center gap-2">
                            <span className="text-sm font-semibold text-gray-900">Generated SQL</span>
                            {sqlBadge()}
                          </div>
                        </div>
                        <div className="p-4">
                          <textarea
                            value={localTransform.sql}
                            onChange={(e) => handleSqlChange(e.target.value)}
                            className="w-full font-mono text-xs text-gray-800 bg-gray-50 rounded border border-gray-200 p-3 resize-none focus:outline-none focus:ring-2 focus:ring-[#4F46E5]/30 focus:border-[#4F46E5]"
                            rows={Math.max(4, localTransform.sql.split('\n').length + 1)}
                            spellCheck={false}
                          />
                        </div>
                      </div>
                    )}

                    {/* Apply result */}
                    {applyResult && (
                      <div className="flex items-center gap-2 text-sm text-green-700 bg-green-50 border border-green-200 rounded-lg px-3 py-2">
                        <CheckCircle2 className="w-4 h-4 text-green-600 flex-shrink-0" />
                        Applied to {applyResult.rowsAffected.toLocaleString()} rows
                      </div>
                    )}
                  </div>

                  {/* Action buttons */}
                  {localTransform?.sql && (
                    <div className="border-t border-gray-200 bg-white px-4 py-3 flex items-center gap-3">
                      <Button
                        className="bg-[#4F46E5] hover:bg-[#4338CA] text-white gap-2 flex-1"
                        onClick={handleApply}
                        disabled={isApplying || !localTransform?.transformationId}
                      >
                        {isApplying ? (
                          <span className="flex items-center gap-2">
                            <span className="w-3.5 h-3.5 border-2 border-white/30 border-t-white rounded-full animate-spin" />
                            Applying…
                          </span>
                        ) : (
                          <>
                            <Database className="w-3.5 h-3.5" />
                            Apply Transform
                          </>
                        )}
                      </Button>
                      {localTransform?.transformationId && (
                        <button
                          className="text-sm text-gray-600 hover:text-gray-900 underline-offset-2 hover:underline disabled:opacity-50 flex items-center gap-1.5"
                          onClick={handleSave}
                          disabled={isSaving}
                        >
                          <Save className="w-3.5 h-3.5" />
                          {isSaving ? 'Saving...' : 'Save'}
                        </button>
                      )}
                    </div>
                  )}
                </div>

                {/* ── Right column: Live Preview (~45%) ── */}
                <div className="flex flex-col overflow-hidden" style={{ flex: '0 0 45%' }}>
                  <div className="px-4 py-2.5 bg-white border-b border-gray-100 flex items-center justify-between flex-shrink-0">
                    <span className="text-sm font-semibold text-gray-900">Preview</span>
                    {localTransform?.sql && (
                      <div className="flex items-center gap-1 bg-gray-100 rounded-md p-0.5">
                        <button
                          onClick={() => setPreviewMode('sample')}
                          className={`px-2.5 py-1 text-xs font-medium rounded transition-colors ${
                            previewMode === 'sample' ? 'bg-white text-gray-800 shadow-sm' : 'text-gray-500 hover:text-gray-700'
                          }`}
                        >
                          Sample (20)
                        </button>
                        <button
                          onClick={() => setPreviewMode('distinct')}
                          className={`px-2.5 py-1 text-xs font-medium rounded transition-colors ${
                            previewMode === 'distinct' ? 'bg-white text-gray-800 shadow-sm' : 'text-gray-500 hover:text-gray-700'
                          }`}
                        >
                          All Distinct
                        </button>
                      </div>
                    )}
                  </div>

                  <div className="flex-1 overflow-auto p-4">
                    {/* No SQL state */}
                    {!localTransform?.sql && (
                      <div className="h-full flex flex-col items-center justify-center text-center p-6">
                        {selectedContext.field.sampleValues.length > 0 ? (
                          <>
                            <p className="text-sm text-gray-500 mb-3">
                              Direct mapping — source values copied as-is.
                            </p>
                            <div className="w-full max-w-xs">
                              <p className="text-xs font-medium text-gray-500 mb-1.5 text-left">
                                Sample values ({selectedContext.field.sourceFieldName})
                              </p>
                              <div className="space-y-1">
                                {(selectedContext.field.sampleValues as string[]).slice(0, 10).map((v, i) => (
                                  <div key={i} className="text-xs text-gray-700 bg-gray-50 rounded px-2 py-1 text-left font-mono">
                                    {v != null ? String(v) : <span className="text-gray-400 italic">null</span>}
                                  </div>
                                ))}
                              </div>
                            </div>
                          </>
                        ) : (
                          <p className="text-sm text-gray-400">
                            Generate a transform to see the live preview.
                          </p>
                        )}
                      </div>
                    )}

                    {/* Loading */}
                    {localTransform?.sql && previewLoading && (
                      <div className="flex items-center justify-center h-32 gap-2 text-sm text-gray-500">
                        <span className="w-4 h-4 border-2 border-indigo-600 border-t-transparent rounded-full animate-spin" />
                        Previewing…
                      </div>
                    )}

                    {/* Error */}
                    {localTransform?.sql && !previewLoading && previewError && (
                      <div className="rounded-lg border border-red-200 bg-red-50 p-3 text-xs text-red-700 font-mono break-all">
                        {previewError}
                      </div>
                    )}

                    {/* Results table */}
                    {localTransform?.sql && !previewLoading && !previewError && previewResults.length > 0 && (
                      <div>
                        {previewResults.length > 0 && (
                          <p className="text-xs text-gray-400 mb-2">
                            {previewResults.length} {previewMode === 'distinct' ? 'distinct values' : 'rows'}
                            {elseIndices.size > 0 && (
                              <span className="ml-2 text-amber-600">
                                · {elseIndices.size} may hit ELSE clause
                              </span>
                            )}
                          </p>
                        )}
                        <table className="w-full text-xs">
                          <thead>
                            <tr className="border-b border-gray-200">
                              <th className="text-left font-medium text-gray-500 pb-1.5 pr-2">
                                Before ({selectedContext.field.sourceFieldName})
                              </th>
                              <th className="w-5" />
                              <th className="text-left font-medium text-gray-500 pb-1.5 pr-2">
                                After ({selectedContext.field.targetFieldName})
                              </th>
                              {previewMode === 'distinct' && (
                                <th className="text-right font-medium text-gray-500 pb-1.5">Count</th>
                              )}
                            </tr>
                          </thead>
                          <tbody>
                            {previewResults.map((row, i) => (
                              <tr key={i} className="border-b border-gray-100 last:border-0">
                                <td className="py-1.5 pr-2 text-gray-500 font-mono">
                                  {row.before ?? <span className="text-gray-400 italic">null</span>}
                                </td>
                                <td className="py-1.5 text-center">
                                  <ArrowRight className="w-3 h-3 text-gray-300 mx-auto" />
                                </td>
                                <td className="py-1.5 pr-2 font-medium text-gray-900 font-mono">
                                  <span className="flex items-center gap-1">
                                    {row.after ?? <span className="text-gray-400 italic font-normal">null</span>}
                                    {elseIndices.has(i) && (
                                      <span title="May hit ELSE clause — check for missing WHEN cases">
                                        <AlertCircle className="w-3 h-3 text-amber-500 flex-shrink-0" />
                                      </span>
                                    )}
                                  </span>
                                </td>
                                {previewMode === 'distinct' && (
                                  <td className="py-1.5 text-right text-gray-400">{(row.count ?? 0).toLocaleString()}</td>
                                )}
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    )}
                  </div>
                </div>
              </div>

              {/* Footer */}
              <div className="border-t border-gray-200 bg-white px-6 py-3 flex items-center justify-between flex-shrink-0">
                <span className="text-xs text-gray-400">
                  Use <strong>Apply Transform</strong> to update staged data for individual fields,
                  or <strong>Stage All Data</strong> to rebuild everything at once.
                </span>
                <div className="flex flex-col items-end gap-1">
                  {stagingError && (
                    <p className="text-xs text-red-600 max-w-xs text-right">{stagingError}</p>
                  )}
                  <Button
                    className="bg-[#4F46E5] hover:bg-[#4338CA] text-white disabled:opacity-60"
                    disabled={isStaging}
                    onClick={() => {
                      setStagingError(null)
                      startStaging(async () => {
                        const result = await stageAllData(projectId)
                        if (!result.success && result.error) {
                          setStagingError(result.error)
                          return
                        }
                        router.push(`/app/projects/${projectId}/data-quality`)
                      })
                    }}
                  >
                    {isStaging ? (
                      <span className="flex items-center gap-2">
                        <span className="w-3.5 h-3.5 border-2 border-white/30 border-t-white rounded-full animate-spin" />
                        Staging…
                      </span>
                    ) : 'Continue to Validation'}
                  </Button>
                </div>
              </div>
            </>
          )}
        </div>
      </div>

      {/* Save without test modal */}
      {showSaveWarning && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30">
          <div className="bg-white rounded-xl shadow-xl p-6 max-w-sm w-full mx-4">
            <h3 className="text-base font-semibold text-gray-900 mb-2">Save untested transformation?</h3>
            <p className="text-sm text-gray-600 mb-5">
              This transformation has not been tested yet. It will be saved as a draft.
            </p>
            <div className="flex gap-3 justify-end">
              <Button variant="outline" size="sm" onClick={() => setShowSaveWarning(false)}>Cancel</Button>
              <Button size="sm" className="bg-[#4F46E5] hover:bg-[#4338CA] text-white" onClick={doSave}>
                Save Anyway
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

// ── DatasetNode ───────────────────────────────────────────────────────────────

function DatasetNode({
  dataset, expanded, expandedTables, selectedMappingId,
  onToggleDataset, onToggleTable, onSelectField,
}: {
  dataset: DatasetGroup
  expanded: boolean
  expandedTables: Set<string>
  selectedMappingId: string | null
  onToggleDataset: (id: string) => void
  onToggleTable: (id: string) => void
  onSelectField: (id: string) => void
}) {
  return (
    <div className="border border-gray-200 rounded-lg overflow-hidden">
      <button
        onClick={() => onToggleDataset(dataset.datasetId)}
        className="w-full flex items-center gap-2 px-3 py-2.5 bg-white hover:bg-gray-50 transition-colors"
      >
        {expanded ? <ChevronDown className="w-4 h-4 text-gray-500 flex-shrink-0" /> : <ChevronRight className="w-4 h-4 text-gray-500 flex-shrink-0" />}
        <span className="text-xs font-bold text-[#4F46E5] truncate uppercase tracking-wide">
          {dataset.datasetName}
        </span>
      </button>
      {expanded && (
        <div className="border-t border-gray-200 divide-y divide-gray-100">
          {dataset.tables.map((tbl) => (
            <TableNode
              key={tbl.tableMappingId}
              table={tbl}
              expanded={expandedTables.has(tbl.tableMappingId)}
              selectedMappingId={selectedMappingId}
              onToggle={() => onToggleTable(tbl.tableMappingId)}
              onSelectField={onSelectField}
            />
          ))}
        </div>
      )}
    </div>
  )
}

// ── TableNode ─────────────────────────────────────────────────────────────────

function TableNode({
  table, expanded, selectedMappingId, onToggle, onSelectField,
}: {
  table: TableGroup
  expanded: boolean
  selectedMappingId: string | null
  onToggle: () => void
  onSelectField: (id: string) => void
}) {
  return (
    <div>
      <button
        onClick={onToggle}
        className="w-full flex items-center justify-between px-3 py-2.5 bg-white hover:bg-gray-50 transition-colors"
      >
        <div className="flex items-center gap-2 min-w-0">
          {expanded ? <ChevronDown className="w-3.5 h-3.5 text-gray-400 flex-shrink-0" /> : <ChevronRight className="w-3.5 h-3.5 text-gray-400 flex-shrink-0" />}
          <span className="text-xs font-semibold text-gray-800 truncate">{table.sourceTableName}</span>
        </div>
        <div className="flex items-center gap-1 flex-shrink-0 ml-2">
          <ArrowRight className="w-3 h-3 text-gray-400" />
          <span className="text-xs text-gray-500 truncate max-w-[80px]">{table.targetTableName}</span>
        </div>
      </button>
      {expanded && (
        <div className="bg-gray-50 border-t border-gray-100">
          {table.fields.map((field) => (
            <FieldRow
              key={field.fieldMappingId}
              field={field}
              isSelected={selectedMappingId === field.fieldMappingId}
              onSelect={() => onSelectField(field.fieldMappingId)}
            />
          ))}
        </div>
      )}
    </div>
  )
}

// ── FieldRow ──────────────────────────────────────────────────────────────────

function FieldRow({ field, isSelected, onSelect }: {
  field: FieldItem
  isSelected: boolean
  onSelect: () => void
}) {
  const status = field.transformation?.status

  return (
    <button
      onClick={onSelect}
      className={`w-full px-3 py-2.5 border-b border-gray-100 last:border-0 text-left transition-colors ${
        isSelected
          ? 'bg-indigo-50 border-l-2 border-l-[#4F46E5]'
          : 'border-l-2 border-l-transparent hover:bg-gray-100'
      }`}
    >
      <div className="flex items-start justify-between gap-2 mb-0.5">
        <div className="flex items-center gap-1.5 min-w-0 flex-1">
          <div className="w-1.5 h-1.5 rounded-full bg-gray-400 flex-shrink-0 mt-0.5" />
          <span className="text-xs font-semibold text-gray-900 truncate">{field.sourceFieldName}</span>
        </div>
        <div className="flex items-center gap-1 flex-shrink-0">
          {/* Status icon */}
          {status === 'applied' && (
            <CheckCircle2 className="w-3.5 h-3.5 text-green-500" title="Applied to staged data" />
          )}
          {status === 'stale' && (
            <AlertCircle className="w-3.5 h-3.5 text-yellow-500" title="Transform edited after apply — re-apply needed" />
          )}
          {(status === 'saved' || status === 'tested') && (
            <Save className="w-3 h-3 text-blue-500" title="Saved but not yet applied to staged data" />
          )}
          {field.needsTransform && !field.transformation && (
            <Badge className="bg-orange-100 text-orange-700 hover:bg-orange-100 border border-orange-200 text-[10px] px-1.5 py-0">
              Transform
            </Badge>
          )}
        </div>
      </div>
      <div className="flex items-center gap-1 pl-3">
        <ArrowRight className="w-3 h-3 text-gray-400 flex-shrink-0" />
        <span className="text-[11px] text-gray-500 truncate">{field.targetFieldName}</span>
      </div>
    </button>
  )
}
