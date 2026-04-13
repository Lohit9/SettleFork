'use client'

import { useState, useEffect, useTransition, useCallback, useRef, useMemo } from 'react'
import { useRouter } from 'next/navigation'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { PageHeader } from '@/components/app/PageHeader'
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
  Undo2,
} from '@/components/icons'
import {
  generateTransform,
  autoSaveTransform,
  runFullTransformTest,
  testTransformation,
  autoGenerateAllTransforms,
  applyTransform,
  revertTransform,
  getStagedPreviewForField,
  previewTransformDistinct,
  suggestTransformDescription,
  dismissTransformNeeded,
  reinstateTransformNeeded,
} from '@/lib/actions/transformations'
import { createValueAssignment } from '@/lib/actions/mappings'
import type { TransformPageData, DatasetGroup, TableGroup, FieldItem, FullTransformTestResult, UnmappedTargetField } from '@/lib/actions/transformations'
import { stageAllData, getBlockingSourceIssues, getSourceIssuesForField, checkProjectStaleness } from '@/lib/actions/staging'
import { triggerStagedValidation } from '@/lib/actions/quality-fixes'
import type { BlockingIssue, FieldSourceIssue } from '@/lib/actions/staging'
import { getResolvedSourceFieldIds } from '@/lib/quality/resolved-by-transform'
import { sourcePreviewValueMatchesIssues, maxAffectedRecordsForField } from '@/lib/quality/preview-source-issue-match'
import StagingWarningPopup from '@/components/StagingWarningPopup'
import FKCascadePrompt from '@/components/app/FKCascadePrompt'
import { findFKDependents, cascadeTransformToFKs } from '@/lib/actions/fk-cascade'
import type { FKDependent } from '@/lib/actions/fk-cascade'
import { useProjectRole } from '@/lib/hooks/useProjectRole'
import { RoleTooltip } from '@/components/app/RoleTooltip'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'

// ── Types ──────────────────────────────────────────────────────────────────────

interface Props {
  projectId: string
  projectName: string
  initialData: TransformPageData
  isArchived?: boolean
}

type LocalStatus = 'draft' | 'tested' | 'applied' | 'stale'

type TransformFilter = 'all' | 'needs_transform' | 'has_transform' | 'unmapped' | 'applied'

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
  if (field.isValueAssignment) {
    return `e.g., "Always set to 'FIRM'" or "Generate as 'TC-' followed by a sequential number"`
  }

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

