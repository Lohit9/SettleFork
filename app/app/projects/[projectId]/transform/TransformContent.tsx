'use client'

import { useState, useTransition, useCallback, useRef } from 'react'
import { useRouter } from 'next/navigation'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import {
  RefreshCw,
  Play,
  ChevronDown,
  ChevronRight,
  ArrowRight,
  AlertCircle,
  CheckCircle2,
  Zap,
} from '@/components/icons'
import {
  generateTransform,
  updateTransformSQL,
  testTransformation,
  saveTransformation,
  autoGenerateAllTransforms,
} from '@/lib/actions/transformations'
import type { TransformPageData, DatasetGroup, TableGroup, FieldItem } from '@/lib/actions/transformations'

interface Props {
  projectId: string
  initialData: TransformPageData
}

interface LocalTransform {
  transformationId: string | null
  description: string
  sql: string
  badge: 'ai' | 'modified' | 'none'
  status: 'draft' | 'tested' | 'saved'
}

interface TestResult {
  before: string | null
  after: string | null
}

// ── Helpers ───────────────────────────────────────────────────────────────────

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
  const [testResults, setTestResults] = useState<TestResult[]>([])
  const [testError, setTestError] = useState<string | null>(null)
  const [showSQL, setShowSQL] = useState(true)
  const [showSaveWarning, setShowSaveWarning] = useState(false)
  const [autoGenProgress, setAutoGenProgress] = useState<string | null>(null)
  const [toast, setToast] = useState<{ message: string; type: 'success' | 'error' } | null>(null)

  const [isGenerating, startGenerating] = useTransition()
  const [isTesting, startTesting] = useTransition()
  const [isSaving, startSaving] = useTransition()
  const [isAutoGen, startAutoGen] = useTransition()

  const sqlTextareaRef = useRef<HTMLTextAreaElement>(null)
  const sqlUpdateTimeout = useRef<ReturnType<typeof setTimeout> | null>(null)

  const needsTransformCount = countNeedsTransform(data.datasets)

  // ── Toast helpers ─────────────────────────────────────────────────────────

  function showToast(message: string, type: 'success' | 'error') {
    setToast({ message, type })
    setTimeout(() => setToast(null), 3500)
  }

  // ── Select a field ────────────────────────────────────────────────────────

  const handleSelectField = useCallback(
    (fieldMappingId: string) => {
      setSelectedMappingId(fieldMappingId)
      setTestResults([])
      setTestError(null)
      setShowSQL(true)

      const found = findField(data.datasets, fieldMappingId)
      if (!found) return

      const { field } = found
      if (field.transformation) {
        setLocalTransform({
          transformationId: field.transformation.id,
          description: field.transformation.description ?? '',
          sql: field.transformation.generated_sql,
          badge: field.transformation.is_ai_generated ? 'ai' : 'modified',
          status: field.transformation.status,
        })
        if (field.transformation.test_results) {
          const saved = field.transformation.test_results as TestResult[]
          setTestResults(saved)
        }
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
      prev
        ? { ...prev, description: '', sql: '', badge: 'none', status: 'draft' }
        : null
    )
    setTestResults([])
    setTestError(null)
  }

  // ── Generate Transform ────────────────────────────────────────────────────

  function handleGenerate() {
    if (!selectedMappingId || !localTransform) return
    const desc = localTransform.description.trim()
    if (!desc) {
      showToast('Enter a description first', 'error')
      return
    }

    startGenerating(async () => {
      const result = await generateTransform(selectedMappingId, desc)
      if (!result.success || !result.sql) {
        showToast(result.error ?? 'Generation failed', 'error')
        return
      }

      setLocalTransform((prev) =>
        prev
          ? {
              ...prev,
              sql: result.sql!,
              transformationId: result.transformationId ?? prev.transformationId,
              badge: 'ai',
              status: 'draft',
            }
          : null
      )
      setTestResults([])
      setTestError(null)
      // Update the field in data so status is reflected
      refreshFieldTransformation(selectedMappingId, result.transformationId ?? null, result.sql!, 'ai', desc)
    })
  }

  // ── SQL manual edit ───────────────────────────────────────────────────────

  function handleSqlChange(newSql: string) {
    setLocalTransform((prev) =>
      prev ? { ...prev, sql: newSql, badge: 'modified', status: 'draft' } : null
    )
    setTestResults([])
    setTestError(null)

    // Debounce persist to DB
    if (sqlUpdateTimeout.current) clearTimeout(sqlUpdateTimeout.current)
    sqlUpdateTimeout.current = setTimeout(() => {
      if (localTransform?.transformationId) {
        updateTransformSQL(localTransform.transformationId, newSql).catch(() => {})
      }
    }, 1000)
  }

  // ── Run Test ──────────────────────────────────────────────────────────────

  function handleRunTest() {
    if (!selectedMappingId || !localTransform?.sql) return

    startTesting(async () => {
      const result = await testTransformation(selectedMappingId, localTransform.sql)
      if (!result.success) {
        setTestError(result.error ?? 'Test failed')
        return
      }

      setTestResults(result.results ?? [])
      setTestError(null)
      setLocalTransform((prev) =>
        prev
          ? {
              ...prev,
              status: 'tested',
              transformationId: result.transformationId ?? prev.transformationId,
            }
          : null
      )
    })
  }

  // ── Save Transformation ───────────────────────────────────────────────────

  function handleSave() {
    if (!localTransform?.transformationId) return

    if (localTransform.status === 'draft') {
      setShowSaveWarning(true)
      return
    }
    doSave()
  }

  function doSave() {
    setShowSaveWarning(false)
    if (!localTransform?.transformationId) return

    startSaving(async () => {
      const result = await saveTransformation(localTransform.transformationId!)
      if (!result.success) {
        showToast(result.error ?? 'Save failed', 'error')
        return
      }
      setLocalTransform((prev) => (prev ? { ...prev, status: 'saved' } : null))
      showToast('Transformation saved', 'success')
    })
  }

  // ── Auto-Generate All ─────────────────────────────────────────────────────

  function handleAutoGenerate() {
    setAutoGenProgress('Generating transforms...')
    startAutoGen(async () => {
      const result = await autoGenerateAllTransforms(projectId)
      setAutoGenProgress(null)
      if (!result.success) {
        showToast(result.error ?? 'Auto-generation failed', 'error')
        return
      }
      showToast(
        `Generated ${result.generated} transform${result.generated !== 1 ? 's' : ''}${result.failed > 0 ? `, ${result.failed} failed` : ''}`,
        result.failed > 0 ? 'error' : 'success'
      )
      // Reload page data
      router.refresh()
    })
  }

  // ── Refresh a single field in local state after mutation ──────────────────

  function refreshFieldTransformation(
    fmId: string,
    transId: string | null,
    sql: string,
    badge: 'ai' | 'modified',
    description: string
  ) {
    setData((prev) => {
      const newDatasets = prev.datasets.map((ds) => ({
        ...ds,
        tables: ds.tables.map((tbl) => ({
          ...tbl,
          fields: tbl.fields.map((f) => {
            if (f.fieldMappingId !== fmId) return f
            return {
              ...f,
              needsTransform: true,
              transformation: f.transformation
                ? {
                    ...f.transformation,
                    generated_sql: sql,
                    is_ai_generated: badge === 'ai',
                    description,
                    status: 'draft' as const,
                    test_results: null,
                  }
                : transId
                ? {
                    id: transId,
                    field_mapping_id: fmId,
                    description,
                    generated_sql: sql,
                    is_ai_generated: badge === 'ai',
                    test_results: null,
                    status: 'draft' as const,
                    created_at: new Date().toISOString(),
                  }
                : null,
            }
          }),
        })),
      }))
      return { ...prev, datasets: newDatasets }
    })
  }

  // ── UI helpers ────────────────────────────────────────────────────────────

  const selectedContext = selectedMappingId
    ? findField(data.datasets, selectedMappingId)
    : null

  function statusBadge() {
    if (!localTransform) return null
    if (localTransform.status === 'saved') {
      return (
        <Badge className="bg-blue-100 text-blue-700 hover:bg-blue-100 border border-blue-200">
          <CheckCircle2 className="w-3 h-3 mr-1" />
          Saved
        </Badge>
      )
    }
    if (localTransform.status === 'tested') {
      return (
        <Badge className="bg-green-100 text-green-700 hover:bg-green-100 border border-green-200">
          <CheckCircle2 className="w-3 h-3 mr-1" />
          Tested
        </Badge>
      )
    }
    return (
      <Badge className="bg-gray-100 text-gray-600 hover:bg-gray-100 border border-gray-200">
        Untested
      </Badge>
    )
  }

  function sqlBadge() {
    if (!localTransform || localTransform.badge === 'none') return null
    if (localTransform.badge === 'ai') {
      return (
        <Badge className="bg-amber-100 text-amber-700 hover:bg-amber-100 border border-amber-200 text-xs">
          AI-Generated
        </Badge>
      )
    }
    return (
      <Badge className="bg-gray-100 text-gray-600 hover:bg-gray-100 border border-gray-200 text-xs">
        Modified
      </Badge>
    )
  }

  // ── Render ────────────────────────────────────────────────────────────────

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
          <Button
            variant="outline"
            onClick={() => router.push(`/app/projects/${projectId}/mapping`)}
          >
            Go to Mapping
          </Button>
        </div>
      </div>
    )
  }

  return (
    <div className="flex-1 bg-gray-50 flex overflow-hidden relative">
      {/* Toast */}
      {toast && (
        <div
          className={`fixed bottom-6 right-6 z-50 px-4 py-3 rounded-lg shadow-lg text-sm font-medium ${
            toast.type === 'success'
              ? 'bg-green-600 text-white'
              : 'bg-red-600 text-white'
          }`}
        >
          {toast.message}
        </div>
      )}

      {/* ── Left Sidebar ── */}
      <div className="w-80 bg-white border-r border-gray-200 flex flex-col flex-shrink-0">
        {/* Sidebar header */}
        <div className="p-4 border-b border-gray-200">
          <h2 className="text-sm font-semibold text-gray-900 mb-1">
            Select Fields to Transform
          </h2>
          <p className="text-xs text-gray-500">
            {needsTransformCount} field{needsTransformCount !== 1 ? 's' : ''} require
            transformation
          </p>
          {data.datasets.length > 0 && (
            <Button
              size="sm"
              variant="outline"
              className="mt-3 w-full gap-2 text-xs"
              onClick={handleAutoGenerate}
              disabled={isAutoGen}
            >
              <Zap className="w-3 h-3" />
              {isAutoGen
                ? autoGenProgress ?? 'Generating...'
                : 'Auto-Generate All Transforms'}
            </Button>
          )}
        </div>

        {/* Field tree */}
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
                onToggleDataset={(id) => {
                  setExpandedDatasets((prev) => {
                    const next = new Set(prev)
                    next.has(id) ? next.delete(id) : next.add(id)
                    return next
                  })
                }}
                onToggleTable={(id) => {
                  setExpandedTables((prev) => {
                    const next = new Set(prev)
                    next.has(id) ? next.delete(id) : next.add(id)
                    return next
                  })
                }}
                onSelectField={handleSelectField}
              />
            ))
          )}
        </div>
      </div>

      {/* ── Right Panel ── */}
      <div className="flex-1 flex flex-col overflow-hidden">
        {!selectedContext ? (
          /* Empty state: no field selected */
          <div className="flex-1 flex items-center justify-center p-8">
            <div className="text-center max-w-md">
              <div className="w-16 h-16 bg-gray-100 rounded-full flex items-center justify-center mx-auto mb-4">
                <ArrowRight className="w-8 h-8 text-gray-400" />
              </div>
              <h3 className="text-lg font-semibold text-gray-900 mb-2">
                Select a field to transform
              </h3>
              <p className="text-sm text-gray-600">
                Choose a field from the left panel to define or edit its
                transformation logic.
              </p>
            </div>
          </div>
        ) : (
          <>
            {/* Header */}
            <div className="bg-white border-b border-gray-200 px-6 py-5">
              <div className="flex items-start justify-between">
                <div>
                  <h1 className="text-2xl font-semibold text-gray-900 mb-1">
                    Transform Field
                  </h1>
                  <div className="flex items-center gap-2 text-sm text-gray-600">
                    <span className="font-medium">
                      {selectedContext.table.sourceTableName}.
                      {selectedContext.field.sourceFieldName}
                    </span>
                    <ArrowRight className="w-4 h-4 text-gray-400" />
                    <span className="font-medium">
                      {selectedContext.field.targetFieldName}
                    </span>
                  </div>
                </div>
                <div className="flex-shrink-0">{statusBadge()}</div>
              </div>
            </div>

            {/* Scrollable editor area */}
            <div className="flex-1 overflow-auto p-6 space-y-5">
              {/* NL Description card */}
              <div className="bg-white rounded-lg border border-gray-200 p-5">
                <label className="block text-sm font-medium text-gray-900 mb-3">
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
                  className="min-h-28 resize-none text-sm"
                />
                <div className="mt-4 flex items-center gap-3">
                  <Button
                    className="bg-[#4F46E5] hover:bg-[#4338CA] text-white gap-2"
                    onClick={handleGenerate}
                    disabled={isGenerating}
                  >
                    <RefreshCw
                      className={`w-4 h-4 ${isGenerating ? 'animate-spin' : ''}`}
                    />
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

              {/* "No transformation needed" info box */}
              {!selectedContext.field.needsTransform && !localTransform?.sql && (
                <div className="bg-blue-50 border border-blue-200 rounded-lg p-4">
                  <div className="flex items-start gap-3">
                    <AlertCircle className="w-4 h-4 text-blue-600 mt-0.5 flex-shrink-0" />
                    <div>
                      <p className="text-sm font-medium text-blue-900">
                        No transformation needed
                      </p>
                      <p className="text-xs text-blue-700 mt-0.5">
                        This field can be mapped directly without transformation.
                        If you need to add a transformation, describe the logic
                        above.
                      </p>
                    </div>
                  </div>
                </div>
              )}

              {/* Generated SQL card */}
              {localTransform?.sql && (
                <div className="bg-white rounded-lg border border-gray-200">
                  <div className="px-5 py-3 border-b border-gray-200 flex items-center justify-between">
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-semibold text-gray-900">
                        Generated SQL
                      </span>
                      {sqlBadge()}
                    </div>
                    <button
                      className="flex items-center gap-1 text-xs text-gray-500 hover:text-gray-700"
                      onClick={() => setShowSQL((v) => !v)}
                    >
                      {showSQL ? (
                        <>
                          <ChevronDown className="w-4 h-4" />
                          Hide SQL
                        </>
                      ) : (
                        <>
                          <ChevronRight className="w-4 h-4" />
                          Show SQL
                        </>
                      )}
                    </button>
                  </div>

                  {showSQL && (
                    <div className="p-4">
                      <textarea
                        ref={sqlTextareaRef}
                        value={localTransform.sql}
                        onChange={(e) => handleSqlChange(e.target.value)}
                        className="w-full font-mono text-xs text-gray-800 bg-gray-50 rounded border border-gray-200 p-4 resize-none focus:outline-none focus:ring-2 focus:ring-[#4F46E5]/30 focus:border-[#4F46E5]"
                        rows={Math.max(4, localTransform.sql.split('\n').length + 1)}
                        spellCheck={false}
                      />
                    </div>
                  )}
                </div>
              )}

              {/* Test Transformation card */}
              {localTransform?.sql && (
                <div className="bg-white rounded-lg border border-gray-200">
                  <div className="px-5 py-3 border-b border-gray-200 flex items-center justify-between">
                    <span className="text-sm font-semibold text-gray-900">
                      Test Transformation
                    </span>
                    <Button
                      size="sm"
                      variant="outline"
                      className="gap-2"
                      onClick={handleRunTest}
                      disabled={isTesting}
                    >
                      <Play className="w-4 h-4" />
                      {isTesting ? 'Running...' : 'Run Test'}
                    </Button>
                  </div>

                  {testError && (
                    <div className="mx-4 mt-4 p-3 bg-red-50 border border-red-200 rounded text-xs text-red-700 font-mono">
                      {testError}
                    </div>
                  )}

                  {testResults.length > 0 && (
                    <div className="p-4">
                      <table className="w-full">
                        <thead>
                          <tr className="border-b border-gray-200">
                            <th className="text-left text-xs font-medium text-gray-600 pb-2">
                              Before
                            </th>
                            <th className="w-8" />
                            <th className="text-left text-xs font-medium text-gray-600 pb-2">
                              After
                            </th>
                          </tr>
                        </thead>
                        <tbody>
                          {testResults.map((row, i) => (
                            <tr
                              key={i}
                              className="border-b border-gray-100 last:border-0"
                            >
                              <td className="py-2 text-sm text-gray-500">
                                {row.before ?? <span className="text-gray-400 italic">null</span>}
                              </td>
                              <td className="py-2 text-center">
                                <ArrowRight className="w-3 h-3 text-gray-400 mx-auto" />
                              </td>
                              <td className="py-2 text-sm text-gray-900 font-medium">
                                {row.after ?? <span className="text-gray-400 italic">null</span>}
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}

                  {!testError && testResults.length === 0 && (
                    <p className="p-4 text-xs text-gray-500">
                      Click &ldquo;Run Test&rdquo; to see a before/after preview
                      with sample data.
                    </p>
                  )}
                </div>
              )}
            </div>

            {/* Footer */}
            <div className="border-t border-gray-200 bg-white px-6 py-4 flex items-center justify-between">
              {localTransform?.transformationId ? (
                <button
                  className="text-sm text-gray-600 hover:text-gray-900 underline-offset-2 hover:underline disabled:opacity-50"
                  onClick={handleSave}
                  disabled={isSaving}
                >
                  {isSaving ? 'Saving...' : 'Save Transformation'}
                </button>
              ) : (
                <span className="text-sm text-gray-400">
                  Generate a transform to save
                </span>
              )}
              <Button
                className="bg-[#4F46E5] hover:bg-[#4338CA] text-white"
                onClick={() =>
                  router.push(`/app/projects/${projectId}/data-quality`)
                }
              >
                Continue to Validation
              </Button>
            </div>
          </>
        )}
      </div>

      {/* Save without test warning modal */}
      {showSaveWarning && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30">
          <div className="bg-white rounded-xl shadow-xl p-6 max-w-sm w-full mx-4">
            <h3 className="text-base font-semibold text-gray-900 mb-2">
              Save untested transformation?
            </h3>
            <p className="text-sm text-gray-600 mb-5">
              This transformation has not been tested yet. It will be saved as a
              draft. You can test it later.
            </p>
            <div className="flex gap-3 justify-end">
              <Button
                variant="outline"
                size="sm"
                onClick={() => setShowSaveWarning(false)}
              >
                Cancel
              </Button>
              <Button
                size="sm"
                className="bg-[#4F46E5] hover:bg-[#4338CA] text-white"
                onClick={doSave}
              >
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
  dataset,
  expanded,
  expandedTables,
  selectedMappingId,
  onToggleDataset,
  onToggleTable,
  onSelectField,
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
        {expanded ? (
          <ChevronDown className="w-4 h-4 text-gray-500 flex-shrink-0" />
        ) : (
          <ChevronRight className="w-4 h-4 text-gray-500 flex-shrink-0" />
        )}
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
  table,
  expanded,
  selectedMappingId,
  onToggle,
  onSelectField,
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
          {expanded ? (
            <ChevronDown className="w-3.5 h-3.5 text-gray-400 flex-shrink-0" />
          ) : (
            <ChevronRight className="w-3.5 h-3.5 text-gray-400 flex-shrink-0" />
          )}
          <span className="text-xs font-semibold text-gray-800 truncate">
            {table.sourceTableName}
          </span>
        </div>
        <div className="flex items-center gap-1 flex-shrink-0 ml-2">
          <ArrowRight className="w-3 h-3 text-gray-400" />
          <span className="text-xs text-gray-500 truncate max-w-[90px]">
            {table.targetTableName}
          </span>
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

function FieldRow({
  field,
  isSelected,
  onSelect,
}: {
  field: FieldItem
  isSelected: boolean
  onSelect: () => void
}) {
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
          <span className="text-xs font-semibold text-gray-900 truncate">
            {field.sourceFieldName}
          </span>
        </div>
        <div className="flex items-center gap-1 flex-shrink-0">
          {field.transformation?.status === 'saved' && (
            <CheckCircle2 className="w-3 h-3 text-green-500" />
          )}
          {field.needsTransform && (
            <Badge className="bg-orange-100 text-orange-700 hover:bg-orange-100 border border-orange-200 text-[10px] px-1.5 py-0">
              Transform
            </Badge>
          )}
        </div>
      </div>
      <div className="flex items-center gap-1 pl-3">
        <ArrowRight className="w-3 h-3 text-gray-400 flex-shrink-0" />
        <span className="text-[11px] text-gray-500 truncate">
          {field.targetFieldName}
        </span>
      </div>
    </button>
  )
}
