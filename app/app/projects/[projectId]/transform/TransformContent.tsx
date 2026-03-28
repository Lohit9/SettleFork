'use client'

import { useState, useEffect, useTransition, useCallback, useRef, useMemo } from 'react'
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
  AlertTriangle,
  CheckCircle2,
  Zap,
  Database,
  Sparkles,
  Play,
} from '@/components/icons'
import {
  generateTransform,
  autoSaveTransform,
  runFullTransformTest,
  testTransformation,
  autoGenerateAllTransforms,
  applyTransform,
  previewTransformDistinct,
  suggestTransformDescription,
} from '@/lib/actions/transformations'
import type { TransformPageData, DatasetGroup, TableGroup, FieldItem, FullTransformTestResult, UnmappedTargetField } from '@/lib/actions/transformations'
import { stageAllData, getBlockingSourceIssues, getSourceIssuesForField, checkProjectStaleness } from '@/lib/actions/staging'
import type { BlockingIssue, FieldSourceIssue } from '@/lib/actions/staging'
import { sourcePreviewValueMatchesIssues, maxAffectedRecordsForField } from '@/lib/quality/preview-source-issue-match'
import StagingWarningPopup from '@/components/StagingWarningPopup'

// ── Types ──────────────────────────────────────────────────────────────────────

interface Props {
  projectId: string
  initialData: TransformPageData
}

type LocalStatus = 'draft' | 'tested' | 'applied' | 'stale'

interface LocalTransform {
  transformationId: string | null
  description: string
  sql: string
  badge: 'ai' | 'modified' | 'none'
  status: LocalStatus
}

interface PreviewRow {
  before: string | null                             // primary source field value
  beforeValues?: Record<string, string | null>      // all source fields (keyed by name) for many-to-one
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

/** Extract the ELSE clause value from a SQL CASE expression.
 *  Returns null if ELSE is NULL, there is no ELSE, or the value can't be parsed. */
function extractElseValue(sql: string): string | null {
  if (!sql) return null
  // ELSE 'string literal' — most common pattern from Claude
  const strMatch = sql.match(/\bELSE\s+'([^']*)'/i)
  if (strMatch) return strMatch[1]
  // ELSE <integer or decimal> — e.g. ELSE 0
  const numMatch = sql.match(/\bELSE\s+(-?\d+(?:\.\d+)?)\b/i)
  if (numMatch) return numMatch[1]
  // ELSE NULL or no parseable ELSE → no warnings
  return null
}

/** Flag rows whose transformed value came from the ELSE clause.
 *  Parses the ELSE value out of the SQL string so only true ELSE-path rows
 *  get a warning — rows that matched an explicit WHEN clause are never flagged,
 *  even when multiple source values share the same explicit mapping target. */
function detectElseRows(rows: PreviewRow[], sql?: string | null): Set<number> {
  const elseValue = extractElseValue(sql ?? '')
  if (elseValue === null) return new Set()

  const elseIndices = new Set<number>()
  rows.forEach((row, i) => {
    if (row.after !== null && row.after === elseValue) {
      elseIndices.add(i)
    }
  })
  return elseIndices
}

// ── UI helpers ─────────────────────────────────────────────────────────────────

function getTargetConstraintHint(field: FieldItem): string {
  const parts: string[] = [field.targetFieldDataType]
  if (!field.targetFieldIsNullable) parts.push('required')
  if (field.targetFieldIsPrimaryKey) parts.push('PK')
  return parts.join(' · ')
}