export default function TransformContent({ projectId, projectName, initialData, isArchived = false }: Props) {
  const router = useRouter()
  const { can } = useProjectRole(projectId)
  const canEdit = can('edit')
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
  const [showStagedPreview, setShowStagedPreview] = useState(false)
  const [stagedPreview, setStagedPreview] = useState<{
    rows: Array<{ sourceValue: string | null; targetValue: string | null }>
    totalRows: number
  } | null>(null)
  const [isReverting, setIsReverting] = useState(false)
  const [showRevertDialog, setShowRevertDialog] = useState(false)
  const [toast, setToast] = useState<{ message: string; type: 'success' | 'error' | 'info' } | null>(null)
  const [stagingError, setStagingError] = useState<string | null>(null)

  const [isGenerating, startGenerating] = useTransition()
  const [isAutoGen, startAutoGen] = useTransition()
  const [isApplying, startApplying] = useTransition()
  const [isStaging, startStaging] = useTransition()
  const [isSuggesting, startSuggesting] = useTransition()
  const [isDismissing, setIsDismissing] = useState(false)

  // Staging warning popup — shown when blocking source issues exist before staging
  const [showStagingWarning, setShowStagingWarning] = useState(false)
  const [stagingBlockingIssues, setStagingBlockingIssues] = useState<BlockingIssue[]>([])
  const [stagingProceedLabel, setStagingProceedLabel] = useState('Stage All — Review Flagged Rows')
  const [isCheckingIssues, setIsCheckingIssues] = useState(false)
  // Stores the actual staging action to run after the user dismisses the warning
  const pendingStagingFnRef = useRef<(() => void) | null>(null)
  // Deep-link URL for "Fix Issues →" button in the popup
  const fixIssuesUrlRef = useRef<string>(`/app/projects/${projectId}/data-quality?stage=source&severity=blocking&status=open`)

  // FK cascade prompt — shown after applying a transform to a PK field
  const [showFKCascade, setShowFKCascade] = useState(false)
  const [fkCascadeData, setFKCascadeData] = useState<{
    pkTableName: string
    pkFieldName: string
    pkTransformSQL: string
    dependents: FKDependent[]
  } | null>(null)
  // Rows affected from the just-completed apply — held until cascade prompt resolves
  const pendingApplyRowsRef = useRef<number>(0)

  // Staleness — table mapping IDs where source data was changed after last staging run
  const [staleTableMappingIds, setStaleTableMappingIds] = useState<Set<string>>(new Set())

  // Open source quality issues for the currently selected field (for Data Preview flagging)
  const [fieldSourceIssues, setFieldSourceIssues] = useState<FieldSourceIssue[]>([])

  // Unmapped NOT NULL target fields — sidebar selection
  const [selectedUnmappedFieldId, setSelectedUnmappedFieldId] = useState<string | null>(null)
  // Unmapped field value-assignment editor state
  const [unmappedDescription, setUnmappedDescription] = useState('')
  const [unmappedSql, setUnmappedSql] = useState('')
  const [unmappedSqlSource, setUnmappedSqlSource] = useState<'ai' | 'manual' | null>(null)
  const [unmappedGenerating, setUnmappedGenerating] = useState(false)
  const [unmappedSuggesting, setUnmappedSuggesting] = useState(false)
  const [unmappedSaving, setUnmappedSaving] = useState(false)
  const [unmappedSqlExpanded, setUnmappedSqlExpanded] = useState(false)
  const [unmappedPreviewRows, setUnmappedPreviewRows] = useState<{ after: string | null }[]>([])
  const [unmappedFieldMappingId, setUnmappedFieldMappingId] = useState<string | null>(null)

  // Sidebar filter
  const [sidebarFilter, setSidebarFilter] = useState<TransformFilter>('all')
  const [filterOpen, setFilterOpen] = useState(false)
  const filterRef = useRef<HTMLDivElement>(null)

  // "Why transform?" collapsible (collapsed by default — it's reference info)
  const [whyExpanded, setWhyExpanded] = useState(false)
  // AI Suggest: confirm before replacing existing textarea content
  const [showReplaceConfirm, setShowReplaceConfirm] = useState<string | null>(null)
  // Input mode: 'ai' = describe + generate via Claude; 'sql' = write expression directly
  const [inputMode, setInputMode] = useState<'ai' | 'sql'>('ai')

  // Auto-save refs — use refs so handleSelectField can access latest values without stale closure
  const localTransformRef = useRef<LocalTransform | null>(null)
  const selectedMappingIdRef = useRef<string | null>(null)
  const isDirtyRef = useRef(false)
  const autoSaveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const previewTimeout = useRef<ReturnType<typeof setTimeout> | null>(null)

  // Keep refs in sync with state
  useEffect(() => { localTransformRef.current = localTransform }, [localTransform])
  useEffect(() => { selectedMappingIdRef.current = selectedMappingId }, [selectedMappingId])

  // Close filter dropdown on click outside
  useEffect(() => {
    function handleClick(e: MouseEvent) {
      if (filterRef.current && !filterRef.current.contains(e.target as Node)) setFilterOpen(false)
    }
    document.addEventListener('mousedown', handleClick)
    return () => document.removeEventListener('mousedown', handleClick)
  }, [])

  const needsTransformCount = useMemo(() => countNeedsTransform(data.datasets), [data.datasets])

  // Per-table unmapped field lookups (keyed by target table name)
  const unmappedByTargetTable = useMemo(() => {
    const map: Record<string, { notNull: UnmappedTargetField[]; nullable: UnmappedTargetField[] }> = {}
    for (const f of data.unmappedNotNullTargetFields) {
      if (!map[f.table_name]) map[f.table_name] = { notNull: [], nullable: [] }
      map[f.table_name].notNull.push(f)
    }
    for (const f of data.unmappedNullableTargetFields) {
      if (!map[f.table_name]) map[f.table_name] = { notNull: [], nullable: [] }
      map[f.table_name].nullable.push(f)
    }
    return map
  }, [data.unmappedNotNullTargetFields, data.unmappedNullableTargetFields])

  // Filter counts
  const allFieldsFlat = useMemo(() => data.datasets.flatMap((ds) => ds.tables.flatMap((t) => t.fields)), [data.datasets])
  const filterCounts = useMemo(() => {
    const mapped = allFieldsFlat.filter((f) => !f.isContributing)
    const totalUnmapped = data.unmappedNotNullTargetFields.length + data.unmappedNullableTargetFields.length
    return {
      all: mapped.length + totalUnmapped,
      needs_transform: mapped.filter((f) => f.needsTransform).length,
      has_transform: mapped.filter((f) => f.transformation !== null).length,
      unmapped: totalUnmapped,
      applied: mapped.filter((f) => f.transformation?.status === 'applied').length,
    }
  }, [allFieldsFlat, data.unmappedNotNullTargetFields.length, data.unmappedNullableTargetFields.length])

  const filterOptions: { key: TransformFilter; label: string }[] = [
    { key: 'all', label: 'All Fields' },
    { key: 'needs_transform', label: 'Needs Transform' },
    { key: 'has_transform', label: 'Has Transform' },
    { key: 'unmapped', label: 'Unmapped' },
    { key: 'applied', label: 'Applied' },
  ]
  const activeFilterLabel = filterOptions.find((o) => o.key === sidebarFilter)?.label ?? 'All Fields'

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
        if (previewMode === 'distinct' || !canEdit) {
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
          const result = await testTransformation(
            selectedMappingId,
            sql,
            contributingNames.length > 0 ? contributingNames : undefined,
            { silent: true }
          )
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
        refreshFieldTransformContent(lt.transformationId, lt.sql, lt.description, lt.status)
        setSaveStatus('saved')
        if (savedFadeTimer.current) clearTimeout(savedFadeTimer.current)
        savedFadeTimer.current = setTimeout(() => setSaveStatus('idle'), 2500)
      } else {
        isDirtyRef.current = true
        setSaveStatus('idle')
        showToast(result.error ?? 'Auto-save failed', 'error')
      }
    } catch {
      isDirtyRef.current = true
      setSaveStatus('idle')
      showToast('Auto-save failed', 'error')
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
        autoSaveTransform(lt.transformationId, lt.sql, lt.description, lt.status)
          .then((r) => {
            if (!r.success) showToast(r.error ?? 'Auto-save failed', 'error')
          })
          .catch(() => showToast('Auto-save failed', 'error'))
      }
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // ── Toast helper ──────────────────────────────────────────────────────────

  function showToast(message: string, type: 'success' | 'error' | 'info' = 'success') {
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
      setShowStagedPreview(false)
      setStagedPreview(null)
      setSqlExpanded(false)
      setWhyExpanded(false)
      setSaveStatus('idle')
      setInputMode('ai')
      isDirtyRef.current = false

      const found = findField(data.datasets, fieldMappingId)
      if (!found) return

      const { field } = found

      // Load open source issues for this field asynchronously (for preview row flagging)
      setFieldSourceIssues([])
      if (field.sourceFieldId) {
        getSourceIssuesForField(projectId, field.sourceFieldId).then(setFieldSourceIssues).catch(() => {})
      }

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
    setShowStagedPreview(false)
    setStagedPreview(null)
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

    const existingSQL = localTransform.sql?.trim() || null

    startGenerating(async () => {
      const result = await generateTransform(selectedMappingId, desc, existingSQL)
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

      console.log('[FK CASCADE] 1. Apply succeeded for fmId:', fmId)

      // Fetch staged preview to show in Data Preview section
      getStagedPreviewForField(fmId).then((staged) => {
        if (staged.success && staged.rows) {
          setStagedPreview({ rows: staged.rows, totalRows: staged.totalRows ?? 0 })
          setShowStagedPreview(true)
        }
      }).catch(() => {})

      // Check if this is a PK field with FK dependents — prompt cascade if so
      console.log('[FK CASCADE] 2. data.datasets length:', data.datasets?.length)
      const fieldResult = findField(data.datasets, fmId)
      console.log('[FK CASCADE] 3. findField result:', fieldResult ? {
        name: fieldResult.field?.targetFieldName,
        isPK: fieldResult.field?.targetFieldIsPrimaryKey,
        targetFieldId: fieldResult.field?.targetFieldId,
      } : 'NULL - field not found')
      const currentField = fieldResult?.field
      if (currentField?.targetFieldIsPrimaryKey) {
        console.log('[FK CASCADE] 2b. Entered PK check block')
        const { dependents, pkTableName, pkFieldName } = await findFKDependents(
          projectId,
          currentField.targetFieldId
        )
        console.log('[FK CASCADE] 4. findFKDependents result:', {
          dependentCount: dependents.length,
          pkTableName,
          pkFieldName,
          dependents: dependents.map((d) => ({
            table: d.tableName, field: d.fieldName,
            fmId: d.fieldMappingId,
            hasTransform: d.hasExistingTransform,
            status: d.existingTransformStatus,
          })),
        })
        // Only surface dependents that are mappable and not already applied
        const relevant = dependents.filter(
          (d) => d.fieldMappingId !== null &&
                 (!d.hasExistingTransform || d.existingTransformStatus !== 'applied')
        )
        console.log('[FK CASCADE] 5. relevant count:', relevant.length,
          'filtered out:', dependents.length - relevant.length)
        if (relevant.length > 0) {
          console.log('[FK CASCADE] 6. Showing cascade prompt')
          pendingApplyRowsRef.current = result.rowsAffected
          setFKCascadeData({
            pkTableName,
            pkFieldName,
            pkTransformSQL: sql,
            dependents: relevant,
          })
          setShowFKCascade(true)
          return // toast shown after cascade prompt resolves
        }
      } else {
        console.log('[FK CASCADE] 2b. SKIPPED - not a PK field, isPK:', currentField?.targetFieldIsPrimaryKey)
      }

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
    const sourceFieldId = selectedContext?.field.sourceFieldId ?? undefined
    setIsCheckingIssues(true)
    try {
      const resolvedFieldIds = await getResolvedSourceFieldIds(projectId).catch(() => [] as string[])
      const issues = await getBlockingSourceIssues(
        projectId,
        sourceTableId ? [sourceTableId] : undefined,
        sourceFieldId,  // field-scoped: only show issues for this field
        resolvedFieldIds
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

  function handleRevert() {
    setShowRevertDialog(true)
  }

  async function confirmRevert() {
    setShowRevertDialog(false)
    if (!selectedMappingId) return
    setIsReverting(true)
    try {
      const result = await revertTransform(selectedMappingId)
      if (result.success) {
        setLocalTransform((prev) => prev ? { ...prev, status: 'tested' } : prev)
        refreshFieldStatus(selectedMappingId, 'tested')
        setShowStagedPreview(false)
        setStagedPreview(null)
        setApplyResult(null)
        showToast(`Reverted ${result.rowsAffected} staged rows`, 'success')
      } else {
        showToast(result.error ?? 'Revert failed', 'error')
      }
    } finally {
      setIsReverting(false)
    }
  }

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

  // ── FK Cascade handlers ───────────────────────────────────────────────────

  async function handleFKCascade(selectedFmIds: string[]) {
    if (!fkCascadeData || selectedFmIds.length === 0) {
      handleFKCascadeSkip()
      return
    }

    const pkSnapshot = fkCascadeData
    let result: { success: boolean; cascadedCount: number; error?: string }
    try {
      result = await cascadeTransformToFKs(
        selectedFmIds,
        pkSnapshot.pkTransformSQL,
        localTransform?.description ?? '',
        pkSnapshot.pkTableName,
        pkSnapshot.pkFieldName
      )
    } catch {
      setShowFKCascade(false)
      setFKCascadeData(null)
      pendingApplyRowsRef.current = 0
      showToast('Cascade failed — add transforms to FK fields manually.', 'error')
      return
    }

    setShowFKCascade(false)
    const rows = pendingApplyRowsRef.current
    pendingApplyRowsRef.current = 0
    setFKCascadeData(null)

    if (result.success && result.cascadedCount > 0) {
      for (const fmId of selectedFmIds) {
        refreshFieldTransformation(
          fmId,
          null,
          pkSnapshot.pkTransformSQL,
          'ai',
          `Cascaded from ${pkSnapshot.pkTableName}.${pkSnapshot.pkFieldName}: ${localTransform?.description ?? ''}`,
          'applied'
        )
      }
      showToast(
        `Applied to ${rows.toLocaleString()} rows. Cascaded and applied to ${result.cascadedCount} FK field${result.cascadedCount > 1 ? 's' : ''}.`,
        'success'
      )
    } else {
      showToast(
        result.error
          ? `Applied to ${rows.toLocaleString()} rows. ${result.error}`
          : `Applied to ${rows.toLocaleString()} rows. Cascade failed — add transforms to FK fields manually.`,
        'error'
      )
    }
  }

  function handleFKCascadeSkip() {
    const rows = pendingApplyRowsRef.current
    pendingApplyRowsRef.current = 0
    setShowFKCascade(false)
    setFKCascadeData(null)
    showToast(`Applied to ${rows.toLocaleString()} rows`, 'success')
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
      try {
        const result = await stageAllData(projectId)
        if (!result.success) {
          const msg = result.error ?? 'Staging failed'
          setStagingError(msg)
          showToast('Staging failed: ' + msg, 'error')
          return
        }

        const totalRows = result.tables.reduce((s, t) => s + t.rowCount, 0)
        const flaggedRows = result.tables.reduce((s, t) => s + t.flaggedRows, 0)
        const flagMsg = flaggedRows > 0 ? ` · ${flaggedRows.toLocaleString()} row${flaggedRows !== 1 ? 's' : ''} flagged` : ''
        const baseMsg = `Staged ${totalRows.toLocaleString()} rows across ${result.tables.length} table${result.tables.length !== 1 ? 's' : ''}${flagMsg}`

        // Auto-run lightweight staged validation (no AI credits, fast SQL only)
        try {
          const validationResult = await triggerStagedValidation(projectId)
          if (validationResult.success) {
            const n = validationResult.issuesFound
            if (n > 0) {
              showToast(
                `${baseMsg} · ${n} issue${n !== 1 ? 's' : ''} found — check the Validate tab`,
                'info'
              )
            } else {
              showToast(`${baseMsg} · All validation checks passed`, 'success')
            }
          } else {
            showToast(baseMsg, 'success')
          }
        } catch {
          // Validation failure is non-blocking — staging already succeeded
          showToast(baseMsg, 'success')
        }

        setStaleTableMappingIds(new Set())
        router.refresh()
      } catch (e) {
        const msg = e instanceof Error ? e.message : 'Staging failed'
        setStagingError(msg)
        showToast(msg, 'error')
      }
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
      const resolvedFieldIds = await getResolvedSourceFieldIds(projectId).catch(() => [] as string[])
      const issues = await getBlockingSourceIssues(projectId, allSourceTableIds, undefined, resolvedFieldIds)
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

  /** Patches the in-memory data tree after dismiss/reinstate so sidebar badge + counts update instantly. */
  function refreshFieldNeedsTransform(fmId: string, needsTransform: boolean) {
    setData((prev) => ({
      ...prev,
      datasets: prev.datasets.map((ds) => ({
        ...ds,
        tables: ds.tables.map((tbl) => ({
          ...tbl,
          fields: tbl.fields.map((f) => {
            if (f.fieldMappingId !== fmId) return f
            return { ...f, needsTransform }
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
      <div className="h-full bg-gray-50 flex flex-col overflow-hidden relative">
        <PageHeader projectName={projectName} title="Transform" subtitle="Define transformation logic for mapped fields" />
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
      </div>
    )
  }

  // ── Main layout ────────────────────────────────────────────────────────────

  const elseIndices = detectElseRows(previewResults, localTransform?.sql)

  return (
    <div className="h-full bg-gray-50 flex flex-col overflow-hidden relative">

      {/* Toast */}
      {toast && (
        <div className={`fixed bottom-6 right-6 z-50 px-4 py-3 rounded-lg shadow-lg text-sm font-medium max-w-sm ${
          toast.type === 'success' ? 'bg-green-600 text-white'
          : toast.type === 'info' ? 'bg-primary text-white'
          : 'bg-red-600 text-white'
        }`}>
          {toast.message}
        </div>
      )}

      {/* ── Top bar ────────────────────────────────────────────────────────── */}
      <PageHeader
        projectName={projectName}
        title="Transform"
        subtitle={`${needsTransformCount} field${needsTransformCount !== 1 ? 's' : ''} require transformation`}
      >
        <div className="flex items-center gap-3 flex-shrink-0">
          {stagingError && (
            <p className="text-xs text-red-600 max-w-xs text-right">{stagingError}</p>
          )}
          <RoleTooltip allowed={canEdit} requiredRole="Editor">
            <Button
              size="sm"
              variant="outline"
              className="gap-2 text-xs"
              onClick={handleAutoGenerate}
              disabled={isAutoGen || isStaging || !canEdit}
            >
              <Zap className="w-3 h-3" />
              {isAutoGen ? (autoGenProgress ?? 'Generating...') : 'Auto-Generate All Transforms'}
            </Button>
          </RoleTooltip>
          <RoleTooltip allowed={canEdit} requiredRole="Editor">
            <Button
              size="sm"
              className="bg-primary hover:bg-primary/90 text-white gap-2"
              onClick={handleStageAll}
              disabled={isStaging || isAutoGen || isCheckingIssues || !canEdit}
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
          </RoleTooltip>
        </div>
      </PageHeader>

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
          {/* Filter dropdown */}
          <div className="relative px-3 pt-3 pb-2" ref={filterRef}>
            <button
              onClick={() => setFilterOpen((v) => !v)}
              className="w-full flex items-center justify-between px-3 py-2 bg-gray-50 border border-gray-200 rounded-lg text-xs font-medium text-gray-700 hover:bg-gray-100 transition-colors"
            >
              <span>{activeFilterLabel}</span>
              <div className="flex items-center gap-1.5">
                <span className="text-[10px] bg-blue-100 text-blue-700 px-1.5 py-0.5 rounded-full font-semibold">
                  {filterCounts[sidebarFilter]}
                </span>
                <ChevronDown className={`w-3.5 h-3.5 text-gray-400 transition-transform ${filterOpen ? 'rotate-180' : ''}`} />
              </div>
            </button>
            {filterOpen && (
              <div className="absolute left-3 right-3 top-full mt-1 bg-white border border-gray-200 rounded-lg shadow-lg z-20 py-1">
                {filterOptions.map((opt) => (
                  <button
                    key={opt.key}
                    onClick={() => { setSidebarFilter(opt.key); setFilterOpen(false) }}
                    className={`w-full flex items-center justify-between px-3 py-2 text-xs transition-colors ${
                      sidebarFilter === opt.key
                        ? 'bg-blue-50 text-blue-700 font-medium'
                        : 'text-gray-600 hover:bg-gray-50'
                    }`}
                  >
                    <div className="flex items-center gap-2">
                      {sidebarFilter === opt.key && (
                        <svg className="w-3 h-3 text-blue-600" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={3}>
                          <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                        </svg>
                      )}
                      <span className={sidebarFilter !== opt.key ? 'ml-5' : ''}>{opt.label}</span>
                    </div>
                    <span className="text-[10px] text-gray-400">{filterCounts[opt.key]}</span>
                  </button>
                ))}
              </div>
            )}
          </div>

          <div className="flex-1 overflow-auto p-3 space-y-2">
            {data.datasets.length === 0 && filterCounts.unmapped === 0 ? (
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
                  selectedUnmappedFieldId={selectedUnmappedFieldId}
                  staleTableMappingIds={staleTableMappingIds}
                  unmappedByTargetTable={unmappedByTargetTable}
                  filter={sidebarFilter}
                  onToggleDataset={(id) => setExpandedDatasets((prev) => {
                    const next = new Set(prev); next.has(id) ? next.delete(id) : next.add(id); return next
                  })}
                  onToggleTable={(id) => setExpandedTables((prev) => {
                    const next = new Set(prev); next.has(id) ? next.delete(id) : next.add(id); return next
                  })}
                  onSelectField={handleSelectField}
                  onSelectUnmappedField={(id) => {
                    setSelectedUnmappedFieldId(id)
                    setSelectedMappingId(null)
                    setUnmappedDescription('')
                    setUnmappedSql('')
                    setUnmappedSqlSource(null)
                    setUnmappedSqlExpanded(false)
                    setUnmappedPreviewRows([])
                    setUnmappedFieldMappingId(null)
                  }}
                />
              ))
            )}

            {/* Need Values — unmapped NOT NULL target fields (standalone section) */}
            {sidebarFilter !== 'unmapped' && data.unmappedNotNullTargetFields.length > 0 && (
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
                      setUnmappedDescription('')
                      setUnmappedSql('')
                      setUnmappedSqlSource(null)
                      setUnmappedSqlExpanded(false)
                      setUnmappedPreviewRows([])
                      setUnmappedFieldMappingId(null)
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
              ?? data.unmappedNullableTargetFields.find((f) => f.id === selectedUnmappedFieldId)
            if (!field) return null
            const isRequired = !field.is_nullable
            const checkConstraint = field.check_constraint as { type?: string; allowedValues?: string[]; pattern?: string } | null

            // Lazily ensure a field_mapping exists; returns its ID
            const ensureFieldMapping = async (): Promise<string | null> => {
              if (unmappedFieldMappingId) return unmappedFieldMappingId
              let tableMappingId: string | null = null
              for (const ds of data.datasets) {
                for (const t of ds.tables) {
                  if (t.targetTableId === field.table_id) { tableMappingId = t.tableMappingId; break }
                }
                if (tableMappingId) break
              }
              if (!tableMappingId) return null
              const result = await createValueAssignment(projectId, tableMappingId, field.id)
              if (!result.success || !result.fieldMappingId) {
                if (!result.success) {
                  if (result.error?.includes('already has a field mapping')) {
                    showToast('This target field already has a field mapping. Remove it first to add a value assignment.', 'error')
                  } else {
                    showToast(result.error ?? 'Could not create value assignment', 'error')
                  }
                }
                return null
              }
              setUnmappedFieldMappingId(result.fieldMappingId)
              return result.fieldMappingId
            }

            const handleUnmappedSuggest = async () => {
              setUnmappedSuggesting(true)
              try {
                const fmId = await ensureFieldMapping()
                if (!fmId) return
                const result = await suggestTransformDescription(fmId)
                if (!result.success || !result.suggestion) {
                  showToast(result.error ?? 'Could not generate suggestion.', 'error')
                  return
                }
                setUnmappedDescription(result.suggestion)
              } finally {
                setUnmappedSuggesting(false)
              }
            }

            const handleUnmappedGenerate = async () => {
              if (!unmappedDescription.trim()) return
              setUnmappedGenerating(true)
              try {
                const fmId = await ensureFieldMapping()
                if (!fmId) return
                const existingUnmappedSQL = unmappedSql?.trim() || null
                const genResult = await generateTransform(fmId, unmappedDescription, existingUnmappedSQL)
                if (!genResult.success || !genResult.sql) {
                  showToast(genResult.error ?? 'Generation failed', 'error')
                  return
                }
                setUnmappedSql(genResult.sql)
                setUnmappedSqlSource('ai')
                setUnmappedSqlExpanded(true)
                const prev = await previewTransformDistinct(fmId, genResult.sql)
                if (!prev.success) {
                  showToast(prev.error ?? 'Preview failed', 'error')
                  return
                }
                if (prev.results) setUnmappedPreviewRows(prev.results.map((r) => ({ after: r.after })))
              } finally {
                setUnmappedGenerating(false)
              }
            }

            const handleUnmappedSave = async () => {
              if (!unmappedFieldMappingId || !unmappedSql.trim()) return
              setUnmappedSaving(true)
              try {
                const { createClient } = await import('@/lib/supabase/client')
                const sb = createClient()
                const { data: tfData } = await sb.from('transformations').select('id').eq('field_mapping_id', unmappedFieldMappingId).maybeSingle()
                if (tfData?.id) {
                  const saveRes = await autoSaveTransform(tfData.id, unmappedSql, unmappedDescription)
                  if (!saveRes.success) {
                    showToast(saveRes.error ?? 'Save failed', 'error')
                    return
                  }
                }
                router.refresh()
                setSelectedMappingId(unmappedFieldMappingId)
                setSelectedUnmappedFieldId(null)
              } finally {
                setUnmappedSaving(false)
              }
            }

            const smartPlaceholder = checkConstraint?.type === 'in_list' && checkConstraint.allowedValues?.length
              ? `e.g. "Always set to '${checkConstraint.allowedValues[0]}'" or "Use FIRM for law firms, CORP for corporations"`
              : isRequired
                ? `e.g. "Always set to 'DEFAULT'", "Use current timestamp", "Generate a UUID"`
                : `e.g. "Leave as NULL", "Set to empty string", "Use current date"`

            return (
              <div className="flex-1 flex flex-col min-h-0">
                {/* Header — same as regular transform editor header */}
                <div className="bg-white border-b border-gray-200 px-6 py-3 flex items-center justify-between flex-shrink-0">
                  <div className="flex items-center gap-3 min-w-0">
                    <span className="text-sm font-semibold text-gray-900 flex-shrink-0">Define Value</span>
                    <span className="text-xs font-medium px-2 py-0.5 rounded-full bg-purple-100 text-purple-700 flex-shrink-0">Value Assignment</span>
                    <div className="flex items-center gap-1.5 text-sm text-gray-500 flex-wrap min-w-0">
                      <span className="font-medium text-gray-700 truncate">{field.name}</span>
                      <span className="text-gray-400 text-xs">{field.data_type}</span>
                      {isRequired && <span className="text-amber-600 text-xs">NOT NULL</span>}
                      {field.table_name && <span className="text-gray-400 text-xs">· {field.table_name}</span>}
                    </div>
                  </div>
                </div>

                {/* Scrollable editor body */}
                <div className="flex-1 overflow-auto p-5 space-y-4">

                  {/* Description card — identical structure to regular transform NL description card */}
                  <div className="bg-white rounded-lg border border-gray-200 p-4">
                    <label className="block text-sm font-medium text-gray-900 mb-2">
                      Describe the value this field should receive
                    </label>
                    {/* Context hints — replaces multi-source hint */}
                    <div className="mb-3 space-y-2">
                      <div className="px-3 py-2 bg-purple-50 border border-purple-100 rounded-lg text-xs text-purple-700">
                        <span className="font-medium">No source field mapped.</span>{' '}
                        {isRequired
                          ? 'This required field needs a value for every record. Describe a constant, expression, or rule.'
                          : 'This optional field has no source mapping. Define a value or leave it to default to NULL.'}
                      </div>
                      {checkConstraint?.type === 'in_list' && checkConstraint.allowedValues && (
                        <div className="px-3 py-2 bg-blue-50 border border-blue-100 rounded-lg text-xs text-blue-700">
                          <span className="font-medium">Allowed values:</span>{' '}
                          <span className="font-mono">{checkConstraint.allowedValues.join(', ')}</span>
                        </div>
                      )}
                      {checkConstraint?.type === 'regex' && checkConstraint.pattern && (
                        <div className="px-3 py-2 bg-blue-50 border border-blue-100 rounded-lg text-xs text-blue-700">
                          <span className="font-medium">Pattern constraint:</span>{' '}
                          <span className="font-mono">{checkConstraint.pattern}</span>
                        </div>
                      )}
                    </div>
                    <Textarea
                      value={unmappedDescription}
                      onChange={(e) => setUnmappedDescription(e.target.value)}
                      placeholder={smartPlaceholder}
                      readOnly={!canEdit}
                      className={`min-h-20 resize-none text-sm ${!canEdit ? 'opacity-60 cursor-not-allowed' : ''}`}
                      onKeyDown={(e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) handleUnmappedGenerate() }}
                    />
                    {/* Action row — same layout as regular editor */}
                    <div className="mt-3 flex items-center gap-2 flex-wrap">
                      <RoleTooltip allowed={canEdit} requiredRole="Editor">
                        <Button
                          variant="outline"
                          className="gap-1.5 text-sm border-gray-300 text-gray-700 hover:text-blue-700 hover:border-blue-300 hover:bg-blue-50"
                          onClick={handleUnmappedSuggest}
                          disabled={unmappedSuggesting || unmappedGenerating || !canEdit}
                        >
                          {unmappedSuggesting
                            ? <span className="w-3.5 h-3.5 border-2 border-gray-400 border-t-blue-500 rounded-full animate-spin" />
                            : <Sparkles className="w-3.5 h-3.5" />}
                          {unmappedSuggesting ? 'Suggesting...' : 'AI Suggest'}
                        </Button>
                      </RoleTooltip>
                      <RoleTooltip allowed={canEdit} requiredRole="Editor">
                        <Button
                          className="bg-primary hover:bg-primary/90 text-white gap-2"
                          onClick={handleUnmappedGenerate}
                          disabled={unmappedGenerating || unmappedSuggesting || !unmappedDescription.trim() || !canEdit}
                        >
                        <RefreshCw className={`w-4 h-4 ${unmappedGenerating ? 'animate-spin' : ''}`} />
                        {unmappedGenerating ? 'Generating...' : 'Generate SQL'}
                        </Button>
                      </RoleTooltip>
                      {canEdit && (
                        <button
                          className="text-sm text-gray-500 hover:text-gray-700 underline-offset-2 hover:underline"
                          onClick={() => { setUnmappedDescription(''); setUnmappedSql(''); setUnmappedSqlSource(null); setUnmappedPreviewRows([]) }}
                        >
                          Clear
                        </button>
                      )}
                    </div>
                  </div>

                  {/* Generated SQL — collapsible, same as regular editor */}
                  {unmappedSql && (
                    <div className="bg-white rounded-lg border border-gray-200">
                      <button
                        type="button"
                        onClick={() => setUnmappedSqlExpanded((v) => !v)}
                        className="w-full px-4 py-2.5 flex items-center justify-between hover:bg-gray-50 transition-colors"
                      >
                        <div className="flex items-center gap-2">
                          <span className="text-sm font-semibold text-gray-900">Generated SQL</span>
                          {unmappedSqlSource === 'ai' && (
                            <span className="text-[10px] font-medium px-1.5 py-0.5 rounded-full bg-blue-100 text-blue-700">AI-Generated</span>
                          )}
                        </div>
                        <span className="text-xs text-gray-400">{unmappedSqlExpanded ? 'Hide ▴' : 'Show ▾'}</span>
                      </button>
                      {unmappedSqlExpanded && (
                        <div className="p-4 border-t border-gray-100">
                          <textarea
                            value={unmappedSql}
                            onChange={(e) => { setUnmappedSql(e.target.value); setUnmappedSqlSource('manual') }}
                            readOnly={!canEdit}
                            className={`w-full font-mono text-xs text-gray-800 bg-gray-50 rounded border border-gray-200 p-3 resize-none focus:outline-none focus:ring-2 focus:ring-blue-500/30 focus:border-blue-500 ${!canEdit ? 'opacity-60 cursor-not-allowed' : ''}`}
                            rows={Math.max(2, unmappedSql.split('\n').length + 1)}
                            spellCheck={false}
                          />
                        </div>
                      )}
                    </div>
                  )}

                  {/* Value Preview — simplified table, target column only (no source) */}
                  {unmappedSql && (
                    <div className="bg-white rounded-lg border border-gray-200 overflow-hidden">
                      <div className="px-4 py-2.5 border-b border-gray-100 flex items-center justify-between">
                        <span className="text-sm font-semibold text-gray-900">Value Preview</span>
                        {unmappedPreviewRows.length > 0 && (
                          <span className="text-xs text-green-600 flex items-center gap-1">
                            <span className="w-1.5 h-1.5 rounded-full bg-green-500" />
                            Live
                          </span>
                        )}
                      </div>
                      <table className="w-full text-sm">
                        <thead>
                          <tr className="bg-gray-50 border-b border-gray-100">
                            <th className="text-left px-4 py-2 text-xs font-medium text-gray-500">
                              Target ({field.name})
                            </th>
                          </tr>
                        </thead>
                        <tbody>
                          {unmappedPreviewRows.length > 0 ? (
                            unmappedPreviewRows.slice(0, 8).map((row, i) => (
                              <tr key={i} className="border-b border-gray-50 last:border-0 hover:bg-gray-50/50">
                                <td className="px-4 py-2 font-mono text-xs text-green-600">
                                  {row.after != null ? String(row.after) : <span className="italic text-gray-400">null</span>}
                                </td>
                              </tr>
                            ))
                          ) : (
                            <tr>
                              <td className="px-4 py-6 text-center text-xs text-gray-400">
                                Run <strong>Generate SQL</strong> to preview the output
                              </td>
                            </tr>
                          )}
                        </tbody>
                      </table>
                    </div>
                  )}

                </div>

                {/* Pinned action bar — same structure as Test+Apply bar */}
                {unmappedSql && (
                  <div className="flex-shrink-0 z-10 border-t border-gray-200 bg-white px-4 py-3 flex items-center gap-3 shadow-[0_-2px_8px_rgba(0,0,0,0.06)]">
                    <RoleTooltip allowed={canEdit} requiredRole="Editor">
                      <Button
                        className="bg-primary hover:bg-primary/90 text-white gap-2 flex-1"
                        onClick={handleUnmappedSave}
                        disabled={unmappedSaving || !canEdit}
                      >
                        {unmappedSaving ? (
                          <span className="flex items-center gap-2">
                            <span className="w-3.5 h-3.5 border-2 border-white/30 border-t-white rounded-full animate-spin" />
                          Saving…
                        </span>
                      ) : (
                        <>
                          <Database className="w-3.5 h-3.5" />
                          Save Value
                        </>
                      )}
                      </Button>
                    </RoleTooltip>
                  </div>
                )}

                {/* Footer — same as regular editor footer */}
                <div className="border-t border-gray-200 bg-white px-6 py-3 flex items-center justify-between flex-shrink-0">
                  <span className="text-xs text-gray-400">
                    Use <strong>Save Value</strong> to persist the expression, then <strong>Stage All Data</strong> to apply it.
                  </span>
                  <div className="flex flex-col items-end gap-1">
                    {stagingError && <p className="text-xs text-red-600 max-w-xs text-right">{stagingError}</p>}
                    <RoleTooltip allowed={canEdit} requiredRole="Editor">
                      <Button
                        className="bg-primary hover:bg-primary/90 text-white disabled:opacity-60"
                        disabled={isStaging || !canEdit}
                        onClick={() => {
                          setStagingError(null)
                          startStaging(async () => {
                            try {
                              const result = await stageAllData(projectId)
                              if (!result.success) {
                                const msg = result.error ?? 'Staging failed'
                                setStagingError(msg)
                                showToast(msg, 'error')
                                return
                              }
                              router.push(`/app/projects/${projectId}/data-quality`)
                            } catch (e) {
                              const msg = e instanceof Error ? e.message : 'Staging failed'
                              setStagingError(msg)
                              showToast(msg, 'error')
                            }
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
                    </RoleTooltip>
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
                  {selectedContext.field.isValueAssignment ? (
                    <>
                      <span className="text-sm font-semibold text-gray-900 flex-shrink-0">Define Value</span>
                      <span className="text-xs font-medium px-2 py-0.5 rounded-full bg-purple-100 text-purple-700 flex-shrink-0">
                        Value Assignment
                      </span>
                      <div className="flex items-center gap-1.5 text-sm text-gray-500">
                        <span className="font-medium text-gray-700">{selectedContext.field.targetFieldName}</span>
                        <span className="text-gray-400 text-xs">{selectedContext.field.targetFieldDataType}</span>
                        {!selectedContext.field.targetFieldIsNullable && (
                          <span className="text-amber-600 text-xs">NOT NULL</span>
                        )}
                      </div>
                    </>
                  ) : selectedContext.field.contributingSourceFields.length > 0 ? (
                    <>
                      <span className="text-sm font-semibold text-gray-900 flex-shrink-0">Transform Field</span>
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
                    <>
                      <span className="text-sm font-semibold text-gray-900 flex-shrink-0">Transform Field</span>
                      <div className="flex items-center gap-1.5 text-sm text-gray-500">
                        <span className="font-medium text-gray-700">
                          {selectedContext.table.sourceTableName}.{selectedContext.field.sourceFieldName}
                        </span>
                        <ArrowRight className="w-3.5 h-3.5 text-gray-400" />
                        <span className="font-medium text-gray-700">
                          {selectedContext.field.targetFieldName}
                        </span>
                      </div>
                    </>
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

                  {/* NL Description / Direct SQL — first interactive element */}
                  <div className="bg-white rounded-lg border border-gray-200 p-4">
                    {/* Header row: label + mode toggle */}
                    <div className="flex items-center justify-between mb-2">
                      <label className="text-sm font-medium text-gray-900">
                        {inputMode === 'sql'
                          ? 'Write SQL expression directly'
                          : selectedContext.field.isValueAssignment
                          ? 'Describe the value this field should receive'
                          : 'Describe how this field should be transformed'}
                      </label>
                      <div className="flex rounded-lg border border-gray-200 overflow-hidden flex-shrink-0 ml-3">
                        <button
                          onClick={() => setInputMode('ai')}
                          className={`px-2.5 py-1 text-xs font-medium transition-colors ${
                            inputMode === 'ai'
                              ? 'bg-primary text-white'
                              : 'bg-white text-gray-600 hover:bg-gray-50'
                          }`}
                        >
                          AI-Assisted
                        </button>
                        <button
                          onClick={() => {
                            setInputMode('sql')
                            // Expand the SQL view immediately so user sees what they're editing
                            if (localTransform?.sql) setSqlExpanded(true)
                          }}
                          className={`px-2.5 py-1 text-xs font-medium border-l border-gray-200 transition-colors ${
                            inputMode === 'sql'
                              ? 'bg-primary text-white'
                              : 'bg-white text-gray-600 hover:bg-gray-50'
                          }`}
                        >
                          SQL
                        </button>
                      </div>
                    </div>

                    {inputMode === 'ai' ? (
                      <>
                        {/* Context hints */}
                        {selectedContext.field.isValueAssignment && (
                          <div className="mb-3 space-y-2">
                            <div className="px-3 py-2 bg-purple-50 border border-purple-100 rounded-lg text-xs text-purple-700">
                              <span className="font-medium">Value assignment.</span> This target field has no source mapping.
                              Describe a constant, expression, or rule to generate the value
                              (e.g., <code className="bg-purple-100 px-1 rounded">&apos;FIRM&apos;</code> or <code className="bg-purple-100 px-1 rounded">&apos;TC-&apos; || row_number()</code>).
                            </div>
                            {selectedContext.field.targetCheckConstraint?.type === 'in_list' &&
                              (selectedContext.field.targetCheckConstraint as { allowedValues?: string[] }).allowedValues && (
                              <div className="px-3 py-2 bg-blue-50 border border-blue-100 rounded-lg text-xs text-blue-700">
                                <span className="font-medium">Allowed values:</span>{' '}
                                <span className="font-mono">
                                  {((selectedContext.field.targetCheckConstraint as { allowedValues: string[] }).allowedValues).join(', ')}
                                </span>
                              </div>
                            )}
                          </div>
                        )}
                        {selectedContext?.field.contributingSourceFields && selectedContext.field.contributingSourceFields.length > 0 && (
                          <div className="mb-3 px-3 py-2 bg-blue-50 border border-blue-100 rounded-lg text-xs text-blue-700">
                            <span className="font-medium">Multi-source mapping.</span> This field also receives data from:{' '}
                            <span className="font-mono">
                              {selectedContext.field.contributingSourceFields.map((f) => f.name).join(', ')}
                            </span>
                            . Write a transform that combines all source fields
                            (e.g., <code className="bg-blue-100 px-1 rounded">CONCAT(first_name, &apos; &apos;, last_name)</code>).
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
                          readOnly={!canEdit}
                          className={`min-h-20 resize-none text-sm ${!canEdit ? 'opacity-60 cursor-not-allowed' : ''}`}
                        />
                        <div className="mt-3 flex items-center gap-2 flex-wrap">
                          <RoleTooltip allowed={canEdit} requiredRole="Editor">
                            <Button
                              variant="outline"
                              className="gap-1.5 text-sm border-gray-300 text-gray-700 hover:text-blue-700 hover:border-blue-300 hover:bg-blue-50"
                              onClick={handleSuggest}
                              disabled={isSuggesting || isGenerating || !canEdit}
                            >
                              {isSuggesting ? (
                                <span className="w-3.5 h-3.5 border-2 border-gray-400 border-t-blue-500 rounded-full animate-spin" />
                              ) : (
                                <Sparkles className="w-3.5 h-3.5" />
                              )}
                              {isSuggesting ? 'Suggesting...' : 'AI Suggest'}
                            </Button>
                          </RoleTooltip>
                          <RoleTooltip allowed={canEdit} requiredRole="Editor">
                            <Button
                              className="bg-primary hover:bg-primary/90 text-white gap-2"
                              onClick={handleGenerate}
                              disabled={isGenerating || isSuggesting || !canEdit}
                            >
                            <RefreshCw className={`w-4 h-4 ${isGenerating ? 'animate-spin' : ''}`} />
                            {isGenerating ? 'Generating...' : 'Generate Transform'}
                          </Button>
                          </RoleTooltip>
                          {canEdit && (
                            <button
                              className="text-sm text-gray-500 hover:text-gray-700 underline-offset-2 hover:underline"
                              onClick={handleClear}
                            >
                              Clear
                            </button>
                          )}
                        </div>

                        {/* Dismiss — only for standard mapped fields with no saved transform and AI flagged it */}
                        {selectedContext.field.needsTransform &&
                          !selectedContext.field.transformation &&
                          !localTransform?.sql &&
                          !selectedContext.field.isValueAssignment && (
                          <div className="mt-4 pt-4 border-t border-gray-100">
                            <button
                              onClick={async () => {
                                const fmId = selectedContext.field.fieldMappingId
                                setIsDismissing(true)
                                try {
                                  const result = await dismissTransformNeeded(projectId, fmId)
                                  if (!result.success) {
                                    showToast(result.error || 'Could not dismiss. Try again.', 'error')
                                  } else {
                                    refreshFieldNeedsTransform(fmId, false)
                                  }
                                } catch {
                                  showToast('Could not dismiss. Try again.', 'error')
                                } finally {
                                  setIsDismissing(false)
                                }
                              }}
                              disabled={isDismissing || !canEdit}
                              className="text-sm text-gray-500 hover:text-gray-700 underline underline-offset-2 decoration-gray-300 hover:decoration-gray-500 transition-colors disabled:opacity-50"
                            >
                              {isDismissing ? 'Saving…' : 'Mark as no transform needed'}
                            </button>
                            <p className="text-xs text-gray-400 mt-1">
                              This field will be mapped directly without transformation.
                            </p>
                          </div>
                        )}
                      </>
                    ) : (
                      <>
                        {/* Direct SQL mode — write expression without AI */}
                        <div className="mb-2 px-3 py-2 bg-gray-50 border border-gray-200 rounded-lg text-xs text-gray-600">
                          Write a PostgreSQL expression for a single row. Use bare field names —
                          e.g. <code className="bg-gray-100 px-1 rounded font-mono">UPPER(TRIM(lead_attorney))</code> or{' '}
                          <code className="bg-gray-100 px-1 rounded font-mono">LEFT(MD5(LOWER(TRIM(lead_attorney))), 12)</code>.
                          The system wraps field references in JSONB automatically.
                        </div>
                        <textarea
                          value={localTransform?.sql ?? ''}
                          onChange={(e) => handleSqlChange(e.target.value)}
                          placeholder={`e.g., UPPER(TRIM(${selectedContext.field.sourceFieldName ?? 'field_name'}))`}
                          rows={4}
                          spellCheck={false}
                          readOnly={!canEdit}
                          className={`w-full font-mono text-sm text-gray-800 bg-white border border-gray-300 rounded-lg px-3 py-2.5 resize-none focus:outline-none focus:ring-2 focus:ring-blue-500/30 focus:border-blue-500 placeholder-gray-400 ${!canEdit ? 'opacity-60 cursor-not-allowed' : ''}`}
                        />
                        {canEdit && (
                          <div className="mt-3 flex items-center gap-2">
                            <button
                              className="text-sm text-gray-500 hover:text-gray-700 underline-offset-2 hover:underline"
                              onClick={handleClear}
                            >
                              Clear
                            </button>
                          </div>
                        )}
                      </>
                    )}
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

                  {/* No transform needed info — also shown after user dismisses */}
                  {!selectedContext.field.needsTransform && !localTransform?.sql &&
                    !selectedContext.field.isValueAssignment && (
                    <div className="bg-blue-50 border border-blue-200 rounded-lg p-4">
                      <div className="flex items-start gap-2">
                        <AlertCircle className="w-4 h-4 text-blue-600 mt-0.5 flex-shrink-0" />
                        <div className="flex-1 min-w-0">
                          <p className="text-sm font-medium text-blue-900">No transformation needed</p>
                          <p className="text-xs text-blue-700 mt-0.5">
                            This field will be mapped directly to the target without transformation.
                          </p>
                          <button
                            onClick={async () => {
                              const fmId = selectedContext.field.fieldMappingId
                              setIsDismissing(true)
                              try {
                                const result = await reinstateTransformNeeded(projectId, fmId)
                                if (!result.success) {
                                  showToast(result.error || 'Could not reinstate. Try again.', 'error')
                                } else {
                                  refreshFieldNeedsTransform(fmId, true)
                                }
                              } catch {
                                showToast('Could not reinstate. Try again.', 'error')
                              } finally {
                                setIsDismissing(false)
                              }
                            }}
                            disabled={isDismissing || !canEdit}
                            className="mt-2 text-xs text-blue-600 hover:text-blue-800 underline underline-offset-2 disabled:opacity-50 transition-colors"
                          >
                            {isDismissing ? 'Saving…' : 'Actually, I need a transform for this field'}
                          </button>
                        </div>
                      </div>
                    </div>
                  )}

              {/* Stale warning banner */}
              {localTransform?.status === 'stale' && (
                <div className="bg-amber-50 border border-amber-200 rounded-md px-4 py-3 flex items-start gap-2">
                  <AlertTriangle className="h-5 w-5 text-amber-600 mt-0.5 shrink-0" />
                  <div>
                    <p className="text-sm font-medium text-amber-800">This transform may be outdated</p>
                    <p className="text-xs text-amber-700 mt-1">
                      The parent field&apos;s transform has changed. Regenerate this transform or re-cascade from the parent to ensure referential integrity.
                    </p>
                  </div>
                </div>
              )}

              {/* Generated SQL — collapsed by default, toggle to expand (hidden in direct SQL mode) */}
              {localTransform?.sql && inputMode === 'ai' && (
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
                        className="w-full font-mono text-xs text-gray-800 bg-gray-50 rounded border border-gray-200 p-3 resize-none focus:outline-none focus:ring-2 focus:ring-blue-500/30 focus:border-blue-500"
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
                    {showStagedPreview ? (
                      <span className="text-xs px-2 py-0.5 rounded-full bg-green-100 text-green-700 font-medium">
                        Staged ✓
                      </span>
                    ) : (
                      <span className="text-xs px-2 py-0.5 rounded-full bg-blue-100 text-blue-700 font-medium">
                        Live
                      </span>
                    )}
                    {previewLoading && !showStagedPreview && (
                      <span className="w-3.5 h-3.5 border-2 border-blue-500 border-t-transparent rounded-full animate-spin" />
                    )}
                    {!showStagedPreview && hasFieldIssues && issueCount > 0 && !previewLoading && (
                      <span className="text-xs text-amber-600">
                        · {issueCount.toLocaleString()} rows have source issues
                      </span>
                    )}
                    {!showStagedPreview && elseIndices.size > 0 && !previewLoading && (
                      <span className="text-xs text-amber-600">
                        · {elseIndices.size} may hit ELSE clause
                      </span>
                    )}
                    {showStagedPreview && stagedPreview && (
                      <span className="text-xs text-gray-500">
                        · {stagedPreview.totalRows.toLocaleString()} rows staged
                      </span>
                    )}
                  </div>
                  <div className="flex items-center gap-2">
                    {showStagedPreview && (
                      <button
                        onClick={() => setShowStagedPreview(false)}
                        className="text-xs text-gray-500 hover:text-gray-700 underline-offset-2 hover:underline"
                      >
                        Show live
                      </button>
                    )}
                    {localTransform?.sql && !showStagedPreview && (
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
                </div>

                {previewError && !showStagedPreview && (
                  <div className="px-4 py-2.5 bg-red-50 border-b border-red-100">
                    <p className="text-xs text-red-700 font-mono break-all">{previewError}</p>
                  </div>
                )}

                {showStagedPreview && stagedPreview ? (
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="border-b border-gray-100 bg-gray-50/50">
                        <th className="text-left px-4 py-2.5 text-xs font-medium text-gray-500 w-1/2">
                          Source ({selectedContext.field.sourceFieldName})
                        </th>
                        <th className="px-1 py-2.5 w-6" />
                        <th className="text-left px-4 py-2.5 text-xs font-medium text-gray-500 w-1/2">
                          Target ({selectedContext.field.targetFieldName})
                          <span className="ml-2 text-green-600 font-normal normal-case">✓ Staged</span>
                        </th>
                      </tr>
                    </thead>
                    <tbody>
                      {stagedPreview.rows.map((row, i) => (
                        <tr key={i} className="border-b border-gray-100 last:border-0 hover:bg-gray-50/50">
                          <td className="px-4 py-2 font-mono text-xs align-top text-gray-500">
                            {row.sourceValue != null ? String(row.sourceValue) : <span className="italic text-gray-400">null</span>}
                          </td>
                          <td className="px-1 py-2 text-center text-gray-300 text-xs align-top">→</td>
                          <td className="px-4 py-2 font-mono text-xs align-top text-green-700">
                            {row.targetValue != null ? String(row.targetValue) : <span className="italic text-gray-400 font-normal">null</span>}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                ) : (() => {
                  // Determine all source columns for this mapping
                  const isValueAssignment = selectedContext.field.isValueAssignment
                  const srcColumns = isValueAssignment
                    ? []
                    : [
                        selectedContext.field.sourceFieldName,
                        ...selectedContext.field.contributingSourceFields.map((f) => f.name),
                      ].filter(Boolean) as string[]
                  const isManyToOne = srcColumns.length > 1

                  return (
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-gray-100 bg-gray-50/50">
                      {isValueAssignment ? null : isManyToOne ? (
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
                      {!isValueAssignment && <th className="px-1 py-2.5 w-6" />}
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
                            {isValueAssignment ? null : isManyToOne ? (
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
                            {!isValueAssignment && <td className="px-1 py-2 text-center text-gray-300 text-xs align-top">→</td>}
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
                      className="text-xs text-blue-600 hover:text-blue-800 font-medium whitespace-nowrap"
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
              <div className={`mx-5 mb-4 rounded-lg border text-sm ${testResult.failedRows === 0 ? 'bg-green-50 border-green-200' : 'bg-amber-50 border-amber-200'}`}>
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
                      <AlertTriangle className="w-4 h-4 text-amber-600 flex-shrink-0" />
                      <span className="font-medium text-amber-800">
                        {testResult.passedRows?.toLocaleString() ?? (testResult.totalRows - testResult.failedRows).toLocaleString()} of {testResult.totalRows.toLocaleString()} rows passed — {testResult.failedRows.toLocaleString()} failures
                      </span>
                    </>
                  )}
                </div>
                {testResult.failedRows > 0 && testResult.failures.length > 0 && (
                  <details className="border-t border-amber-200">
                    <summary className="px-4 py-2 text-xs text-amber-700 cursor-pointer hover:bg-amber-100/50">
                      View failed values ({Math.min(testResult.failures.length, 20)} shown)
                    </summary>
                    <table className="w-full text-xs">
                      <thead>
                        <tr className="bg-amber-100/60">
                          <th className="text-left px-4 py-1.5 font-medium text-amber-700 w-16">Row</th>
                          <th className="text-left px-4 py-1.5 font-medium text-amber-700 w-40">Source Value</th>
                          <th className="text-left px-4 py-1.5 font-medium text-amber-700">Error</th>
                        </tr>
                      </thead>
                      <tbody className="max-h-40 overflow-y-auto">
                        {testResult.failures.slice(0, 20).map((f, i) => (
                          <tr key={i} className="border-t border-amber-200/60">
                            <td className="px-4 py-1.5 text-amber-600 font-mono">{f.rowNumber}</td>
                            <td className="px-4 py-1.5 font-mono text-amber-700 truncate max-w-[10rem]">
                              <code className="bg-amber-100 px-1 rounded">{f.sourceValue || ''}</code>
                            </td>
                            <td className="px-4 py-1.5 text-amber-600 truncate">— {f.errorMessage}</td>
                          </tr>
                        ))}
                        {testResult.failedRows > testResult.failures.length && (
                          <tr className="border-t border-amber-200/60">
                            <td colSpan={3} className="px-4 py-1.5 text-amber-500 italic">
                              ... and {(testResult.failedRows - testResult.failures.length).toLocaleString()} more failures
                            </td>
                          </tr>
                        )}
                      </tbody>
                    </table>
                    <div className="px-4 py-2.5 border-t border-amber-200 bg-amber-50/80 flex items-center gap-3">
                      <span className="text-xs text-amber-600 flex-1">Fix the transform logic above, then re-test.</span>
                      <button
                        className="text-xs font-medium text-blue-700 hover:text-blue-900 underline-offset-2 hover:underline"
                        onClick={() => {
                          setLocalTransform((prev) => prev ? { ...prev, status: 'tested' } : null)
                          setTestResult(null)
                          showToast('Test override — Apply will skip failed rows.', 'success')
                        }}
                      >
                        Apply Anyway (skip {testResult.failedRows} failed rows)
                      </button>
                    </div>
                  </details>
                )}
              </div>
            )}

                {/* Archived: show read-only notice above action bar */}
                {isArchived && (
                  <div className="flex-shrink-0 border-t border-amber-200 bg-amber-50 px-4 py-2.5 text-xs text-amber-700">
                    Transform testing is not available for archived projects. The transformation logic is preserved but cannot be tested without source data.
                  </div>
                )}

                {/* Pinned action bar — flex-shrink-0 keeps it visible below the scroll area */}
                {localTransform?.sql && !isArchived && (
                  <div className="flex-shrink-0 z-10 border-t border-gray-200 bg-white px-4 py-3 flex items-center gap-3 shadow-[0_-2px_8px_rgba(0,0,0,0.06)]">
                    {/* Test Transform */}
                    <RoleTooltip allowed={canEdit} requiredRole="Editor">
                      <Button
                        variant="outline"
                        className="gap-2 border-gray-300 text-gray-700 hover:border-blue-400 hover:text-blue-700 hover:bg-blue-50"
                        onClick={handleTest}
                        disabled={isTesting || !localTransform?.transformationId || !canEdit}
                      >
                        {isTesting ? (
                          <span className="flex items-center gap-2">
                            <span className="w-3.5 h-3.5 border-2 border-gray-400 border-t-blue-600 rounded-full animate-spin" />
                            Testing...
                          </span>
                        ) : (
                          <>
                            <Play className="w-3.5 h-3.5" />
                            Test Transform
                          </>
                        )}
                      </Button>
                    </RoleTooltip>
                    {/* Apply Transform — only enabled after successful test */}
                    <RoleTooltip allowed={canEdit} requiredRole="Editor">
                      <Button
                        className="bg-primary hover:bg-primary/90 text-white gap-2 px-6 disabled:opacity-50 disabled:cursor-not-allowed"
                        onClick={handleApply}
                        disabled={isApplying || isCheckingIssues || !localTransform?.transformationId || localTransform.status !== 'tested' || !canEdit}
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
                    </RoleTooltip>
                    {/* Revert — only when status is applied */}
                    {localTransform?.status === 'applied' && canEdit && (
                      <button
                        onClick={handleRevert}
                        disabled={isReverting}
                        className="text-sm text-red-600 hover:text-red-800 flex items-center gap-1 ml-1 disabled:opacity-50 disabled:cursor-not-allowed"
                      >
                        <Undo2 className="w-4 h-4" />
                        {isReverting ? 'Reverting…' : 'Revert'}
                      </button>
                    )}
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
              <RoleTooltip allowed={canEdit} requiredRole="Editor">
                <Button
                  className="bg-primary hover:bg-primary/90 text-white disabled:opacity-60"
                  disabled={isStaging || !canEdit}
                  onClick={() => {
                    setStagingError(null)
                    startStaging(async () => {
                      try {
                        const result = await stageAllData(projectId)
                        if (!result.success) {
                          const msg = result.error ?? 'Staging failed'
                          setStagingError(msg)
                          showToast(msg, 'error')
                          return
                        }
                        router.push(`/app/projects/${projectId}/data-quality`)
                      } catch (e) {
                        const msg = e instanceof Error ? e.message : 'Staging failed'
                        setStagingError(msg)
                        showToast(msg, 'error')
                      }
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
              </RoleTooltip>
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

      {/* Revert confirmation dialog */}
      <AlertDialog open={showRevertDialog} onOpenChange={setShowRevertDialog}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Revert staged data?</AlertDialogTitle>
            <AlertDialogDescription>
              This will remove the staged transformation data for this field and reset it back to tested status. Other fields will not be affected.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={confirmRevert}
              className="bg-red-600 hover:bg-red-700 text-white focus-visible:ring-red-600"
            >
              Revert
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* FK cascade prompt — shown after applying a transform to a PK field */}
      {showFKCascade && fkCascadeData && (
        <FKCascadePrompt
          pkTableName={fkCascadeData.pkTableName}
          pkFieldName={fkCascadeData.pkFieldName}
          pkTransformSQL={fkCascadeData.pkTransformSQL}
          dependents={fkCascadeData.dependents}
          onCascade={handleFKCascade}
          onSkip={handleFKCascadeSkip}
        />
      )}

      {/* AI Suggest — replace existing description confirmation */}
      {showReplaceConfirm && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30">
          <div className="bg-white rounded-xl shadow-xl p-6 max-w-md w-full mx-4">
            <h3 className="text-base font-semibold text-gray-900 mb-2 flex items-center gap-2">
              <Sparkles className="w-4 h-4 text-blue-500" />
              Replace current description?
            </h3>
            <p className="text-sm text-gray-500 mb-3">AI suggestion:</p>
            <div className="bg-gray-50 border border-gray-200 rounded-lg px-3 py-2.5 text-sm text-gray-800 mb-5">
              {showReplaceConfirm}
            </div>
            <div className="flex gap-3 justify-end">
              <Button variant="outline" size="sm" onClick={() => setShowReplaceConfirm(null)}>Keep current</Button>
              <Button size="sm" className="bg-primary hover:bg-primary/90 text-white" onClick={applyReplaceConfirm}>
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
  dataset, expanded, expandedTables, selectedMappingId, selectedUnmappedFieldId,
  staleTableMappingIds, unmappedByTargetTable, filter,
  onToggleDataset, onToggleTable, onSelectField, onSelectUnmappedField,
}: {
  dataset: DatasetGroup
  expanded: boolean
  expandedTables: Set<string>
  selectedMappingId: string | null
  selectedUnmappedFieldId: string | null
  staleTableMappingIds: Set<string>
  unmappedByTargetTable: Record<string, { notNull: UnmappedTargetField[]; nullable: UnmappedTargetField[] }>
  filter: TransformFilter
  onToggleDataset: (id: string) => void
  onToggleTable: (id: string) => void
  onSelectField: (id: string) => void
  onSelectUnmappedField: (id: string) => void
}) {
  return (
    <div className="border border-gray-200 rounded-lg overflow-hidden">
      <button
        onClick={() => onToggleDataset(dataset.datasetId)}
        className="w-full flex items-center gap-2 px-3 py-2.5 bg-white hover:bg-gray-50 transition-colors"
      >
        {expanded ? <ChevronDown className="w-4 h-4 text-gray-500 flex-shrink-0" /> : <ChevronRight className="w-4 h-4 text-gray-500 flex-shrink-0" />}
        <span className="text-xs font-bold text-blue-600 truncate uppercase tracking-wide" title={dataset.datasetName}>
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
              selectedUnmappedFieldId={selectedUnmappedFieldId}
              isTableStale={staleTableMappingIds.has(tbl.tableMappingId)}
              unmappedFields={unmappedByTargetTable[tbl.targetTableName]}
              filter={filter}
              onToggle={() => onToggleTable(tbl.tableMappingId)}
              onSelectField={onSelectField}
              onSelectUnmappedField={onSelectUnmappedField}
            />
          ))}
        </div>
      )}
    </div>
  )
}

// ── TableNode ─────────────────────────────────────────────────────────────────

function TableNode({
  table, expanded, selectedMappingId, selectedUnmappedFieldId, isTableStale,
  unmappedFields, filter, onToggle, onSelectField, onSelectUnmappedField,
}: {
  table: TableGroup
  expanded: boolean
  selectedMappingId: string | null
  selectedUnmappedFieldId: string | null
  isTableStale: boolean
  unmappedFields?: { notNull: UnmappedTargetField[]; nullable: UnmappedTargetField[] }
  filter: TransformFilter
  onToggle: () => void
  onSelectField: (id: string) => void
  onSelectUnmappedField: (id: string) => void
}) {
  const primaryFields = table.fields.filter((f) => !f.isContributing)

  // Apply filter to mapped fields
  const filteredFields = primaryFields.filter((f) => {
    switch (filter) {
      case 'needs_transform': return f.needsTransform
      case 'has_transform': return f.transformation !== null
      case 'applied': return f.transformation?.status === 'applied'
      case 'unmapped': return false
      default: return true
    }
  })

  const showUnmapped = filter === 'all' || filter === 'unmapped'
  const unmappedNotNull = showUnmapped ? (unmappedFields?.notNull ?? []) : []
  const unmappedNullable = showUnmapped ? (unmappedFields?.nullable ?? []) : []
  const totalVisible = filteredFields.length + unmappedNotNull.length + unmappedNullable.length

  if (totalVisible === 0) return null

  return (
    <div>
      <button
        onClick={onToggle}
        className="w-full flex items-center justify-between px-3 py-2.5 bg-white hover:bg-gray-50 transition-colors"
      >
        <div className="flex items-center gap-2 min-w-0">
          {expanded ? <ChevronDown className="w-3.5 h-3.5 text-gray-400 flex-shrink-0" /> : <ChevronRight className="w-3.5 h-3.5 text-gray-400 flex-shrink-0" />}
          <span className="text-xs font-semibold text-gray-800 truncate" title={table.sourceTableName}>{table.sourceTableName}</span>
        </div>
        <div className="flex items-center gap-1 flex-shrink-0 ml-2">
          <ArrowRight className="w-3 h-3 text-gray-400" />
          <span className="text-xs text-gray-500 truncate max-w-[80px]" title={table.targetTableName}>{table.targetTableName}</span>
        </div>
      </button>
      {expanded && (
        <div className="bg-gray-50 border-t border-gray-100">
          {(() => {
            // Detect one-to-many groups within the filtered list
            const srcCounts = new Map<string, number>()
            for (const f of filteredFields) {
              if (!f.sourceFieldId) continue
              srcCounts.set(f.sourceFieldId, (srcCounts.get(f.sourceFieldId) ?? 0) + 1)
            }
            const oneToManySrcIds = new Set(
              [...srcCounts.entries()].filter(([, c]) => c > 1).map(([id]) => id)
            )

            if (oneToManySrcIds.size === 0) {
              // No one-to-many groups — render flat list
              return filteredFields.map((field) => {
                const oneToManyCount = field.sourceFieldId
                  ? primaryFields.filter((f) => f.sourceFieldId === field.sourceFieldId).length
                  : 0
                return (
                  <FieldRow
                    key={field.fieldMappingId}
                    field={field}
                    isSelected={selectedMappingId === field.fieldMappingId}
                    onSelect={() => onSelectField(field.fieldMappingId)}
                    oneToManyCount={oneToManyCount}
                  />
                )
              })
            }

            // Render with one-to-many groups wrapped in purple containers
            const rendered = new Set<string>()
            return filteredFields.map((field) => {
              if (rendered.has(field.fieldMappingId)) return null
              rendered.add(field.fieldMappingId)

              if (field.sourceFieldId && oneToManySrcIds.has(field.sourceFieldId)) {
                const groupFields = filteredFields.filter(
                  (f) => f.sourceFieldId === field.sourceFieldId
                )
                groupFields.forEach((f) => rendered.add(f.fieldMappingId))

                // Use full primaryFields count for the badge (unaffected by active filter)
                const groupCount = primaryFields.filter(
                  (f) => f.sourceFieldId === field.sourceFieldId
                ).length

                return (
                  <div key={`otm-${field.sourceFieldId}`} className="border-l-2 border-purple-200 my-0.5">
                    <div className="text-[11px] text-purple-600 font-medium px-3 py-1 bg-purple-50/50">
                      Split: {field.sourceFieldName} → {groupCount} target fields
                    </div>
                    {groupFields.map((gf) => (
                      <FieldRow
                        key={gf.fieldMappingId}
                        field={gf}
                        isSelected={selectedMappingId === gf.fieldMappingId}
                        onSelect={() => onSelectField(gf.fieldMappingId)}
                        oneToManyCount={groupCount}
                      />
                    ))}
                  </div>
                )
              }

              return (
                <FieldRow
                  key={field.fieldMappingId}
                  field={field}
                  isSelected={selectedMappingId === field.fieldMappingId}
                  onSelect={() => onSelectField(field.fieldMappingId)}
                  oneToManyCount={0}
                />
              )
            }).filter(Boolean)
          })()}

          {/* Unmapped target fields — same layout as FieldRow */}
          {[...unmappedNotNull, ...unmappedNullable].map((field) => {
            const isRequired = !field.is_nullable
            const isSelected = selectedUnmappedFieldId === field.id
            return (
              <button
                key={field.id}
                onClick={() => onSelectUnmappedField(field.id)}
                className={`w-full px-3 py-2.5 border-b border-gray-100 last:border-0 text-left transition-colors ${
                  isSelected
                    ? isRequired ? 'bg-amber-50 border-l-2 border-l-amber-400' : 'bg-gray-100 border-l-2 border-l-gray-400'
                    : 'border-l-2 border-l-transparent hover:bg-gray-50'
                }`}
              >
                <div className="flex items-start justify-between gap-2 mb-0.5">
                  <div className="flex items-center gap-1.5 min-w-0 flex-1">
                    <div className={`w-1.5 h-1.5 rounded-full flex-shrink-0 mt-0.5 ${isRequired ? 'bg-amber-400' : 'bg-gray-300'}`} />
                    <span className={`text-xs font-semibold truncate ${isRequired ? 'text-gray-900' : 'text-gray-500'}`}>{field.name}</span>
                  </div>
                  <Badge className={`text-[10px] px-1.5 py-0 flex-shrink-0 ${
                    isRequired
                      ? 'bg-amber-100 text-amber-700 hover:bg-amber-100 border border-amber-200'
                      : 'bg-gray-100 text-gray-500 hover:bg-gray-100 border border-gray-200'
                  }`}>
                    {isRequired ? 'Required' : 'Unmapped'}
                  </Badge>
                </div>
                <div className="flex items-center gap-1 pl-3">
                  <span className="text-[11px] text-gray-400 italic">No source mapped</span>
                </div>
              </button>
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

  if (field.isValueAssignment) {
    return (
      <button
        onClick={onSelect}
        className={`w-full px-3 py-2.5 border-b border-gray-100 last:border-0 text-left transition-colors ${
          isSelected
            ? 'bg-purple-50 border-l-2 border-l-purple-400'
            : 'border-l-2 border-l-transparent hover:bg-gray-50'
        }`}
      >
        <div className="flex items-start justify-between gap-2 mb-0.5">
          <div className="flex items-center gap-1.5 min-w-0 flex-1">
            <span className="text-purple-500 text-xs font-mono flex-shrink-0">ƒ</span>
            <span className="text-xs font-semibold text-purple-700 truncate">{field.targetFieldName}</span>
          </div>
          <div className="flex items-center gap-1 flex-shrink-0">
            {status === 'applied' ? (
              <Badge className="bg-green-100 text-green-700 hover:bg-green-100 border border-green-200 text-[10px] px-1.5 py-0">
                Staged ✓
              </Badge>
            ) : field.transformation ? (
              <Badge className="bg-purple-100 text-purple-700 hover:bg-purple-100 border border-purple-200 text-[10px] px-1.5 py-0">
                Saved
              </Badge>
            ) : (
              <Badge className="bg-purple-100 text-purple-700 hover:bg-purple-100 border border-purple-200 text-[10px] px-1.5 py-0">
                Define
              </Badge>
            )}
          </div>
        </div>
        <div className="flex items-center gap-1 pl-4">
          <span className="text-[10px] text-purple-400">value assignment</span>
        </div>
      </button>
    )
  }

  return (
    <button
      onClick={onSelect}
      className={`w-full px-3 py-2.5 border-b border-gray-100 last:border-0 text-left transition-colors ${
        isSelected
          ? 'bg-blue-50 border-l-2 border-l-blue-600'
          : 'border-l-2 border-l-transparent hover:bg-gray-50'
      }`}
    >
      <div className="flex items-start justify-between gap-2 mb-0.5">
        <div className="flex items-center gap-1.5 min-w-0 flex-1">
          <div className="w-1.5 h-1.5 rounded-full bg-gray-400 flex-shrink-0 mt-0.5" />
          <span className="text-xs font-semibold text-gray-900 truncate" title={field.sourceFieldName ?? undefined}>{field.sourceFieldName}</span>
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
          {status === 'applied' && (
            <span title="Data staged"><CheckCircle2 className="w-3.5 h-3.5 text-green-500" /></span>
          )}
          {status === 'stale' && (
            <span title="Transform edited after apply — re-apply needed">
              <AlertCircle className="w-3.5 h-3.5 text-amber-500" />
            </span>
          )}
          {status === 'applied' ? (
            <Badge className="bg-green-100 text-green-700 hover:bg-green-100 border border-green-200 text-[10px] px-1.5 py-0">
              Staged ✓
            </Badge>
          ) : status === 'stale' ? (
            <Badge className="bg-amber-100 text-amber-700 hover:bg-amber-100 border border-amber-200 text-[10px] px-1.5 py-0">
              Stale ⚠
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
            <Badge className="bg-gray-100 text-gray-500 hover:bg-gray-100 border border-gray-200 text-[10px] px-1.5 py-0">
              Define
            </Badge>
          ) : null}
        </div>
      </div>
      <div className="flex items-center gap-1 pl-3">
        <ArrowRight className="w-3 h-3 text-gray-400 flex-shrink-0" />
        <span className="text-[11px] text-gray-500 truncate" title={field.targetFieldName ?? undefined}>{field.targetFieldName}</span>
      </div>
    </button>
  )
}