function getSmartPlaceholder(field: FieldItem): string {
  const compat = (field.typeCompatibility ?? '').toLowerCase()
  const reason = (field.aiReasoning ?? '').toLowerCase()
  const src = field.sourceFieldName
  const tgt = field.targetFieldName

  if (compat.includes('truncat'))
    return `e.g., "Truncate ${src} to fit ${tgt} max length"`
  if (compat.includes('date') || reason.includes('date'))
    return `e.g., "Convert ${src} string to ISO date format for ${tgt}"`
  if (reason.includes('prefix') || reason.includes('suffix'))
    return `e.g., "Strip prefix from ${src} before loading to ${tgt}"`
  if (reason.includes('uppercase') || reason.includes('case'))
    return `e.g., "Convert ${src} values to uppercase for ${tgt}"`
  return `e.g., "Describe how ${src} should be transformed for ${tgt}"`
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
  // Whether the Generated SQL panel is expanded; auto-collapses on new AI generation
  const [sqlExpanded, setSqlExpanded] = useState(false)

  // Preview state
  const [previewMode, setPreviewMode] = useState<'sample' | 'distinct'>('sample')
  const [previewLoading, setPreviewLoading] = useState(false)
  const [previewError, setPreviewError] = useState<string | null>(null)
  const [previewResults, setPreviewResults] = useState<PreviewRow[]>([])

  // Full-run test state
  const [testResult, setTestResult] = useState<FullTransformTestResult | null>(null)
  const [isTesting, startTesting] = useTransition()

  // Auto-save state
  const [saveStatus, setSaveStatus] = useState<'idle' | 'saving' | 'saved'>('idle')
  const savedFadeTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  // Action states
  const [autoGenProgress, setAutoGenProgress] = useState<string | null>(null)
  const [applyResult, setApplyResult] = useState<{ rowsAffected: number } | null>(null)
  const [toast, setToast] = useState<{ message: string; type: 'success' | 'error' } | null>(null)
  const [stagingError, setStagingError] = useState<string | null>(null)

  const [isGenerating, startGenerating] = useTransition()
  const [isAutoGen, startAutoGen] = useTransition()
  const [isApplying, startApplying] = useTransition()
  const [isStaging, startStaging] = useTransition()
  const [isSuggesting, startSuggesting] = useTransition()

  // Staging warning popup — shown when blocking source issues exist before staging
  const [showStagingWarning, setShowStagingWarning] = useState(false)
  const [stagingBlockingIssues, setStagingBlockingIssues] = useState<BlockingIssue[]>([])
  const [stagingProceedLabel, setStagingProceedLabel] = useState('Stage All — Review Flagged Rows')
  const [isCheckingIssues, setIsCheckingIssues] = useState(false)
  // Stores the actual staging action to run after the user dismisses the warning
  const pendingStagingFnRef = useRef<(() => void) | null>(null)
  // Deep-link URL for "Fix Issues →" button in the popup
  const fixIssuesUrlRef = useRef<string>(`/app/projects/${projectId}/data-quality?stage=source&severity=blocking&status=open`)

  // Staleness — table mapping IDs where source data was changed after last staging run
  const [staleTableMappingIds, setStaleTableMappingIds] = useState<Set<string>>(new Set())

  // Open source quality issues for the currently selected field (for Data Preview flagging)
  const [fieldSourceIssues, setFieldSourceIssues] = useState<FieldSourceIssue[]>([])

  // Unmapped NOT NULL target fields — sidebar selection
  const [selectedUnmappedFieldId, setSelectedUnmappedFieldId] = useState<string | null>(null)

  // "Why transform?" collapsible (collapsed by default — it's reference info)
  const [whyExpanded, setWhyExpanded] = useState(false)
  // AI Suggest: confirm before replacing existing textarea content
  const [showReplaceConfirm, setShowReplaceConfirm] = useState<string | null>(null)

  // Auto-save refs — use refs so handleSelectField can access latest values without stale closure
  const localTransformRef = useRef<LocalTransform | null>(null)
  const selectedMappingIdRef = useRef<string | null>(null)
  const isDirtyRef = useRef(false)
  const autoSaveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const previewTimeout = useRef<ReturnType<typeof setTimeout> | null>(null)

  // Keep refs in sync with state
  useEffect(() => { localTransformRef.current = localTransform }, [localTransform])
  useEffect(() => { selectedMappingIdRef.current = selectedMappingId }, [selectedMappingId])

  const needsTransformCount = useMemo(() => countNeedsTransform(data.datasets), [data.datasets])

  // DISABLED: Source-data staleness check — will re-enable with per-field tracking later
  // useEffect(() => {
  //   checkProjectStaleness(projectId).then(({ staleTableMappingIds: ids }) => {
  //     if (ids.length > 0) setStaleTableMappingIds(new Set(ids))
  //   }).catch(() => {})
  // // eslint-disable-next-line react-hooks/exhaustive-deps
  // }, [])

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

    // Capture contributing field names at schedule time (not inside the timeout closure)
    // so we always use the names for the field that triggered this effect run.
    const contributingNames = (selectedContext?.field.contributingSourceFields ?? []).map((f) => f.name)

    previewTimeout.current = setTimeout(async () => {
      try {
        if (previewMode === 'distinct') {
          const result = await previewTransformDistinct(
            selectedMappingId,
            sql,
            contributingNames.length > 0 ? contributingNames : undefined
          )
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

  // ── Auto-save helpers ─────────────────────────────────────────────────────

  /**
   * Patch the in-memory data.datasets tree after an auto-save so that switching
   * fields (which reads from data.datasets) sees the freshly saved content.
   * Matches by transformation.id, not fieldMappingId, because that's what we
   * have available inside flushAutoSave without a stale closure.
   */
  function refreshFieldTransformContent(
    transformationId: string,
    sql: string,
    description: string,
    status?: 'draft' | 'tested' | 'saved' | 'applied' | 'stale'
  ) {
    setData((prev) => ({
      ...prev,
      datasets: prev.datasets.map((ds) => ({
        ...ds,
        tables: ds.tables.map((tbl) => ({
          ...tbl,
          fields: tbl.fields.map((f) => {
            if (f.transformation?.id !== transformationId) return f
            return {
              ...f,
              transformation: {
                ...f.transformation,
                generated_sql: sql,
                description: description || null,
                ...(status ? { status } : {}),
              },
            }
          }),
        })),
      })),
    }))
  }

  /**
   * Persist the current transform (sql, description, status) to DB, then patch
   * data.datasets so field switching reads the saved values — not stale initialData.
   */
  async function flushAutoSave() {
    const lt = localTransformRef.current
    const fmId = selectedMappingIdRef.current
    if (!lt?.transformationId || !fmId || !isDirtyRef.current) return
    isDirtyRef.current = false
    setSaveStatus('saving')
    try {
      const result = await autoSaveTransform(lt.transformationId, lt.sql, lt.description, lt.status)
      if (result.success) {
        // Patch the in-memory tree so handleSelectField reads fresh data on field switch
        refreshFieldTransformContent(lt.transformationId, lt.sql, lt.description, lt.status)
      }
      setSaveStatus('saved')
      if (savedFadeTimer.current) clearTimeout(savedFadeTimer.current)
      savedFadeTimer.current = setTimeout(() => setSaveStatus('idle'), 2500)
    } catch {
      setSaveStatus('idle')
    }
  }

  /** Schedule a debounced auto-save; call flushAutoSave() to cancel + flush immediately */
  function scheduleAutoSave() {
    isDirtyRef.current = true
    setSaveStatus('saving')
    if (autoSaveTimerRef.current) clearTimeout(autoSaveTimerRef.current)
    autoSaveTimerRef.current = setTimeout(() => flushAutoSave(), 800)
  }

  // Flush on unmount (tab/page navigation) — fire-and-forget using refs
  useEffect(() => {
    return () => {
      const lt = localTransformRef.current
      const fmId = selectedMappingIdRef.current
      if (autoSaveTimerRef.current) clearTimeout(autoSaveTimerRef.current)
      if (isDirtyRef.current && lt?.transformationId && fmId) {
        // Fire-and-forget — don't block unmount
        autoSaveTransform(lt.transformationId, lt.sql, lt.description, lt.status).catch(() => {})
      }
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // ── Toast helper ──────────────────────────────────────────────────────────

  function showToast(message: string, type: 'success' | 'error') {
    setToast({ message, type })
    setTimeout(() => setToast(null), 4000)
  }

  // ── Select a field ────────────────────────────────────────────────────────

  const handleSelectField = useCallback(
    async (fieldMappingId: string) => {
      // Flush any pending auto-save for the PREVIOUS field before switching.
      // Must await so the DB write completes before we load the new field's data.
      if (autoSaveTimerRef.current) clearTimeout(autoSaveTimerRef.current)
      await flushAutoSave()

      setSelectedMappingId(fieldMappingId)
      setSelectedUnmappedFieldId(null)
      setPreviewResults([])
      setPreviewError(null)
      setPreviewMode('sample')
      setApplyResult(null)
      setTestResult(null)
      setSqlExpanded(false)
      setWhyExpanded(false)
      setSaveStatus('idle')
      isDirtyRef.current = false

      const found = findField(data.datasets, fieldMappingId)
      if (!found) return

      const { field } = found

      // Load open source issues for this field asynchronously (for preview row flagging)
      setFieldSourceIssues([])
      getSourceIssuesForField(projectId, field.sourceFieldId).then(setFieldSourceIssues).catch(() => {})

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
    // eslint-disable-next-line react-hooks/exhaustive-deps
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
    setTestResult(null)
    isDirtyRef.current = false
  }

  // ── AI Suggest ────────────────────────────────────────────────────────────

  function handleSuggest() {
    if (!selectedMappingId) return
    const existing = localTransform?.description?.trim()
    // If there's already content, confirm before replacing
    if (existing) {
      // We use startSuggesting to get the suggestion first, then show the dialog
      startSuggesting(async () => {
        const result = await suggestTransformDescription(selectedMappingId)
        if (!result.success || !result.suggestion) {
          showToast(result.error ?? 'Could not generate suggestion. Please describe the transformation manually.', 'error')
          return
        }
        setShowReplaceConfirm(result.suggestion)
      })
      return
    }
    // Textarea is empty — populate directly
    startSuggesting(async () => {
      const result = await suggestTransformDescription(selectedMappingId)
      if (!result.success || !result.suggestion) {
        showToast(result.error ?? 'Could not generate suggestion. Please describe the transformation manually.', 'error')
        return
      }
      setLocalTransform((prev) => prev ? { ...prev, description: result.suggestion! } : null)
    })
  }

  function applyReplaceConfirm() {
    if (!showReplaceConfirm) return
    setLocalTransform((prev) => prev ? { ...prev, description: showReplaceConfirm } : null)
    setShowReplaceConfirm(null)
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
      setSqlExpanded(false) // auto-collapse after AI generation
      setPreviewResults([])
      setPreviewError(null)
      setApplyResult(null)
      setTestResult(null)
      refreshFieldTransformation(selectedMappingId, result.transformationId ?? null, result.sql!, 'ai', desc, 'draft')
    })
  }

  // ── SQL manual edit ───────────────────────────────────────────────────────

  function handleSqlChange(newSql: string) {
    const prevStatus = localTransform?.status
    const newStatus: LocalStatus = prevStatus === 'applied' ? 'stale' : 'draft'

    setSqlExpanded(true) // expand when user edits directly
    setLocalTransform((prev) =>
      prev ? { ...prev, sql: newSql, badge: 'modified', status: newStatus } : null
    )
    setPreviewResults([])
    setPreviewError(null)
    setApplyResult(null)
    setTestResult(null)
    scheduleAutoSave()

    // Keep the sidebar badge in sync: if we just reverted tested/applied → draft,
    // update the datasets state so the FieldRow badge changes immediately.
    if (prevStatus !== newStatus && selectedMappingId) {
      refreshFieldStatus(selectedMappingId, newStatus)
    }
  }

  // ── Test Transform (full run against all rows) ────────────────────────────

  function handleTest() {
    if (!selectedMappingId || !localTransform?.transformationId) return
    setTestResult(null)

    // Flush any pending auto-save first so the RPC uses the latest SQL
    if (autoSaveTimerRef.current) clearTimeout(autoSaveTimerRef.current)
    flushAutoSave()

    startTesting(async () => {
      const res = await runFullTransformTest(selectedMappingId)
      if (!res.success || !res.result) {
        showToast(res.error ?? 'Test failed', 'error')
        return
      }
      setTestResult(res.result)
      if (res.result.failedRows === 0) {
        // All rows pass → update local status to tested
        setLocalTransform((prev) => prev ? { ...prev, status: 'tested' } : null)
        refreshFieldStatus(selectedMappingId, 'tested')
      } else {
        // Failures → keep as draft
        setLocalTransform((prev) => prev ? { ...prev, status: 'draft' } : null)
      }
    })
  }

  // ── Apply Transform ───────────────────────────────────────────────────────

  function executeApplyTransform(fmId: string, sql: string) {
    setApplyResult(null)
    startApplying(async () => {
      const result = await applyTransform(fmId, sql)
      if (!result.success) {
        showToast(result.error ?? 'Apply failed', 'error')
        return
      }
      setLocalTransform((prev) => prev ? { ...prev, status: 'applied' } : null)
      refreshFieldStatus(fmId, 'applied')
      setApplyResult({ rowsAffected: result.rowsAffected })
      showToast(`Applied to ${result.rowsAffected.toLocaleString()} rows`, 'success')
    })
  }

  async function handleApply() {
    if (!selectedMappingId || !localTransform?.sql) return
    if (localTransform.status !== 'tested') {
      showToast('Run "Test Transform" first to verify all rows pass.', 'error')
      return
    }

    // Check for blocking issues scoped to THIS specific source field (+ table-level issues)
    const sourceTableId = selectedContext?.table.sourceTableId
    const sourceFieldId = selectedContext?.field.sourceFieldId
    setIsCheckingIssues(true)
    try {
      const issues = await getBlockingSourceIssues(
        projectId,
        sourceTableId ? [sourceTableId] : undefined,
        sourceFieldId   // field-scoped: only show issues for this field
      )
      if (issues.length > 0) {
        setStagingBlockingIssues(issues)
        setStagingProceedLabel('Apply Anyway — Review Flagged Rows')
        // Build deep-link: filter Validate tab to this table's blocking issues
        const tableId = issues[0]?.table_id
        const params = new URLSearchParams({ stage: 'source', severity: 'blocking', status: 'open' })
        if (tableId) params.set('tableId', tableId)
        fixIssuesUrlRef.current = `/app/projects/${projectId}/data-quality?${params.toString()}`
        const capturedFmId = selectedMappingId
        const capturedSql = localTransform.sql
        pendingStagingFnRef.current = () => executeApplyTransform(capturedFmId, capturedSql)
        setShowStagingWarning(true)
        return
      }
    } finally {
      setIsCheckingIssues(false)
    }
    executeApplyTransform(selectedMappingId, localTransform.sql)
  }

  // ── Staging warning popup actions ─────────────────────────────────────────

  function handleWarningProceed() {
    setShowStagingWarning(false)
    const fn = pendingStagingFnRef.current
    pendingStagingFnRef.current = null
    fn?.()
  }

  function handleWarningFixIssues() {
    setShowStagingWarning(false)
    pendingStagingFnRef.current = null
    router.push(fixIssuesUrlRef.current)
  }

  function handleWarningCancel() {
    setShowStagingWarning(false)
    pendingStagingFnRef.current = null
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

  function executeStageAll() {
    startStaging(async () => {
      const result = await stageAllData(projectId)
      if (!result.success && result.error) {
        setStagingError(result.error)
        showToast('Staging failed: ' + result.error, 'error')
        return
      }
      const totalRows = result.tables.reduce((s, t) => s + t.rowCount, 0)
      const flaggedRows = result.tables.reduce((s, t) => s + t.flaggedRows, 0)
      const flagMsg = flaggedRows > 0 ? ` · ${flaggedRows.toLocaleString()} row${flaggedRows !== 1 ? 's' : ''} flagged` : ''
      showToast(
        `Staged ${totalRows.toLocaleString()} rows across ${result.tables.length} table${result.tables.length !== 1 ? 's' : ''}${flagMsg}`,
        'success'
      )
      setStaleTableMappingIds(new Set())
      router.refresh()
    })
  }

  async function handleStageAll() {
    setStagingError(null)
    // Collect all source table IDs to check for blocking issues
    const allSourceTableIds = data.datasets.flatMap((ds) =>
      ds.tables.map((t) => t.sourceTableId)
    )
    setIsCheckingIssues(true)
    try {
      const issues = await getBlockingSourceIssues(projectId, allSourceTableIds)
      if (issues.length > 0) {
        setStagingBlockingIssues(issues)
        setStagingProceedLabel('Stage All — Review Flagged Rows')
        // Build deep-link: single table → include tableId, multiple → omit
        const uniqueTableIds = [...new Set(issues.map((i) => i.table_id).filter(Boolean))]
        const params = new URLSearchParams({ stage: 'source', severity: 'blocking', status: 'open' })
        if (uniqueTableIds.length === 1 && uniqueTableIds[0]) params.set('tableId', uniqueTableIds[0])
        fixIssuesUrlRef.current = `/app/projects/${projectId}/data-quality?${params.toString()}`
        pendingStagingFnRef.current = () => executeStageAll()
        setShowStagingWarning(true)
        return
      }
    } finally {
      setIsCheckingIssues(false)
    }
    executeStageAll()
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

  const selectedContext = useMemo(
    () => (selectedMappingId ? findField(data.datasets, selectedMappingId) : null),
    [data.datasets, selectedMappingId]
  )

  function statusBadge() {
    if (!localTransform) return null
    const s = localTransform.status

    // Test ran and had failures
    if (testResult && testResult.failedRows > 0) return (
      <Badge className="bg-red-100 text-red-700 hover:bg-red-100 border border-red-200">
        <AlertCircle className="w-3 h-3 mr-1" />{testResult.failedRows} Failure{testResult.failedRows !== 1 ? 's' : ''}
      </Badge>
    )
    if (s === 'applied') return (
      <Badge className="bg-green-100 text-green-700 hover:bg-green-100 border border-green-200">
        <CheckCircle2 className="w-3 h-3 mr-1" />Applied ✓
      </Badge>
    )
    if (s === 'stale') return (
      <Badge className="bg-yellow-100 text-yellow-700 hover:bg-yellow-100 border border-yellow-200">
        <AlertCircle className="w-3 h-3 mr-1" />Stale
      </Badge>
    )
    if (s === 'tested') return (
      <Badge className="bg-green-100 text-green-700 hover:bg-green-100 border border-green-200">
        <CheckCircle2 className="w-3 h-3 mr-1" />Tested ✓
      </Badge>
    )
    if (localTransform.sql) return (
      <Badge className="bg-gray-100 text-gray-500 hover:bg-gray-100 border border-gray-200">
        Untested
      </Badge>
    )
    return null
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

  const elseIndices = detectElseRows(previewResults, localTransform?.sql)

  return (
    <div className="h-full bg-gray-50 flex flex-col overflow-hidden relative">

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
            disabled={isStaging || isAutoGen || isCheckingIssues}
          >
            <Database className="w-3 h-3" />
            {isCheckingIssues ? (
              <span className="flex items-center gap-1.5">
                <span className="w-3 h-3 border-2 border-white/30 border-t-white rounded-full animate-spin" />
                Checking…
              </span>
            ) : isStaging ? (
              <span className="flex items-center gap-1.5">
                <span className="w-3 h-3 border-2 border-white/30 border-t-white rounded-full animate-spin" />
                Staging data…
              </span>
            ) : 'Stage All Data'}
          </Button>
        </div>
      </div>

      {/* DISABLED: Source-data staleness banner — will re-enable later */}
      {/* {staleTableMappingIds.size > 0 && (
        <div className="bg-amber-50 border-b border-amber-200 px-6 py-2.5 flex items-center justify-between flex-shrink-0">
          <p className="text-sm text-amber-800">
            <span className="font-semibold">⚠ Source data was modified since transforms were last staged.</span>
            {' '}Click "Stage All Data" to refresh the staged results.
          </p>
          <button
            onClick={() => setStaleTableMappingIds(new Set())}
            className="text-amber-500 hover:text-amber-700 text-lg leading-none ml-4 flex-shrink-0"
            aria-label="Dismiss"
          >
            ×
          </button>
        </div>
      )} */}

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
                  staleTableMappingIds={staleTableMappingIds}
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

            {/* Need Values — unmapped NOT NULL target fields */}
            {data.unmappedNotNullTargetFields.length > 0 && (
              <div className="mt-4 border-t border-dashed border-gray-200 pt-3">
                <div className="px-4 text-xs font-medium text-amber-600 uppercase tracking-wide mb-2">
                  Need Values ({data.unmappedNotNullTargetFields.length})
                </div>
                {data.unmappedNotNullTargetFields.map((field) => (
                  <div
                    key={field.id}
                    className={`flex items-center gap-2 px-4 py-1.5 text-sm cursor-pointer rounded mx-2 transition-colors ${
                      selectedUnmappedFieldId === field.id
                        ? 'bg-amber-100 text-amber-800'
                        : 'text-gray-500 hover:bg-amber-50'
                    }`}
                    onClick={() => {
                      setSelectedUnmappedFieldId(field.id)
                      setSelectedMappingId(null)
                    }}
                  >
                    <span className="w-2 h-2 rounded-full bg-amber-400 flex-shrink-0" />
                    <span className="truncate">{field.name}</span>
                    <span className="text-[10px] text-amber-500 ml-auto flex-shrink-0">NOT NULL</span>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>

        {/* ── Right area: empty state OR unmapped info OR split panel ── */}
        <div className="flex-1 flex flex-col overflow-hidden">
          {selectedUnmappedFieldId && !selectedContext ? (() => {
            const field = data.unmappedNotNullTargetFields.find((f) => f.id === selectedUnmappedFieldId)
            if (!field) return null
            return (
              <div className="flex-1 flex items-start justify-center p-8">
                <div className="max-w-lg w-full bg-amber-50 border border-amber-200 rounded-lg p-6">
                  <div className="flex items-center gap-2 mb-4">
                    <span className="w-3 h-3 rounded-full bg-amber-400" />
                    <span className="text-lg font-semibold text-amber-800">Unmapped Required Field</span>
                  </div>
                  <div className="space-y-3 text-sm text-gray-700">
                    <div className="bg-white rounded-md p-3 border border-amber-100">
                      <p className="font-medium text-gray-900">{field.name}</p>
                      <p className="text-gray-500 text-xs mt-0.5">{field.data_type} · NOT NULL{field.table_name ? ` · ${field.table_name}` : ''}</p>
                      {field.check_constraint?.type === 'in_list' && (field.check_constraint as { allowedValues?: string[] }).allowedValues && (
                        <div className="mt-2 flex flex-wrap gap-1">
                          {((field.check_constraint as { allowedValues: string[] }).allowedValues).map((v: string) => (
                            <span key={v} className="text-[10px] px-1.5 py-0.5 bg-blue-50 text-blue-700 rounded font-mono">{v}</span>
                          ))}
                        </div>
                      )}
                      {field.check_constraint?.type === 'regex' && (field.check_constraint as { pattern?: string }).pattern && (
                        <p className="mt-1 text-xs text-purple-600 font-mono">Pattern: {(field.check_constraint as { pattern: string }).pattern}</p>
                      )}
                    </div>
                    <p>This target field is <strong>NOT NULL</strong> but has no source field mapped to it. A value must be provided for every record.</p>
                    <div className="space-y-2 text-gray-600">
                      <p className="font-medium text-gray-700">Options:</p>
                      <div className="flex items-start gap-2">
                        <span className="text-blue-500 mt-0.5">1.</span>
                        <p>Go to the <strong>Mapping</strong> tab and map a source field to this target field.</p>
                      </div>
                      <div className="flex items-start gap-2">
                        <span className="text-blue-500 mt-0.5">2.</span>
                        <p>The <strong>Execution Package</strong> will auto-generate a default value based on the field type and constraints when you generate it.</p>
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            )
          })() : !selectedContext ? (
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
                <div className="flex items-center gap-3 min-w-0">
                  <span className="text-sm font-semibold text-gray-900 flex-shrink-0">Transform Field</span>
                  {selectedContext.field.contributingSourceFields.length > 0 ? (
                    <>
                      <span className="text-xs font-medium px-2 py-0.5 rounded-full bg-blue-100 text-blue-700 flex-shrink-0">
                        Many-to-One
                      </span>
                      <div className="flex items-center gap-1 text-sm text-gray-500 min-w-0 flex-wrap">
                        <span className="font-medium text-gray-700">{selectedContext.field.sourceFieldName}</span>
                        {selectedContext.field.contributingSourceFields.map((cf, idx) => (
                          <span key={idx} className="flex items-center gap-1">
                            <span className="text-gray-400">,</span>
                            <span className="font-medium text-gray-700">{cf.name}</span>
                          </span>
                        ))}
                        <ArrowRight className="w-3.5 h-3.5 text-gray-400 flex-shrink-0 mx-0.5" />
                        <span className="font-medium text-gray-700">{selectedContext.field.targetFieldName}</span>
                      </div>
                    </>
                  ) : (
                    <div className="flex items-center gap-1.5 text-sm text-gray-500">
                      <span className="font-medium text-gray-700">
                        {selectedContext.table.sourceTableName}.{selectedContext.field.sourceFieldName}
                      </span>
                      <ArrowRight className="w-3.5 h-3.5 text-gray-400" />
                      <span className="font-medium text-gray-700">
                        {selectedContext.field.targetFieldName}
                      </span>
                    </div>
                  )}
                </div>
                <div className="flex items-center gap-2 flex-shrink-0">
                  {/* Auto-save indicator */}
                  {saveStatus === 'saving' && (
                    <span className="flex items-center gap-1 text-xs text-gray-400">
                      <span className="w-3 h-3 border-2 border-gray-300 border-t-gray-500 rounded-full animate-spin" />
                      Saving...
                    </span>
                  )}
                  {saveStatus === 'saved' && (
                    <span className="text-xs text-gray-400 flex items-center gap-1">
                      <CheckCircle2 className="w-3 h-3 text-gray-400" />Saved
                    </span>
                  )}
                  {statusBadge()}
                </div>
              </div>

              {/* Single-column editor — flex column so the action bar pins to bottom */}
              <div className="flex-1 flex flex-col min-h-0">
                <div className="flex-1 overflow-auto p-5 space-y-4">

                  {/* NL Description — first interactive element */}
                  <div className="bg-white rounded-lg border border-gray-200 p-4">
                    <label className="block text-sm font-medium text-gray-900 mb-2">
                      Describe how this field should be transformed
                    </label>
                    {selectedContext?.field.contributingSourceFields && selectedContext.field.contributingSourceFields.length > 0 && (
                      <div className="mb-3 px-3 py-2 bg-indigo-50 border border-indigo-100 rounded-lg text-xs text-indigo-700">
                        <span className="font-medium">Multi-source mapping.</span> This field also receives data from:{' '}
                        <span className="font-mono">
                          {selectedContext.field.contributingSourceFields.map((f) => f.name).join(', ')}
                        </span>
                        . Write a transform that combines all source fields
                        (e.g., <code className="bg-indigo-100 px-1 rounded">CONCAT(first_name, &apos; &apos;, last_name)</code>).
                      </div>
                    )}
                    <Textarea
                      value={localTransform?.description ?? ''}
                      onChange={(e) => {
                        setLocalTransform((prev) =>
                          prev ? { ...prev, description: e.target.value } : null
                        )
                        scheduleAutoSave()
                      }}
                      placeholder={getSmartPlaceholder(selectedContext.field)}
                      className="min-h-20 resize-none text-sm"
                    />
                    <div className="mt-3 flex items-center gap-2 flex-wrap">
                      <Button
                        variant="outline"
                        className="gap-1.5 text-sm border-gray-300 text-gray-700 hover:text-indigo-700 hover:border-indigo-300 hover:bg-indigo-50"
                        onClick={handleSuggest}
                        disabled={isSuggesting || isGenerating}
                      >
                        {isSuggesting ? (
                          <span className="w-3.5 h-3.5 border-2 border-gray-400 border-t-indigo-500 rounded-full animate-spin" />
                        ) : (
                          <Sparkles className="w-3.5 h-3.5" />
                        )}
                        {isSuggesting ? 'Suggesting...' : 'AI Suggest'}
                      </Button>
                      <Button
                        className="bg-[#4F46E5] hover:bg-[#4338CA] text-white gap-2"
                        onClick={handleGenerate}
                        disabled={isGenerating || isSuggesting}
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

                  {/* Why Transform? — collapsible reference block, collapsed by default */}
                  {selectedContext.field.needsTransform && selectedContext.field.aiReasoning && (
                    <div className="rounded-lg border border-gray-200 bg-white overflow-hidden">
                      <button
                        type="button"
                        onClick={() => setWhyExpanded((v) => !v)}
                        className="w-full flex items-center justify-between px-4 py-2.5 hover:bg-gray-50 transition-colors text-left"
                      >
                        <span className="text-xs font-medium text-gray-500 flex items-center gap-1.5">
                          <AlertCircle className="w-3.5 h-3.5 text-amber-500" />
                          Why this field needs transformation
                        </span>
                        <span className="text-xs text-gray-400">
                          {whyExpanded ? <ChevronDown className="w-3.5 h-3.5" /> : <ChevronRight className="w-3.5 h-3.5" />}
                        </span>
                      </button>
                      {whyExpanded && (
                        <div className="px-4 pb-4 pt-0 border-t border-gray-100 bg-amber-50/40">
                          <p className="text-sm text-amber-900 mt-3">
                            {selectedContext.field.aiReasoning}
                          </p>
                          {selectedContext.field.typeCompatibility && (
                            <p className="text-xs text-amber-700 mt-2 font-mono">
                              {selectedContext.field.typeCompatibility}
                            </p>
                          )}
                          <div className="flex flex-wrap items-center gap-3 mt-2 text-xs text-amber-700">
                            {selectedContext.field.confidence != null && (
                              <span>Confidence: {selectedContext.field.confidence}%</span>
                            )}
                            {selectedContext.field.nullPercentage > 0 && (
                              <span>Null rate: {selectedContext.field.nullPercentage.toFixed(1)}%</span>
                            )}
                            {selectedContext.field.formatIssuesCount > 0 && (
                              <span className="text-red-600 font-medium">
                                ⚠ {selectedContext.field.formatIssuesCount} format issues
                              </span>
                            )}
                          </div>
                        </div>
                      )}
                    </div>
                  )}

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

              {/* Generated SQL — collapsed by default, toggle to expand */}
              {localTransform?.sql && (
                <div className="bg-white rounded-lg border border-gray-200">
                  <button
                    type="button"
                    onClick={() => setSqlExpanded((v) => !v)}
                    className="w-full px-4 py-2.5 flex items-center justify-between hover:bg-gray-50 transition-colors"
                  >
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-semibold text-gray-900">Generated SQL</span>
                      {sqlBadge()}
                    </div>
                    <span className="text-xs text-gray-400">
                      {sqlExpanded ? 'Hide ▴' : 'Show ▾'}
                    </span>
                  </button>
                  {sqlExpanded && (
                    <div className="p-4 border-t border-gray-100">
                      <textarea
                        value={localTransform.sql}
                        onChange={(e) => handleSqlChange(e.target.value)}
                        className="w-full font-mono text-xs text-gray-800 bg-gray-50 rounded border border-gray-200 p-3 resize-none focus:outline-none focus:ring-2 focus:ring-[#4F46E5]/30 focus:border-[#4F46E5]"
                        rows={Math.max(4, localTransform.sql.split('\n').length + 1)}
                        spellCheck={false}
                      />
                    </div>
                  )}
                </div>
              )}

              {/* Apply result */}
              {applyResult && (
                <div className="flex items-center gap-2 text-sm text-green-700 bg-green-50 border border-green-200 rounded-lg px-3 py-2">
                  <CheckCircle2 className="w-4 h-4 text-green-600 flex-shrink-0" />
                  Applied to {applyResult.rowsAffected.toLocaleString()} rows
                </div>
              )}

              {/* Data Preview — source values on left, target constraints or live output on right */}
              {(() => {
                // Issue count from open quality_issues for this source field
                const issueCount = maxAffectedRecordsForField(fieldSourceIssues)
                const hasFieldIssues = fieldSourceIssues.length > 0

                // Which preview rows are flagged (Sample mode only)
                const previewIssueIndices = hasFieldIssues && previewMode === 'sample'
                  ? new Set(previewResults.map((r, i) =>
                      sourcePreviewValueMatchesIssues(r.before, fieldSourceIssues) ? i : -1
                    ).filter((i) => i >= 0))
                  : new Set<number>()

                // Which static sample values are flagged (before any transform is entered)
                const sampleIssueIndices = hasFieldIssues && previewResults.length === 0 && previewMode === 'sample'
                  ? new Set(
                      (selectedContext.field.sampleValues as (string | null)[])
                        .slice(0, 10)
                        .map((v, i) => sourcePreviewValueMatchesIssues(v, fieldSourceIssues) ? i : -1)
                        .filter((i) => i >= 0)
                    )
                  : new Set<number>()

                // Deep-link to Validate tab pre-filtered to this table + field
                const validateUrl = `/app/projects/${projectId}/data-quality?stage=source&status=open` +
                  (selectedContext.table.sourceTableId ? `&tableId=${selectedContext.table.sourceTableId}` : '') +
                  `&fieldId=${selectedContext.field.sourceFieldId}`

                return (
              <div className="border border-gray-200 rounded-lg overflow-hidden bg-white">
                <div className="flex items-center justify-between px-4 py-3 bg-gray-50 border-b border-gray-200">
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-semibold text-gray-900">Data Preview</span>
                    {previewLoading && (
                      <span className="w-3.5 h-3.5 border-2 border-indigo-500 border-t-transparent rounded-full animate-spin" />
                    )}
                    {hasFieldIssues && issueCount > 0 && !previewLoading && (
                      <span className="text-xs text-amber-600">
                        · {issueCount.toLocaleString()} rows have source issues
                      </span>
                    )}
                    {elseIndices.size > 0 && !previewLoading && (
                      <span className="text-xs text-amber-600">
                        · {elseIndices.size} may hit ELSE clause
                      </span>
                    )}
                  </div>
                  {localTransform?.sql && (
                    <div className="flex items-center gap-1 bg-white border border-gray-200 rounded-md p-0.5">
                      <button
                        onClick={() => setPreviewMode('sample')}
                        className={`px-2.5 py-1 text-xs font-medium rounded transition-colors ${
                          previewMode === 'sample' ? 'bg-gray-100 text-gray-800' : 'text-gray-500 hover:text-gray-700'
                        }`}
                      >
                        Sample
                      </button>
                      <button
                        onClick={() => setPreviewMode('distinct')}
                        className={`px-2.5 py-1 text-xs font-medium rounded transition-colors ${
                          previewMode === 'distinct' ? 'bg-gray-100 text-gray-800' : 'text-gray-500 hover:text-gray-700'
                        }`}
                      >
                        Distinct
                      </button>
                    </div>
                  )}
                </div>

                {previewError && (
                  <div className="px-4 py-2.5 bg-red-50 border-b border-red-100">
                    <p className="text-xs text-red-700 font-mono break-all">{previewError}</p>
                  </div>
                )}

                {(() => {
                  // Determine all source columns for this mapping
                  const srcColumns = [
                    selectedContext.field.sourceFieldName,
                    ...selectedContext.field.contributingSourceFields.map((f) => f.name),
                  ]
                  const isManyToOne = srcColumns.length > 1

                  return (
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-gray-100 bg-gray-50/50">
                      {isManyToOne ? (
                        srcColumns.map((colName, colIdx) => (
                          <th key={colName} className="text-left px-4 py-2.5 text-xs font-medium text-gray-500">
                            {colName}{colIdx === 0 ? <span className="text-blue-400 ml-1 font-normal">(primary)</span> : null}
                          </th>
                        ))
                      ) : (
                        <th className="text-left px-4 py-2.5 text-xs font-medium text-gray-500 w-1/2">
                          Source ({selectedContext.field.sourceFieldName})
                        </th>
                      )}
                      <th className="px-1 py-2.5 w-6" />
                      <th className="text-left px-4 py-2.5 text-xs font-medium text-gray-500 w-1/2">
                        <span>Target ({selectedContext.field.targetFieldName})</span>
                        {previewResults.length > 0 && !previewError && (
                          <span className="ml-2 text-green-600 font-normal normal-case">✓ Live</span>
                        )}
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {previewResults.length > 0 && !previewError ? (
                      previewResults.map((row, i) => {
                        const isIssueRow = previewIssueIndices.has(i)
                        return (
                          <tr
                            key={i}
                            className={`border-b border-gray-100 last:border-0 ${
                              isIssueRow ? 'bg-amber-50' : 'hover:bg-gray-50/50'
                            }`}
                          >
                            {isManyToOne ? (
                              // Many-to-one: one column per source field, reading from beforeValues
                              srcColumns.map((colName) => {
                                const val = row.beforeValues ? (row.beforeValues[colName] ?? null) : null
                                return (
                                  <td key={colName} className={`px-4 py-2 font-mono text-xs align-top ${isIssueRow ? 'text-red-600' : 'text-gray-500'}`}>
                                    {val != null ? String(val) : <span className="italic text-gray-400">null</span>}
                                  </td>
                                )
                              })
                            ) : (
                              <td className={`px-4 py-2 font-mono text-xs align-top ${isIssueRow ? 'text-red-600' : 'text-gray-500'}`}>
                                {row.before != null ? (
                                  isIssueRow ? (
                                    <span className="flex items-center gap-1">
                                      <AlertTriangle className="w-3 h-3 text-red-500 flex-shrink-0" />
                                      {String(row.before)}
                                    </span>
                                  ) : (
                                    String(row.before)
                                  )
                                ) : isIssueRow ? (
                                  <span className="flex items-center gap-1">
                                    <AlertTriangle className="w-3 h-3 text-red-500 flex-shrink-0" />
                                    <span className="italic">null</span>
                                  </span>
                                ) : (
                                  <span className="italic text-gray-400">null</span>
                                )}
                              </td>
                            )}
                            <td className="px-1 py-2 text-center text-gray-300 text-xs align-top">→</td>
                            <td className={`px-4 py-2 font-mono text-xs align-top ${isIssueRow ? 'text-red-400' : 'text-gray-900'}`}>
                              <span className="flex items-center gap-1.5 flex-wrap">
                                {row.after != null ? (
                                  <span className={!isIssueRow && row.after !== row.before ? 'text-green-700' : ''}>
                                    {String(row.after)}
                                  </span>
                                ) : (
                                  <span className="italic text-gray-400 font-normal">null</span>
                                )}
                                {elseIndices.has(i) && (
                                  <span title="May hit ELSE clause — check for missing WHEN cases">
                                    <AlertCircle className="w-3 h-3 text-amber-500 flex-shrink-0" />
                                  </span>
                                )}
                                {previewMode === 'distinct' && row.count != null && (
                                  <span className="ml-auto text-gray-400 text-xs font-sans">×{row.count.toLocaleString()}</span>
                                )}
                              </span>
                            </td>
                          </tr>
                        )
                      })
                    ) : (selectedContext.field.sampleValues as (string | null)[]).length > 0 ? (
                      (selectedContext.field.sampleValues as (string | null)[]).slice(0, 10).map((v, i) => {
                        const isIssueRow = sampleIssueIndices.has(i)
                        return (
                          <tr
                            key={i}
                            className={`border-b border-gray-100 last:border-0 ${
                              isIssueRow ? 'bg-amber-50' : 'hover:bg-gray-50/50'
                            }`}
                          >
                            {/* For many-to-one, show primary field sample spanning all source columns */}
                            <td
                              colSpan={srcColumns.length}
                              className={`px-4 py-2 font-mono text-xs ${isIssueRow ? 'text-red-600' : 'text-gray-500'}`}
                            >
                              {v != null ? (
                                isIssueRow ? (
                                  <span className="flex items-center gap-1">
                                    <AlertTriangle className="w-3 h-3 text-red-500 flex-shrink-0" />
                                    {String(v)}
                                  </span>
                                ) : (
                                  String(v)
                                )
                              ) : isIssueRow ? (
                                <span className="flex items-center gap-1">
                                  <AlertTriangle className="w-3 h-3 text-red-500 flex-shrink-0" />
                                  <span className="italic">null</span>
                                </span>
                              ) : (
                                <span className="italic text-gray-400">null</span>
                              )}
                            </td>
                            <td className="px-1 py-2 text-center text-gray-300 text-xs align-top">→</td>
                            <td className={`px-4 py-2 text-xs font-sans italic ${isIssueRow ? 'text-red-400' : 'text-gray-400'}`}>
                              {getTargetConstraintHint(selectedContext.field)}
                            </td>
                          </tr>
                        )
                      })
                    ) : (
                      <tr>
                        <td colSpan={srcColumns.length + 2} className="px-4 py-8 text-center text-sm text-gray-400">
                          No sample data available
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
                  )
                })()}

                {/* Bottom bar — shown when there are open source issues for this field (Sample only) */}
                {hasFieldIssues && previewMode === 'sample' ? (
                  <div className="flex items-center justify-between px-4 py-2.5 bg-amber-50 border-t border-amber-200">
                    <div className="flex items-center gap-2 text-xs text-amber-800">
                      <AlertTriangle className="w-3.5 h-3.5 text-amber-600 flex-shrink-0" />
                      <span>
                        <strong>{issueCount > 0 ? `${issueCount.toLocaleString()} rows` : 'Some rows'}</strong>{' '}
                        have source data issues for this field
                      </span>
                    </div>
                    <button
                      onClick={() => router.push(validateUrl)}
                      className="text-xs text-indigo-600 hover:text-indigo-800 font-medium whitespace-nowrap"
                    >
                      Fix in Validate tab →
                    </button>
                  </div>
                ) : !localTransform?.sql && (selectedContext.field.sampleValues as string[]).length > 0 ? (
                  <div className="px-4 py-2 bg-gray-50 border-t border-gray-100 text-xs text-gray-400">
                    Generate a transform to see how values will be converted
                  </div>
                ) : null}
              </div>
                ) // end IIFE return
              })(/* end Data Preview IIFE */)}

            </div>

            {/* Test results section */}
            {testResult && (
              <div className={`mx-5 mb-4 rounded-lg border text-sm ${testResult.failedRows === 0 ? 'bg-green-50 border-green-200' : 'bg-red-50 border-red-200'}`}>
                <div className="flex items-center gap-2 px-4 py-3">
                  {testResult.failedRows === 0 ? (
                    <>
                      <CheckCircle2 className="w-4 h-4 text-green-600 flex-shrink-0" />
                      <span className="font-medium text-green-800">
                        All {testResult.totalRows.toLocaleString()} rows transformed successfully
                      </span>
                      <span className="ml-auto text-xs text-green-600">
                        Ready to apply →
                      </span>
                    </>
                  ) : (
                    <>
                      <AlertCircle className="w-4 h-4 text-red-600 flex-shrink-0" />
                      <span className="font-medium text-red-800">
                        {testResult.failedRows.toLocaleString()} of {testResult.totalRows.toLocaleString()} rows failed
                      </span>
                    </>
                  )}
                </div>
                {testResult.failedRows > 0 && testResult.failures.length > 0 && (
                  <div className="border-t border-red-200">
                    <table className="w-full text-xs">
                      <thead>
                        <tr className="bg-red-100/60">
                          <th className="text-left px-4 py-1.5 font-medium text-red-700 w-16">Row</th>
                          <th className="text-left px-4 py-1.5 font-medium text-red-700 w-40">Source Value</th>
                          <th className="text-left px-4 py-1.5 font-medium text-red-700">Error</th>
                        </tr>
                      </thead>
                      <tbody>
                        {testResult.failures.map((f, i) => (
                          <tr key={i} className="border-t border-red-200/60">
                            <td className="px-4 py-1.5 text-red-600 font-mono">{f.rowNumber}</td>
                            <td className="px-4 py-1.5 font-mono text-red-700 truncate max-w-[10rem]">{f.sourceValue || <em className="text-red-400">empty</em>}</td>
                            <td className="px-4 py-1.5 text-red-600 truncate">{f.errorMessage}</td>
                          </tr>
                        ))}
                        {testResult.failedRows > testResult.failures.length && (
                          <tr className="border-t border-red-200/60">
                            <td colSpan={3} className="px-4 py-1.5 text-red-500 italic">
                              ... and {(testResult.failedRows - testResult.failures.length).toLocaleString()} more failures
                            </td>
                          </tr>
                        )}
                      </tbody>
                    </table>
                    <div className="px-4 py-2.5 border-t border-red-200 bg-red-50/80 flex items-center gap-3">
                      <span className="text-xs text-red-600 flex-1">Fix the transform logic above, then re-test.</span>
                      <button
                        className="text-xs font-medium text-indigo-700 hover:text-indigo-900 underline-offset-2 hover:underline"
                        onClick={() => {
                          // Allow applying anyway (e.g., skip bad rows)
                          setLocalTransform((prev) => prev ? { ...prev, status: 'tested' } : null)
                          setTestResult(null)
                          showToast('Test override — Apply will skip failed rows.', 'success')
                        }}
                      >
                        Apply Anyway (skip {testResult.failedRows} failed rows)
                      </button>
                    </div>
                  </div>
                )}
              </div>
            )}

                {/* Pinned action bar — flex-shrink-0 keeps it visible below the scroll area */}
                {localTransform?.sql && (
                  <div className="flex-shrink-0 z-10 border-t border-gray-200 bg-white px-4 py-3 flex items-center gap-3 shadow-[0_-2px_8px_rgba(0,0,0,0.06)]">
                    {/* Test Transform */}
                    <Button
                      variant="outline"
                      className="gap-2 border-gray-300 text-gray-700 hover:border-indigo-400 hover:text-indigo-700 hover:bg-indigo-50"
                      onClick={handleTest}
                      disabled={isTesting || !localTransform?.transformationId}
                    >
                      {isTesting ? (
                        <span className="flex items-center gap-2">
                          <span className="w-3.5 h-3.5 border-2 border-gray-400 border-t-indigo-600 rounded-full animate-spin" />
                          Testing...
                        </span>
                      ) : (
                        <>
                          <Play className="w-3.5 h-3.5" />
                          Test Transform
                        </>
                      )}
                    </Button>
                    {/* Apply Transform — only enabled after successful test */}
                    <Button
                      className="bg-[#4F46E5] hover:bg-[#4338CA] text-white gap-2 flex-1 disabled:opacity-50 disabled:cursor-not-allowed"
                      onClick={handleApply}
                      disabled={isApplying || isCheckingIssues || !localTransform?.transformationId || localTransform.status !== 'tested'}
                      title={localTransform.status !== 'tested' ? 'Run "Test Transform" first' : undefined}
                    >
                      {isCheckingIssues ? (
                        <span className="flex items-center gap-2">
                          <span className="w-3.5 h-3.5 border-2 border-white/30 border-t-white rounded-full animate-spin" />
                          Checking…
                        </span>
                      ) : isApplying ? (
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
                  </div>
                )}
              </div>

          {/* Footer — page-level navigation only */}
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

      {/* Staging warning popup — shown when blocking source issues exist */}
      {showStagingWarning && (
        <StagingWarningPopup
          issues={stagingBlockingIssues}
          proceedLabel={stagingProceedLabel}
          onProceed={handleWarningProceed}
          onFixIssues={handleWarningFixIssues}
          onCancel={handleWarningCancel}
        />
      )}

      {/* AI Suggest — replace existing description confirmation */}
      {showReplaceConfirm && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30">
          <div className="bg-white rounded-xl shadow-xl p-6 max-w-md w-full mx-4">
            <h3 className="text-base font-semibold text-gray-900 mb-2 flex items-center gap-2">
              <Sparkles className="w-4 h-4 text-indigo-500" />
              Replace current description?
            </h3>
            <p className="text-sm text-gray-500 mb-3">AI suggestion:</p>
            <div className="bg-gray-50 border border-gray-200 rounded-lg px-3 py-2.5 text-sm text-gray-800 mb-5">
              {showReplaceConfirm}
            </div>
            <div className="flex gap-3 justify-end">
              <Button variant="outline" size="sm" onClick={() => setShowReplaceConfirm(null)}>Keep current</Button>
              <Button size="sm" className="bg-[#4F46E5] hover:bg-[#4338CA] text-white" onClick={applyReplaceConfirm}>
                Use suggestion
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
  dataset, expanded, expandedTables, selectedMappingId, staleTableMappingIds,
  onToggleDataset, onToggleTable, onSelectField,
}: {
  dataset: DatasetGroup
  expanded: boolean
  expandedTables: Set<string>
  selectedMappingId: string | null
  staleTableMappingIds: Set<string>
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
              isTableStale={staleTableMappingIds.has(tbl.tableMappingId)}
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
  table, expanded, selectedMappingId, isTableStale, onToggle, onSelectField,
}: {
  table: TableGroup
  expanded: boolean
  selectedMappingId: string | null
  isTableStale: boolean
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
          {table.fields.filter((f) => !f.isContributing).map((field) => {
            const oneToManyCount = table.fields.filter(
              (f) => f.sourceFieldId === field.sourceFieldId && !f.isContributing
            ).length
            return (
              <FieldRow
                key={field.fieldMappingId}
                field={field}
                isSelected={selectedMappingId === field.fieldMappingId}
                onSelect={() => onSelectField(field.fieldMappingId)}
                oneToManyCount={oneToManyCount}
              />
            )
          })}
        </div>
      )}
    </div>
  )
}

// ── FieldRow ──────────────────────────────────────────────────────────────────

function FieldRow({ field, isSelected, onSelect, oneToManyCount = 1 }: {
  field: FieldItem
  isSelected: boolean
  onSelect: () => void
  oneToManyCount?: number
}) {
  const status = field.transformation?.status
  const isOneToMany = oneToManyCount > 1

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
          {field.contributingSourceFields.length > 0 && (
            <span
              title={`Many-to-one: also uses ${field.contributingSourceFields.map(f => f.name).join(', ')}`}
              className="flex-shrink-0 text-[10px] font-medium text-blue-600 bg-blue-50 px-1 rounded"
            >
              +{field.contributingSourceFields.length}
            </span>
          )}
          {isOneToMany && (
            <span
              title={`One-to-many: ${field.sourceFieldName} maps to ${oneToManyCount} target fields`}
              className="flex-shrink-0 text-[10px] font-medium text-purple-600 bg-purple-50 px-1 rounded"
            >
              1→{oneToManyCount}
            </span>
          )}
        </div>
        <div className="flex items-center gap-1 flex-shrink-0">
          {/* Status icon */}
          {status === 'applied' && (
            <span title="Applied to staged data"><CheckCircle2 className="w-3.5 h-3.5 text-green-500" /></span>
          )}
          {status === 'stale' && (
            <span title="Transform edited after apply — re-apply needed">
              <AlertCircle className="w-3.5 h-3.5 text-amber-500" />
            </span>
          )}
          {/* Four-state badge: Transform → Saved → Tested → Transformed */}
          {status === 'applied' ? (
            <Badge className="bg-green-100 text-green-700 hover:bg-green-100 border border-green-200 text-[10px] px-1.5 py-0">
              Transformed
            </Badge>
          ) : status === 'tested' ? (
            <Badge className="bg-teal-100 text-teal-700 hover:bg-teal-100 border border-teal-200 text-[10px] px-1.5 py-0">
              Tested
            </Badge>
          ) : field.transformation ? (
            <Badge className="bg-blue-100 text-blue-700 hover:bg-blue-100 border border-blue-200 text-[10px] px-1.5 py-0">
              Saved
            </Badge>
          ) : field.needsTransform ? (
            <Badge className="bg-orange-100 text-orange-700 hover:bg-orange-100 border border-orange-200 text-[10px] px-1.5 py-0">
              Transform
            </Badge>
          ) : null}
        </div>
      </div>
      <div className="flex items-center gap-1 pl-3">
        <ArrowRight className="w-3 h-3 text-gray-400 flex-shrink-0" />
        <span className="text-[11px] text-gray-500 truncate">{field.targetFieldName}</span>
      </div>
    </button>
  )
}
