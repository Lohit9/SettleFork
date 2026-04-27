'use client'

// ─────────────────────────────────────────────────────────────────────────────
// TransformContent — Transform tab editor (Phase 2, mapping redesign).
// ─────────────────────────────────────────────────────────────────────────────
//
// BUG B HISTORICAL CONTEXT (C1 diagnostic, 2026-04-21; closed by C2, 2026-04-23)
//
//   Symptom: after generating a VA SQL + clicking "Save Value" + "Apply",
//   the sidebar badge briefly showed "Applied" but reverted to "Saved" on
//   any tab-switch, inviting users to double-apply (activity_log captured
//   TFM fa67fca9... applied twice 35 min apart).
//
//   Client-side root cause: the old `handleUnmappedSave` spliced a new
//   FieldItem into `data.datasets` but did not re-initialise `localTransform`
//   for the now-selected mapped-field UI, so every subsequent
//   `setLocalTransform((prev) => prev ? … : null)` was a no-op. Combined
//   with a splice routing bug (appended to every matching TM instead of the
//   first), the sidebar badge drifted from the DB on every RSC refetch.
//
//   Hypotheses rejected by the DB diagnostic:
//   - B1 (server status fails to persist) — ruled out; `transformations.status`
//     was correctly 'applied' on every inspected VA.
//   - B4 (Router Cache serves a stale RSC prefetch) — ruled out; C1 runtime
//     instrumentation (removed in C2) reported fresh DB state on every tab
//     transition.
//
//   C1 fix (applied 2026-04-21): splice route correction + explicit
//   `setLocalTransform` in `handleUnmappedSave` before flipping selection.
//   C2 fix (this file, 2026-04-23): deleted `handleUnmappedSave` entirely in
//   favour of the Deferred-Creation Pattern (Variant C) — unmapped rows now
//   render through the unified mapped-field UI using a synthesised
//   placeholder FieldItem, and TFM creation is deferred to the three
//   explicit commit triggers (AI Suggest, Generate SQL, Test Transform),
//   each routed through `ensureValueAssignment` server action. This removes
//   the entire client-side state-stomping surface that made Bug B possible.

import { useState, useEffect, useTransition, useCallback, useRef, useMemo } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { PageHeader } from '@/components/app/PageHeader'
import { type ProjectInfo } from '@/components/app/ProjectInfoPopover'
import { Textarea } from '@/components/ui/textarea'
import {
  RefreshCw,
  ChevronDown,
  ChevronRight,
  ArrowRight,
  CornerLeftUp,
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
  dismissValueAssignment,
  reinstateValueAssignment,
  ensureValueAssignment,
} from '@/lib/actions/transformations'
import type {
  TransformPageData,
  DatasetGroup,
  TableGroup,
  FieldItem,
  FullTransformTestResult,
  UnmappedTargetField,
  TargetTableGroup,
  TargetTableRow,
} from '@/lib/actions/transformations'
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
  TableFieldFilter,
  type FilterTable,
  type TableFieldSelection,
} from '@/components/app/TableFieldFilter'
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
import { readTargetFieldMappingIdFromSearchParams } from '@/lib/url/transform-params'

// ── Types ──────────────────────────────────────────────────────────────────────

interface Props {
  projectId: string
  projectName: string
  initialData: TransformPageData
  isArchived?: boolean
  projectInfo?: ProjectInfo
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

// ── TransformStatPills ────────────────────────────────────────────────────────

function TransformStatPills({
  totalCount,
  appliedCount,
  inProgressCount,
  toDefineCount,
}: {
  totalCount: number
  appliedCount: number
  inProgressCount: number
  toDefineCount: number
}) {
  return (
    <div className="flex items-center gap-0 px-5 py-2 bg-white flex-shrink-0">
      <div className="flex items-center gap-1.5 px-3">
        <span className="text-xs text-gray-500">Needs Transform</span>
        <span className="text-sm font-medium text-settle-slate-900">{totalCount}</span>
      </div>
      <div className="w-px h-4 bg-gray-100 flex-shrink-0" />
      <div className="flex items-center gap-1.5 px-3">
        <span className="text-xs text-gray-500">Applied</span>
        <span className="text-sm font-medium text-settle-slate-900">{appliedCount}</span>
      </div>
      <div className="w-px h-4 bg-gray-100 flex-shrink-0" />
      <div className="flex items-center gap-1.5 px-3">
        <span className="text-xs text-gray-500">In Progress</span>
        <span className="text-sm font-medium text-settle-slate-900">{inProgressCount}</span>
      </div>
      <div className="w-px h-4 bg-gray-100 flex-shrink-0" />
      <div className="flex items-center gap-1.5 px-3">
        <span className="text-xs text-gray-500">To Define</span>
        <span className="text-sm font-medium text-settle-slate-900">{toDefineCount}</span>
      </div>
    </div>
  )
}

// ── TransformContent ──────────────────────────────────────────────────────────

export default function TransformContent({ projectId, projectName, initialData, isArchived = false, projectInfo }: Props) {
  // Phase 3 — `use_mapping_redesign` no longer dispatches to a separate
  // placeholder component. Both flag states render this UI; the
  // target-led sidebar + VA dismissal symmetry land in a single surface.
  // The `projectInfo` prop is preserved for future consumers and to keep
  // the page-level data fetcher's contract stable.
  void projectInfo
  const router = useRouter()
  const searchParams = useSearchParams()
  const { can } = useProjectRole(projectId)
  const canEdit = can('edit')
  const [data, setData] = useState<TransformPageData>(initialData)
  const [selectedMappingId, setSelectedMappingId] = useState<string | null>(null)
  // Phase 3 — sidebar regrouped from source-led (dataset → table_mapping)
  // to target-led (target_table). One Set is enough: every group is a
  // target table, identified by `targetTableId`. All groups start expanded
  // so the user sees the full landscape on first paint; toggle collapses.
  const [expandedTargetTables, setExpandedTargetTables] = useState<Set<string>>(
    new Set(initialData.targetTableGroups.map((g) => g.targetTableId))
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
  // VA dismissal (migration 077) — `isVADismissing` covers the entire
  // round-trip (button disable + spinner). `showVADismissConfirm` opens
  // the confirmation AlertDialog. The two flags coexist: dialog open →
  // user clicks Dismiss → dialog closes → request fires → dialog stays
  // closed and the action bar shows a spinner via `isVADismissing`.
  const [isVADismissing, setIsVADismissing] = useState(false)
  const [showVADismissConfirm, setShowVADismissConfirm] = useState(false)

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

  // Pending VA commit — dedupe concurrent `ensureValueAssignment` calls.
  // Variant C Race 3A fix (C2): the three commit triggers (AI Suggest,
  // Generate SQL, Test Transform) can fire back-to-back before the server
  // returns. We keep one in-flight promise keyed by selectedMappingId so
  // all concurrent callers share the same fmId/transformationId result.
  const vaCommitInFlightRef = useRef<Map<string, Promise<{
    success: boolean
    fieldMappingId?: string
    transformationId?: string
    error?: string
  }>>>(new Map())

  // Sidebar filter
  const [sidebarFilter, setSidebarFilter] = useState<TransformFilter>('all')
  const [sidebarSearchQuery, setSidebarSearchQuery] = useState('')

  // Table / field multi-select filter (shared with URL)
  const [tableFieldSelection, setTableFieldSelection] =
    useState<TableFieldSelection>({
      selectedFieldIds: null,
      selectedTableIds: new Set(),
    })

  // Sync selection to URL on change (preserves other query params)
  const handleTableSelectionChange = useCallback(
    (next: TableFieldSelection) => {
      setTableFieldSelection(next)
      const params = new URLSearchParams(searchParams.toString())
      if (next.selectedFieldIds && next.selectedFieldIds.size > 0) {
        params.set('fields', [...next.selectedFieldIds].join(','))
      } else {
        params.delete('fields')
      }
      router.replace(
        `/app/projects/${projectId}/transform?${params.toString()}`
      )
    },
    [searchParams, router, projectId]
  )

  // Read initial selection from URL on mount.
  //
  // Phase 3 — `selectedTableIds` keys on `targetTableId` to mirror the
  // sidebar's target-led grouping. The on-disk URL (`?fields=`) is
  // unchanged: it stores TFM ids, which are stable across the regrouping.
  // Only the in-memory derived "which tables are selected" set switched
  // its key. The derivation walks `data.targetTableGroups` (not the
  // legacy `data.datasets` source-led shape).
  useEffect(() => {
    const fields = searchParams.get('fields')
    if (!fields) return
    const ids = new Set(fields.split(',').filter(Boolean))
    const tableIds = new Set<string>()
    for (const g of data.targetTableGroups) {
      const hasSelected = g.rows.some(
        (r) => r.kind === 'mapping' && ids.has(r.field.fieldMappingId),
      )
      if (hasSelected) tableIds.add(g.targetTableId)
    }
    setTableFieldSelection({
      selectedFieldIds: ids,
      selectedTableIds: tableIds,
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const hasActiveTransformFilters = useMemo(
    () =>
      (tableFieldSelection.selectedFieldIds !== null &&
        tableFieldSelection.selectedFieldIds.size > 0) ||
      sidebarFilter !== 'all' ||
      sidebarSearchQuery.trim() !== '',
    [tableFieldSelection, sidebarFilter, sidebarSearchQuery]
  )

  const resetTransformFilters = useCallback(() => {
    setTableFieldSelection({
      selectedFieldIds: null,
      selectedTableIds: new Set(),
    })
    setSidebarFilter('all')
    setSidebarSearchQuery('')
    const params = new URLSearchParams(searchParams.toString())
    params.delete('fields')
    const qs = params.toString()
    router.replace(
      `/app/projects/${projectId}/transform${qs ? `?${qs}` : ''}`
    )
  }, [searchParams, router, projectId])

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

  // Auto-select field from URL query param (e.g. when navigating from mapping drawer).
  // Accepts both `?targetFieldMappingId` (new, Phase 3+) and `?fieldMappingId`
  // (legacy) — see lib/url/transform-params.ts for the back-compat contract.
  useEffect(() => {
    const fmId = readTargetFieldMappingIdFromSearchParams(searchParams)
    if (fmId && fmId !== selectedMappingId) {
      setSelectedMappingId(fmId)
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchParams])

  // Page-header subtitle reads the same canonical scalar that powers the
  // pills (`computeProjectStats.transformScope`) — see the loader in
  // `lib/actions/transformations.ts:getTransformData` for the source of
  // truth.
  const needsTransformCount = data.transformScope

  // Phase 3 — Tables filter is target-table-led to mirror the sidebar's
  // new grouping. The dropdown lists each target table once, with the
  // contained fields (TFMs) as the leaves. Multi-source TFMs surface
  // their primary source name in the leaf label; truly-unmapped target
  // fields don't currently participate in this filter (parity with
  // pre-Phase-3 behaviour where unmapped rows lived under their target
  // table_mapping group).
  const filterTables = useMemo(
    (): FilterTable[] =>
      data.targetTableGroups.map((g) => ({
        id: g.targetTableId,
        label: g.targetTableName,
        fields: g.rows
          .filter((r): r is { kind: 'mapping'; field: FieldItem } => r.kind === 'mapping')
          .map((r) => ({
            id: r.field.fieldMappingId,
            label: r.field.isValueAssignment
              ? `${r.field.targetFieldName} (value assignment)`
              : `${r.field.targetFieldName} ← ${r.field.sourceFieldName ?? 'unmapped'}`,
          })),
      })),
    [data.targetTableGroups]
  )

  // Filter counts
  const allFieldsFlat = useMemo(() => data.datasets.flatMap((ds) => ds.tables.flatMap((t) => t.fields)), [data.datasets])
  const filterCounts = useMemo(() => {
    // Phase 3 — `f.isContributing` is always `false` in the new model
    // (see `FieldItem.isContributing` doc comment). The legacy filter is
    // dropped per Finding 8; `mapped` is now `allFieldsFlat` directly.
    const mapped = allFieldsFlat
    const totalUnmapped = data.unmappedNotNullTargetFields.length + data.unmappedNullableTargetFields.length
    // Migration 077 — dismissed VAs are addressed; they don't claim
    // attention from the `needs_transform` bucket. They DO still count
    // toward `all` (so the full TFM total isn't silently shrunk) but
    // are filtered out everywhere a "needs work" semantic applies.
    const needsTransform = mapped.filter((f) => f.needsTransform).length
    const dismissed = mapped.filter((f) => f.vaDismissed).length
    return {
      all: mapped.length + totalUnmapped,
      needs_transform: needsTransform,
      has_transform: mapped.filter((f) => f.transformation !== null).length,
      unmapped: totalUnmapped,
      applied: mapped.filter((f) => f.transformation?.status === 'applied').length,
      dismissed,
    }
  }, [allFieldsFlat, data.unmappedNotNullTargetFields.length, data.unmappedNullableTargetFields.length])

  const sidebarSummary = useMemo(() => {
    const applied = filterCounts.applied
    const needsTransform = filterCounts.needs_transform
    const inProgress = filterCounts.has_transform - applied
    const toDefine = needsTransform - filterCounts.has_transform
    const parts: string[] = []
    if (applied > 0) parts.push(`${applied} applied`)
    if (inProgress > 0) parts.push(`${inProgress} in progress`)
    if (toDefine > 0) parts.push(`${toDefine} to define`)
    return parts.join(' · ')
  }, [filterCounts])

  const inProgressCount = useMemo(
    () => filterCounts.has_transform - filterCounts.applied,
    [filterCounts.has_transform, filterCounts.applied]
  )


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
    // Variant C (C2) auto-preview gate: skip preview when we're on a
    // pending-sentinel selection (no transformationId yet). The preview
    // RPCs key on target_field_mapping_id and would 404 on `pending:…`;
    // auto-preview resumes automatically once `ensureValueAssignmentOnce`
    // swaps `selectedMappingId` to the real TFM id.
    if (!sql?.trim() || !selectedMappingId || !localTransform?.transformationId) {
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
  }, [localTransform?.sql, localTransform?.transformationId, selectedMappingId, previewMode])

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

  // ── Select an unmapped target field (Variant C placeholder) ───────────────
  //
  // Sets `selectedMappingId` to a `pending:<targetFieldId>` sentinel so the
  // mapped-field UI renders a unified shell without persisting anything yet.
  // The three commit triggers (Suggest / Generate / Test) route through
  // `ensureValueAssignmentOnce` to materialise the real TFM + transformations
  // row when the user shows real intent.
  const handleSelectUnmapped = useCallback(
    async (targetFieldId: string) => {
      if (autoSaveTimerRef.current) clearTimeout(autoSaveTimerRef.current)
      await flushAutoSave()

      setSelectedMappingId(`pending:${targetFieldId}`)
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
      setFieldSourceIssues([])
      isDirtyRef.current = false
      // Placeholder localTransform — transformationId stays null until a
      // commit trigger fires. Without this, the Textarea onChange update
      // (which uses `prev ? … : null`) would be a no-op.
      setLocalTransform({
        transformationId: null,
        description: '',
        sql: '',
        badge: 'none',
        status: 'draft',
      })
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    []
  )

  // ── Variant C commit trigger: ensure a VA TFM + transformations row ───────
  //
  // Single entry point for the three commit triggers (AI Suggest, Generate
  // SQL, Test Transform) when the current selection is a `pending:` sentinel.
  // Races handled:
  //   3A (multi-fire): an in-flight ref keyed on the pending id dedupes
  //      concurrent calls — all three triggers await the same promise.
  //   3B (buffered keystrokes): description from `localTransformRef.current`
  //      is captured AT CALL TIME, not from stale closure.
  //   3C (auto-save timing): `autoSaveTimerRef` is flushed before the
  //      commit so no stale sql/desc from a prior debounce lingers, and the
  //      commit always uses the freshly-typed values.
  //   3D (concurrent clicks): `useTransition`'s isPending flag on each
  //      trigger gates the button disable; plus the in-flight ref bucket.
  //
  // Returns { fieldMappingId, transformationId } on success, or null on
  // failure (a toast has already been shown).
  const ensureValueAssignmentOnce = useCallback(
    async (pendingSentinel: string): Promise<{ fieldMappingId: string; transformationId: string } | null> => {
      const targetFieldId = pendingSentinel.startsWith('pending:')
        ? pendingSentinel.slice('pending:'.length)
        : null
      if (!targetFieldId) return null

      const existing = vaCommitInFlightRef.current.get(pendingSentinel)
      if (existing) {
        const r = await existing
        if (r.success && r.fieldMappingId && r.transformationId) {
          return { fieldMappingId: r.fieldMappingId, transformationId: r.transformationId }
        }
        return null
      }

      const uf =
        data.unmappedNotNullTargetFields.find((f) => f.id === targetFieldId) ??
        data.unmappedNullableTargetFields.find((f) => f.id === targetFieldId)
      if (!uf) return null

      let tableMappingId: string | null = null
      for (const ds of data.datasets) {
        for (const t of ds.tables) {
          if (t.targetTableId === uf.table_id) {
            tableMappingId = t.tableMappingId
            break
          }
        }
        if (tableMappingId) break
      }
      if (!tableMappingId) {
        showToast('No table mapping found for this field.', 'error')
        return null
      }

      // Flush any pending auto-save (shouldn't fire for null transformationId,
      // but defensively clear the debounce timer so our captured snapshot
      // doesn't race with a later keystroke).
      if (autoSaveTimerRef.current) clearTimeout(autoSaveTimerRef.current)

      // Capture the freshest user-entered values AT CALL TIME — not from a
      // stale closure. Handles Race 3B (buffered keystrokes after trigger).
      const lt = localTransformRef.current
      const initialSql = lt?.sql ?? ''
      const initialDescription = lt?.description ?? ''

      const promise = ensureValueAssignment(
        projectId,
        tableMappingId,
        targetFieldId,
        initialSql,
        initialDescription,
      )
      vaCommitInFlightRef.current.set(pendingSentinel, promise)

      try {
        const result = await promise
        if (!result.success || !result.fieldMappingId || !result.transformationId) {
          showToast(result.error ?? 'Could not create value assignment', 'error')
          return null
        }

        const fmId = result.fieldMappingId
        const transformationId = result.transformationId

        // Promote the synthetic placeholder into a real mapped-field entry.
        // Mirrors the server-side routing in getTransformData — first TM
        // whose target_table matches — so the sidebar badge lands in the
        // same slot a page reload would produce.
        setData((prev) => {
          let routed = false
          const datasets = prev.datasets.map((ds) => ({
            ...ds,
            tables: ds.tables.map((tbl) => {
              if (routed) return tbl
              if (tbl.targetTableId !== uf.table_id) return tbl
              routed = true
              const without = tbl.fields.filter((f) => f.fieldMappingId !== fmId)
              const newItem: FieldItem = {
                fieldMappingId: fmId,
                sourceFieldId: null,
                sourceFieldName: null,
                sourceFieldDataType: null,
                sourceFieldInferredType: null,
                sourceFieldIsNullable: true,
                targetFieldId: uf.id,
                targetFieldName: uf.name,
                targetFieldDataType: uf.data_type,
                targetFieldInferredType: null,
                targetFieldIsNullable: uf.is_nullable,
                targetFieldIsPrimaryKey: uf.is_primary_key,
                sourceTableId: null,
                isValueAssignment: true,
                typeCompatibility: null,
                confidence: null,
                aiReasoning: null,
                nullPercentage: 0,
                formatIssuesCount: 0,
                sampleValues: [],
                cardinality: 0,
                needsTransform: true,
                transformation: {
                  id: transformationId,
                  target_field_mapping_id: fmId,
                  description: initialDescription || null,
                  generated_sql: initialSql,
                  is_ai_generated: false,
                  test_results: null,
                  status: 'draft',
                  created_at: new Date().toISOString(),
                },
                isContributing: false,
                contributingSourceFields: [],
                isCrossTable: false,
                vaDismissed: false,
                targetCheckConstraint: uf.check_constraint,
              }
              const merged = [...without, newItem]
              merged.sort((a, b) => {
                if (a.isValueAssignment && !b.isValueAssignment) return 1
                if (!a.isValueAssignment && b.isValueAssignment) return -1
                if (a.isValueAssignment && b.isValueAssignment) {
                  return a.targetFieldName.localeCompare(b.targetFieldName)
                }
                return 0
              })
              return { ...tbl, fields: merged }
            }),
          }))
          return {
            ...prev,
            datasets,
            unmappedNotNullTargetFields: prev.unmappedNotNullTargetFields.filter((f) => f.id !== uf.id),
            unmappedNullableTargetFields: prev.unmappedNullableTargetFields.filter((f) => f.id !== uf.id),
          }
        })

        // Carry the user's in-progress text into the real localTransform.
        // Functional setState so we don't stomp on a concurrent keystroke.
        setLocalTransform((prev) => ({
          transformationId,
          description: prev?.description ?? initialDescription,
          sql: prev?.sql ?? initialSql,
          badge: prev?.badge ?? 'none',
          status: 'draft',
        }))
        setSelectedMappingId(fmId)

        return { fieldMappingId: fmId, transformationId }
      } finally {
        vaCommitInFlightRef.current.delete(pendingSentinel)
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [projectId, data.datasets, data.unmappedNotNullTargetFields, data.unmappedNullableTargetFields]
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

  // ── VA Dismiss / Reinstate (migration 077) ───────────────────────────────
  //
  // Atomic create-or-find + flip. `dismissValueAssignment` accepts
  // `targetFieldId + tableMappingId` because the underlying TFM may not
  // exist yet for unmapped target fields (Variant C deferred-creation
  // pattern); the server action handles that internally via
  // `createValueAssignment`. `reinstateValueAssignment` only ever runs
  // against an existing TFM, so it takes a `fieldMappingId`.
  //
  // Optimistic UX: `refreshFieldVADismissed` patches the in-memory tree
  // before the server returns so the sidebar badge flips instantly. On
  // failure we revert via the same helper.
  async function handleVADismiss() {
    if (!selectedContext) return
    const { field, table } = selectedContext
    setShowVADismissConfirm(false)
    setIsVADismissing(true)
    try {
      const result = await dismissValueAssignment(
        projectId,
        field.targetFieldId,
        table.tableMappingId,
      )
      if (!result.success || !result.fieldMappingId) {
        showToast(result.error || 'Could not dismiss this field. Try again.', 'error')
        return
      }
      // The server may have just created the TFM (Variant C path) — swap
      // the pending sentinel for the real id so the editor stays glued.
      if (selectedMappingId?.startsWith('pending:')) {
        setSelectedMappingId(result.fieldMappingId)
      }
      refreshFieldVADismissed(result.fieldMappingId, true)
      showToast('Field marked as not needing a value', 'success')
    } catch {
      showToast('Could not dismiss this field. Try again.', 'error')
    } finally {
      setIsVADismissing(false)
    }
  }

  async function handleVAReinstate() {
    if (!selectedContext) return
    const fmId = selectedContext.field.fieldMappingId
    setIsVADismissing(true)
    try {
      const result = await reinstateValueAssignment(projectId, fmId)
      if (!result.success) {
        showToast(result.error || 'Could not reinstate this field. Try again.', 'error')
        return
      }
      refreshFieldVADismissed(fmId, false)
      showToast('Field reinstated — value generation required', 'success')
    } catch {
      showToast('Could not reinstate this field. Try again.', 'error')
    } finally {
      setIsVADismissing(false)
    }
  }

  // ── AI Suggest ────────────────────────────────────────────────────────────

  function handleSuggest() {
    if (!selectedMappingId) return
    const existing = localTransform?.description?.trim()
    // Pending VA commit trigger: materialise the TFM first so Suggest has
    // a real fmId to hang context off. After ensure, `selectedMappingId` has
    // been swapped to the real id, so we use the return value directly.
    const pendingSentinel = selectedMappingId.startsWith('pending:') ? selectedMappingId : null
    // If there's already content, confirm before replacing
    if (existing) {
      // We use startSuggesting to get the suggestion first, then show the dialog
      startSuggesting(async () => {
        let fmId: string = selectedMappingId
        if (pendingSentinel) {
          const ensured = await ensureValueAssignmentOnce(pendingSentinel)
          if (!ensured) return
          fmId = ensured.fieldMappingId
        }
        const result = await suggestTransformDescription(fmId)
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
      let fmId: string = selectedMappingId
      if (pendingSentinel) {
        const ensured = await ensureValueAssignmentOnce(pendingSentinel)
        if (!ensured) return
        fmId = ensured.fieldMappingId
      }
      const result = await suggestTransformDescription(fmId)
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
    const pendingSentinel = selectedMappingId.startsWith('pending:') ? selectedMappingId : null

    startGenerating(async () => {
      // Pending VA commit trigger: materialise the TFM first so
      // generateTransform has a real fmId to upsert against.
      let fmId: string = selectedMappingId
      if (pendingSentinel) {
        const ensured = await ensureValueAssignmentOnce(pendingSentinel)
        if (!ensured) return
        fmId = ensured.fieldMappingId
      }
      const result = await generateTransform(fmId, desc, existingSQL)
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
      refreshFieldTransformation(fmId, result.transformationId ?? null, result.sql!, 'ai', desc, 'draft')
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
    if (!selectedMappingId || !localTransform) return
    // When the selection is a pending sentinel, Test Transform is the
    // Variant C commit trigger for SQL mode: it ensures the VA TFM + its
    // transformations row exist (seeded with the user-typed SQL), then
    // proceeds. For already-materialised TFMs we keep the existing guard.
    const pendingSentinel = selectedMappingId.startsWith('pending:') ? selectedMappingId : null
    if (!pendingSentinel && !localTransform.transformationId) return
    if (!localTransform.sql?.trim()) { showToast('Enter a SQL expression first', 'error'); return }
    setTestResult(null)

    // Flush any pending auto-save first so the RPC uses the latest SQL
    if (autoSaveTimerRef.current) clearTimeout(autoSaveTimerRef.current)
    flushAutoSave()

    startTesting(async () => {
      let fmId: string = selectedMappingId
      if (pendingSentinel) {
        const ensured = await ensureValueAssignmentOnce(pendingSentinel)
        if (!ensured) return
        fmId = ensured.fieldMappingId
      }
      const res = await runFullTransformTest(fmId)
      if (!res.success || !res.result) {
        showToast(res.error ?? 'Test failed', 'error')
        return
      }
      setTestResult(res.result)
      if (res.result.failedRows === 0) {
        // All rows pass → update local status to tested
        setLocalTransform((prev) => prev ? { ...prev, status: 'tested' } : null)
        refreshFieldStatus(fmId, 'tested')
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

      // Invalidate the client-side Router Cache so sibling routes (notably
      // /data-overview → DataPreview) refetch on next navigation. The server
      // action already calls revalidatePath('layout') which clears the Full
      // Route Cache, but without this client-side refresh the back-forward
      // cache can serve the pre-apply DataPreview subtree — manifesting as
      // the "click Apply twice" bug confirmed on Heritage Core 2026-04-21.
      // Additive: existing in-memory patches (setLocalTransform /
      // refreshFieldStatus) still run so the Transform tab itself updates
      // instantly without waiting for the RSC payload.
      router.refresh()

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
    let result: { success: boolean; cascadedCount: number; cascadedTransforms?: Array<{ fieldMappingId: string; transformationId: string }>; error?: string }
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
        const cascaded = result.cascadedTransforms?.find((ct) => ct.fieldMappingId === fmId)
        refreshFieldTransformation(
          fmId,
          cascaded?.transformationId ?? null,
          pkSnapshot.pkTransformSQL,
          'ai',
          `Cascaded from ${pkSnapshot.pkTableName}.${pkSnapshot.pkFieldName}: ${localTransform?.description ?? ''}`,
          'applied'
        )
      }
      // Refresh staged preview if the currently selected field was one of the cascaded FK fields
      if (selectedMappingId && selectedFmIds.includes(selectedMappingId)) {
        getStagedPreviewForField(selectedMappingId).then((staged) => {
          if (staged.success && staged.rows) {
            setStagedPreview({ rows: staged.rows, totalRows: staged.totalRows ?? 0 })
            setShowStagedPreview(true)
          }
        }).catch(() => {})
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

  // Phase 3 — `data.datasets` (source-led) and `data.targetTableGroups`
  // (target-led) are independent server-built shapes that share the same
  // FieldItem semantics. Optimistic refreshes must patch BOTH so the
  // sidebar (which reads `targetTableGroups`) and the editor / lookup
  // helpers (which read `datasets`) stay in sync.
  //
  // `applyToFieldItem` walks every FieldItem under both shapes and
  // returns a new immutable tree with `mutate(f)` applied where
  // `match(f)` is true. Centralising the dual-walk avoids the previous
  // pattern of three near-identical setData updaters drifting from each
  // other.
  function applyToFieldItem(
    prev: TransformPageData,
    match: (f: FieldItem) => boolean,
    mutate: (f: FieldItem) => FieldItem,
  ): TransformPageData {
    return {
      ...prev,
      datasets: prev.datasets.map((ds) => ({
        ...ds,
        tables: ds.tables.map((tbl) => ({
          ...tbl,
          fields: tbl.fields.map((f) => (match(f) ? mutate(f) : f)),
        })),
      })),
      targetTableGroups: prev.targetTableGroups.map((g) => ({
        ...g,
        rows: g.rows.map((r) =>
          r.kind === 'mapping' && match(r.field)
            ? { kind: 'mapping' as const, field: mutate(r.field) }
            : r,
        ),
      })),
    }
  }

  function refreshFieldTransformation(
    fmId: string,
    transId: string | null,
    sql: string,
    badge: 'ai' | 'modified',
    description: string,
    status: LocalStatus
  ) {
    setData((prev) =>
      applyToFieldItem(
        prev,
        (f) => f.fieldMappingId === fmId,
        (f) => ({
          ...f,
          needsTransform: true,
          transformation: f.transformation
            ? { ...f.transformation, generated_sql: sql, is_ai_generated: badge === 'ai', description, status, test_results: null }
            : transId
            ? { id: transId, target_field_mapping_id: fmId, description, generated_sql: sql, is_ai_generated: badge === 'ai', test_results: null, status, created_at: new Date().toISOString() }
            : null,
        }),
      ),
    )
  }

  function refreshFieldStatus(fmId: string, status: LocalStatus) {
    setData((prev) =>
      applyToFieldItem(
        prev,
        (f) => f.fieldMappingId === fmId && !!f.transformation,
        (f) => ({ ...f, transformation: f.transformation ? { ...f.transformation, status } : f.transformation }),
      ),
    )
  }

  /** Patches the in-memory data tree after dismiss/reinstate so sidebar badge + counts update instantly. */
  function refreshFieldNeedsTransform(fmId: string, needsTransform: boolean) {
    setData((prev) =>
      applyToFieldItem(
        prev,
        (f) => f.fieldMappingId === fmId,
        (f) => ({ ...f, needsTransform }),
      ),
    )
  }

  /**
   * Migration 077 — patches the in-memory tree after VA dismiss /
   * reinstate so the sidebar badge ("Dismissed") and `needsTransform`
   * gate update instantly without a server round-trip.
   */
  function refreshFieldVADismissed(fmId: string, vaDismissed: boolean) {
    setData((prev) =>
      applyToFieldItem(
        prev,
        (f) => f.fieldMappingId === fmId,
        (f) => ({ ...f, vaDismissed, needsTransform: !vaDismissed }),
      ),
    )
  }

  // ── UI helpers ────────────────────────────────────────────────────────────

  // `pending:<targetFieldId>` sentinel — set by the sidebar click handler
  // for unmapped target fields. Under Variant C (C2) this drives the
  // mapped-field UI to render a placeholder state; the real TFM is created
  // only when the user hits one of the three commit triggers.
  const selectedUnmappedFieldId = selectedMappingId?.startsWith('pending:')
    ? selectedMappingId.slice('pending:'.length)
    : null

  const selectedContext = useMemo<
    { field: FieldItem; table: TableGroup; dataset: DatasetGroup } | null
  >(() => {
    if (!selectedMappingId) return null
    const found = findField(data.datasets, selectedMappingId)
    if (found) return found
    // Synthesise a placeholder context for a pending unmapped field so the
    // mapped-field UI can render a unified shell (Bug A fix). The synthetic
    // FieldItem uses the pending sentinel as its id — callers that compare
    // `selectedContext.field.fieldMappingId` get a stable key, and the
    // commit triggers swap the whole field tree over to the real TFM id
    // once `ensureValueAssignment` returns.
    if (!selectedUnmappedFieldId) return null
    const uf =
      data.unmappedNotNullTargetFields.find((f) => f.id === selectedUnmappedFieldId) ??
      data.unmappedNullableTargetFields.find((f) => f.id === selectedUnmappedFieldId)
    if (!uf) return null
    // Route to the first (dataset, table) pair whose targetTableId matches —
    // mirrors getTransformData's `firstTmByTargetTable` semantics.
    for (const ds of data.datasets) {
      for (const tbl of ds.tables) {
        if (tbl.targetTableId !== uf.table_id) continue
        const syntheticField: FieldItem = {
          fieldMappingId: selectedMappingId,
          sourceFieldId: null,
          sourceFieldName: null,
          sourceFieldDataType: null,
          sourceFieldInferredType: null,
          sourceFieldIsNullable: true,
          targetFieldId: uf.id,
          targetFieldName: uf.name,
          targetFieldDataType: uf.data_type,
          targetFieldInferredType: null,
          targetFieldIsNullable: uf.is_nullable,
          targetFieldIsPrimaryKey: uf.is_primary_key,
          sourceTableId: null,
          isValueAssignment: true,
          typeCompatibility: null,
          confidence: null,
          aiReasoning: null,
          nullPercentage: 0,
          formatIssuesCount: 0,
          sampleValues: [],
          cardinality: 0,
          needsTransform: true,
          transformation: null,
          isContributing: false,
          contributingSourceFields: [],
          isCrossTable: false,
          vaDismissed: false,
          targetCheckConstraint: uf.check_constraint,
        }
        return { field: syntheticField, table: tbl, dataset: ds }
      }
    }
    return null
  }, [data.datasets, data.unmappedNotNullTargetFields, data.unmappedNullableTargetFields, selectedMappingId, selectedUnmappedFieldId])

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
      <Badge className="bg-settle-slate-100 text-settle-slate-600 hover:bg-settle-slate-100 border border-gray-100">
        <CheckCircle2 className="w-3 h-3 mr-1" />Tested ✓
      </Badge>
    )
    if (localTransform.sql) return (
      <Badge className="bg-settle-slate-100 text-settle-slate-500 hover:bg-settle-slate-100 border border-gray-100">
        Untested
      </Badge>
    )
    return null
  }

  function sqlBadge() {
    if (!localTransform || localTransform.badge === 'none') return null
    if (localTransform.badge === 'ai') return (
      <Badge className="text-[10px] text-settle-blue-500 bg-blue-50 border border-blue-100 rounded px-1.5 py-0.5">
        AI-Generated
      </Badge>
    )
    return (
      <Badge className="text-[10px] text-settle-slate-500 bg-settle-slate-100 border border-gray-100 rounded px-1.5 py-0.5">
        Modified
      </Badge>
    )
  }

  // ── No mappings state ──────────────────────────────────────────────────────

  if (!data.hasMappings) {
    return (
      <div className="h-full bg-gray-50 flex flex-col overflow-hidden relative">
        <PageHeader projectName={projectName} title="Transform" subtitle="Define transformation logic for mapped fields" projectInfo={projectInfo} />
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
        projectInfo={projectInfo}
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

      {/*
        Pill counts come straight from the server-computed canonical scalars
        (`computeProjectStats` in lib/quality/stat-formulas.ts). The Projects
        List card and Migration Center read the same helper, so all three
        surfaces report identical numbers for a given project state. The
        client-side `filterCounts` / `inProgressCount` memos remain in scope
        below — they power the filter dropdown chips, NOT the pill display.
      */}
      <TransformStatPills
        totalCount={data.transformScope}
        appliedCount={data.transformApplied}
        inProgressCount={data.transformInProgress}
        toDefineCount={data.transformNeedsWork}
      />

      {/* ── Filter bar — flush border-b strip ── */}
      <div className="bg-white border-b border-gray-100 px-5 py-2.5 flex-shrink-0">
        <div className="flex items-center gap-3 min-w-0">

          {/* Tables filter */}
          <div className="flex items-center gap-2">
            <label className="text-xs font-medium text-settle-slate-500 whitespace-nowrap">Tables</label>
            <TableFieldFilter
              tables={filterTables}
              value={tableFieldSelection}
              onChange={handleTableSelectionChange}
              allLabel="All Tables"
            />
          </div>

          <div className="w-px h-4 bg-gray-100 flex-shrink-0" />

          {/* Status filter */}
          <div className="flex items-center gap-2">
            <label className="text-xs font-medium text-settle-slate-500 whitespace-nowrap">Status</label>
            <Select
              value={sidebarFilter}
              onValueChange={(val) => setSidebarFilter(val as typeof sidebarFilter)}
            >
              <SelectTrigger className="h-8 text-xs w-[130px]">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All</SelectItem>
                <SelectItem value="needs_transform">To Define</SelectItem>
                <SelectItem value="has_transform">Saved</SelectItem>
                <SelectItem value="applied">Applied</SelectItem>
                <SelectItem value="unmapped">Unmapped</SelectItem>
              </SelectContent>
            </Select>
          </div>

          <div className="w-px h-4 bg-gray-100 flex-shrink-0" />

          {/* Search */}
          <input
            type="text"
            placeholder="Search fields…"
            value={sidebarSearchQuery}
            onChange={(e) => setSidebarSearchQuery(e.target.value)}
            className="h-8 text-xs border border-settle-slate-200 rounded-md px-3 w-44 focus:outline-none focus:ring-1 focus:ring-settle-blue-500 text-settle-slate-700 placeholder:text-settle-slate-400"
          />

          {/* Right: reset */}
          <div className="ml-auto flex items-center gap-3 flex-shrink-0">
            {hasActiveTransformFilters && (
              <button
                onClick={resetTransformFilters}
                className="text-xs text-blue-600 hover:text-blue-800 hover:underline whitespace-nowrap"
              >
                Reset filters
              </button>
            )}
          </div>

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
        <div className="w-72 bg-white border-r border-gray-100 flex flex-col flex-shrink-0">
          <div className="flex-1 overflow-auto p-3 space-y-2">
            {data.targetTableGroups.length === 0 && filterCounts.unmapped === 0 ? (
              <p className="text-xs text-gray-500 text-center py-8">
                All fields are compatible — no transformations required.
              </p>
            ) : (
              data.targetTableGroups.map((g) => (
                <TargetTableNode
                  key={g.targetTableId}
                  group={g}
                  expanded={expandedTargetTables.has(g.targetTableId)}
                  selectedMappingId={selectedMappingId}
                  selectedUnmappedFieldId={selectedUnmappedFieldId}
                  filter={sidebarFilter}
                  searchQuery={sidebarSearchQuery}
                  selectedFieldIds={tableFieldSelection.selectedFieldIds}
                  onToggle={(id) => setExpandedTargetTables((prev) => {
                    const next = new Set(prev); next.has(id) ? next.delete(id) : next.add(id); return next
                  })}
                  onSelectField={handleSelectField}
                  onSelectUnmappedField={handleSelectUnmapped}
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
              <div className="bg-white border-b border-gray-100 px-6 py-3 flex items-center justify-between flex-shrink-0">
                <div className="flex items-center gap-2 flex-wrap min-w-0">
                  <span className="text-xs font-medium text-gray-500">
                    {selectedContext.field.isValueAssignment ? 'Value Assignment' : 'Transform'}
                  </span>
                  <span className="text-[10px] text-settle-slate-300">·</span>
                  {selectedContext.field.isValueAssignment ? (
                    <>
                      {/* VA breadcrumb is unchanged — there is no source to
                          invert. Format: target_field TYPE [NOT NULL] · table */}
                      <span className="text-xs font-medium text-settle-slate-900 font-mono">{selectedContext.field.targetFieldName}</span>
                      <span className="text-[10px] text-settle-slate-400">{selectedContext.field.targetFieldDataType}</span>
                      {!selectedContext.field.targetFieldIsNullable && (
                        <span className="text-[10px] text-amber-600">NOT NULL</span>
                      )}
                    </>
                  ) : (
                    /* Phase 3 redesign — breadcrumb leads with target, then
                        ← source(s). Multi-source truncates at 3+ sources;
                        the title attribute carries the full list for hover.
                        Unicode `←` (U+2190) keeps the breadcrumb visually
                        consistent with the trailing `→` glyph in
                        `· View Mapping →` below. The sidebar uses a Lucide
                        CornerLeftUp icon at smaller sizes (see FieldRow). */
                    (() => {
                      const sourceList = formatSourceList(selectedContext.field)
                      return (
                        <>
                          <span className="text-xs font-medium text-settle-slate-900 font-mono">
                            {selectedContext.field.targetFieldName}
                          </span>
                          <span className="text-settle-slate-400 text-xs leading-none" aria-hidden="true">←</span>
                          <span
                            className="text-xs font-medium text-settle-slate-900 font-mono"
                            title={sourceList.truncated ? `Sources: ${sourceList.full}` : undefined}
                          >
                            {sourceList.display}
                          </span>
                        </>
                      )
                    })()
                  )}
                  <button
                    onClick={() => router.push(`/app/projects/${projectId}/mapping?targetFieldMappingId=${selectedMappingId}`)}
                    className="text-[10px] text-settle-blue-500 hover:text-settle-blue-700 transition-colors"
                  >
                    · View Mapping →
                  </button>
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
                  {!selectedContext.field.isValueAssignment && !selectedContext.field.transformation && (
                    <label className="flex items-center gap-1.5 cursor-pointer select-none">
                      <span className="text-xs text-gray-400">Transform</span>
                      <button
                        role="switch"
                        aria-checked={selectedContext.field.needsTransform}
                        disabled={isDismissing || !canEdit}
                        onClick={async () => {
                          const fmId = selectedContext.field.fieldMappingId
                          const currentlyNeeds = selectedContext.field.needsTransform
                          setIsDismissing(true)
                          try {
                            const result = currentlyNeeds
                              ? await dismissTransformNeeded(projectId, fmId)
                              : await reinstateTransformNeeded(projectId, fmId)
                            if (!result.success) {
                              showToast(result.error || 'Could not update. Try again.', 'error')
                            } else {
                              refreshFieldNeedsTransform(fmId, !currentlyNeeds)
                            }
                          } catch {
                            showToast('Could not update. Try again.', 'error')
                          } finally {
                            setIsDismissing(false)
                          }
                        }}
                        className={`relative inline-flex h-4 w-7 items-center rounded-full transition-colors duration-150 disabled:opacity-50 ${
                          selectedContext.field.needsTransform ? 'bg-primary' : 'bg-gray-200'
                        }`}
                      >
                        <span
                          className={`inline-block h-3 w-3 rounded-full bg-white transition-transform duration-150 shadow-sm ${
                            selectedContext.field.needsTransform ? 'translate-x-3.5' : 'translate-x-0.5'
                          }`}
                        />
                      </button>
                    </label>
                  )}
                </div>
              </div>

              {/* Single-column editor — flex column so the action bar pins to bottom */}
              <div className="flex-1 flex flex-col min-h-0">
                <div className="flex-1 overflow-auto p-5 space-y-4">

                  {selectedContext.field.needsTransform ? (
                    <>
                  {/* NL Description / Direct SQL — first interactive element */}
                  <div className="bg-white rounded-lg border border-gray-100 p-4">
                    {/* Header row: label + mode toggle */}
                    <div className="flex items-center justify-between mb-2">
                      <label className="text-sm font-medium text-gray-900">
                        {inputMode === 'sql'
                          ? 'Write SQL expression directly'
                          : selectedContext.field.isValueAssignment
                          ? 'Describe the value this field should receive'
                          : 'Describe how this field should be transformed'}
                      </label>
                      <div className="flex rounded-lg border border-gray-100 overflow-hidden flex-shrink-0 ml-3">
                        <button
                          onClick={() => setInputMode('ai')}
                          className={`px-2.5 py-1 text-xs font-medium transition-colors ${
                            inputMode === 'ai'
                              ? 'bg-primary text-white'
                              : 'bg-white text-settle-slate-500 hover:text-settle-slate-700'
                          }`}
                        >
                          AI-Assisted
                        </button>
                        <button
                          onClick={() => {
                            setInputMode('sql')
                            if (localTransform?.sql) setSqlExpanded(true)
                          }}
                          className={`px-2.5 py-1 text-xs font-medium border-l border-gray-100 transition-colors ${
                            inputMode === 'sql'
                              ? 'bg-primary text-white'
                              : 'bg-white text-settle-slate-500 hover:text-settle-slate-700'
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
                          {/*
                           * Migration 077 — VA dismissal affordance. Visible
                           * only for value-assignment fields that have not
                           * yet been dismissed AND have no transformation row
                           * (no saved value). Clicking opens the AlertDialog
                           * confirm; the actual server call fires from
                           * `handleVADismiss`. Symmetric to
                           * `dismissTransformNeeded` for mapped fields, but
                           * uses a confirm dialog rather than the inline
                           * toggle to make the consequence ("field will not
                           * receive a value during migration") deliberate.
                           */}
                          {canEdit
                            && selectedContext.field.isValueAssignment
                            && !selectedContext.field.vaDismissed
                            && selectedContext.field.transformation === null && (
                            <button
                              type="button"
                              data-testid="va-dismiss-link"
                              className="text-sm text-settle-slate-500 hover:text-settle-slate-700 underline-offset-2 hover:underline disabled:opacity-50"
                              onClick={() => setShowVADismissConfirm(true)}
                              disabled={isVADismissing}
                              title="Mark this field as not needing a value (e.g., DB default, auto-generated, intentional NULL)"
                            >
                              {isVADismissing ? 'Dismissing…' : 'Dismiss'}
                            </button>
                          )}
                        </div>
                      </>
                    ) : (
                      <>
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
                  {selectedContext.field.aiReasoning && (
                    <div className="rounded-lg border border-gray-100 bg-white overflow-hidden">
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
                    </>
                  ) : selectedContext.field.isValueAssignment && selectedContext.field.vaDismissed ? (
                    /*
                     * Migration 077 — dismissed VA placeholder. Replaces the
                     * generic "Mapped directly…" copy because dismissed VAs
                     * have a specific opt-in semantic that the user should
                     * be able to reverse. The Reinstate button mirrors the
                     * action affordance of the active VA `Dismiss` link.
                     */
                    <div
                      data-testid="va-dismissed-banner"
                      className="rounded-lg border border-settle-slate-200 bg-settle-slate-50 px-4 py-3 flex items-start gap-3"
                    >
                      <div className="flex-1 min-w-0">
                        <p className="text-sm font-medium text-settle-slate-900">
                          This field has been marked as not needing a value
                        </p>
                        <p className="text-xs text-settle-slate-500 mt-1">
                          It will be omitted from the migration load SQL. Reinstate to require a value.
                        </p>
                      </div>
                      {canEdit && (
                        <button
                          type="button"
                          data-testid="va-reinstate-button"
                          className="text-sm font-medium text-settle-blue-500 hover:text-settle-blue-700 underline-offset-2 hover:underline disabled:opacity-50 flex-shrink-0"
                          onClick={handleVAReinstate}
                          disabled={isVADismissing}
                        >
                          {isVADismissing ? 'Reinstating…' : 'Reinstate'}
                        </button>
                      )}
                    </div>
                  ) : (
                    <p className="text-sm text-gray-400 py-3">
                      Mapped directly without transformation.
                    </p>
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
                <div className="bg-white rounded-lg border border-gray-100">
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
              <div className="border border-gray-100 rounded-lg overflow-hidden bg-white">
                <div className="flex items-center justify-between px-4 py-3 bg-white border-b border-gray-100">
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
                      <div className="flex items-center gap-1 bg-white border border-gray-100 rounded-md p-0.5">
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
                  <div className="flex-shrink-0 z-10 border-t border-gray-100 bg-white px-4 py-3 flex items-center gap-3 shadow-[0_-2px_8px_rgba(0,0,0,0.06)]">
                    {/* Test Transform — also the Variant C SQL-mode commit
                        trigger: when the selection is a `pending:` sentinel,
                        handleTest routes through ensureValueAssignmentOnce
                        to materialise the VA TFM with the user's SQL, then
                        runs the full test. Disabled only while a test is
                        in-flight; the outer {localTransform?.sql && … } guard
                        on the action bar ensures SQL is present before the
                        button renders. */}
                    <RoleTooltip allowed={canEdit} requiredRole="Editor">
                      <Button
                        variant="outline"
                        className="gap-2 border-gray-300 text-gray-700 hover:border-blue-400 hover:text-blue-700 hover:bg-blue-50"
                        onClick={handleTest}
                        disabled={isTesting || !canEdit}
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
                    {/* Apply Transform — only enabled after successful test.
                        For pending-sentinel selections, transformationId is
                        null so the tooltip surfaces "Run Test Transform
                        first" (which doubles as the commit trigger). */}
                    <RoleTooltip allowed={canEdit} requiredRole="Editor">
                      <Button
                        className="bg-primary hover:bg-primary/90 text-white gap-2 px-6 disabled:opacity-50 disabled:cursor-not-allowed"
                        onClick={handleApply}
                        disabled={isApplying || isCheckingIssues || !localTransform?.transformationId || localTransform.status !== 'tested' || !canEdit}
                        title={
                          !localTransform?.transformationId
                            ? 'Run "Test Transform" first to commit this value'
                            : localTransform.status !== 'tested'
                            ? 'Run "Test Transform" first'
                            : undefined
                        }
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
          <div className="border-t border-gray-100 bg-white px-6 py-3 flex items-center justify-between flex-shrink-0">
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

      {/*
        Migration 077 — VA dismissal confirmation. Mirrors the Revert
        dialog pattern below; AlertDialog (rather than the polish-3
        bespoke popover) is the right primitive here because the trigger
        sits in the editor's full-width action bar, not inside a tight
        inline row, so a centered modal is clearer than an anchored
        popover. Locked copy:
          Title:  "Mark this field as not needing a value?"
          Body:   explains the load-SQL consequence
          Buttons: Cancel + Dismiss
        The Dismiss button is destructive-styled (slate, not red) — the
        action is reversible via Reinstate, so red would over-signal
        permanence.
      */}
      <AlertDialog open={showVADismissConfirm} onOpenChange={setShowVADismissConfirm}>
        <AlertDialogContent data-testid="va-dismiss-confirm-dialog">
          <AlertDialogHeader>
            <AlertDialogTitle>Mark this field as not needing a value?</AlertDialogTitle>
            <AlertDialogDescription>
              This field will not receive a value during migration. Use this for fields with database defaults, auto-generated values, or fields intentionally left null. You can reinstate it later if needed.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              data-testid="va-dismiss-confirm-button"
              onClick={handleVADismiss}
              className="bg-settle-slate-700 hover:bg-settle-slate-800 text-white focus-visible:ring-settle-slate-700"
            >
              Dismiss
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

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

// ─────────────────────────────────────────────────────────────────────────────
// Phase 3 redesign — target-led sidebar (replaces DatasetNode + TableNode).
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Comma-separated source list for a multi-source mapping. Truncates to
 * `{primary}, {first contributor}, +N` when there are 3 or more sources;
 * the caller can use `full` for a `title` tooltip showing the un-truncated
 * list. Single-source returns the source name verbatim with no truncation.
 */
function formatSourceList(field: FieldItem): {
  display: string
  full: string
  truncated: boolean
} {
  if (field.isValueAssignment) {
    return { display: '', full: '', truncated: false }
  }
  const all = [
    field.sourceFieldName ?? '',
    ...field.contributingSourceFields.map((f) => f.name),
  ].filter(Boolean)
  const full = all.join(', ')
  if (all.length <= 2) {
    return { display: full, full, truncated: false }
  }
  // 3+ — show first two, then `+N` for the rest.
  const visible = all.slice(0, 2).join(', ')
  const overflow = all.length - 2
  return { display: `${visible}, +${overflow}`, full, truncated: true }
}

/**
 * Sidebar status descriptor for a TFM. Five states (mapped) plus a sixth
 * for dismissed VAs (migration 077). The status dot and text badge derive
 * from the same `kind`; the editor uses the `label` directly and the dot
 * uses the `dotClass`.
 *
 *   applied        — transformation.status === 'applied'
 *   stale          — transformation.status === 'stale'
 *   saved          — transformation row exists, status not above
 *   needs_transform — needsTransform === true (no transformation yet)
 *   dismissed      — vaDismissed === true (VA only, migration 077)
 *   none           — default / passthrough
 */
type RowStatus =
  | { kind: 'applied'; label: 'Applied'; dotClass: string; textClass: string }
  | { kind: 'stale'; label: 'Stale ⚠'; dotClass: string; textClass: string }
  | { kind: 'saved'; label: 'Saved'; dotClass: string; textClass: string }
  | { kind: 'needs_transform'; label: 'Define'; dotClass: string; textClass: string }
  | { kind: 'dismissed'; label: 'Dismissed'; dotClass: string; textClass: string }
  | { kind: 'none'; label: ''; dotClass: string; textClass: string }

function deriveRowStatus(field: FieldItem): RowStatus {
  const status = field.transformation?.status
  if (status === 'applied') {
    return { kind: 'applied', label: 'Applied', dotClass: 'bg-green-500', textClass: 'text-green-600' }
  }
  if (status === 'stale') {
    return { kind: 'stale', label: 'Stale ⚠', dotClass: 'bg-amber-400', textClass: 'text-amber-600' }
  }
  if (field.transformation !== null) {
    return { kind: 'saved', label: 'Saved', dotClass: 'bg-amber-400', textClass: 'text-settle-slate-500' }
  }
  if (field.isValueAssignment && field.vaDismissed) {
    return { kind: 'dismissed', label: 'Dismissed', dotClass: 'bg-settle-slate-300', textClass: 'text-settle-slate-500' }
  }
  if (field.needsTransform) {
    return { kind: 'needs_transform', label: 'Define', dotClass: 'bg-amber-400', textClass: 'text-amber-600' }
  }
  return { kind: 'none', label: '', dotClass: 'bg-settle-slate-300', textClass: 'text-settle-slate-400' }
}

// ── TargetTableNode ──────────────────────────────────────────────────────────

function TargetTableNode({
  group, expanded, selectedMappingId, selectedUnmappedFieldId,
  filter, searchQuery, selectedFieldIds,
  onToggle, onSelectField, onSelectUnmappedField,
}: {
  group: TargetTableGroup
  expanded: boolean
  selectedMappingId: string | null
  selectedUnmappedFieldId: string | null
  filter: TransformFilter
  searchQuery: string
  selectedFieldIds: Set<string> | null
  onToggle: (targetTableId: string) => void
  onSelectField: (id: string) => void
  onSelectUnmappedField: (id: string) => void
}) {
  // Apply filter + search to the pre-sorted (DDL-ordered, server-side) row
  // list. Filtering keeps the array order; we never re-sort on the client.
  const visibleRows: TargetTableRow[] = []
  for (const row of group.rows) {
    if (row.kind === 'mapping') {
      const f = row.field

      if (
        selectedFieldIds !== null &&
        selectedFieldIds.size > 0 &&
        !selectedFieldIds.has(f.fieldMappingId)
      ) {
        continue
      }

      // Status filter — `unmapped` excludes mapped rows entirely.
      let passesStatus: boolean
      switch (filter) {
        case 'needs_transform': passesStatus = f.needsTransform; break
        case 'has_transform': passesStatus = f.transformation !== null; break
        case 'applied': passesStatus = f.transformation?.status === 'applied'; break
        case 'unmapped': passesStatus = false; break
        default: passesStatus = true
      }
      if (!passesStatus) continue

      // Search — target field name OR any source field name (multi-source aware).
      if (searchQuery.trim()) {
        const q = searchQuery.toLowerCase()
        const matchesTarget = f.targetFieldName.toLowerCase().includes(q)
        const matchesPrimarySource = (f.sourceFieldName ?? '').toLowerCase().includes(q)
        const matchesContributor = f.contributingSourceFields.some((c) =>
          c.name.toLowerCase().includes(q),
        )
        if (!matchesTarget && !matchesPrimarySource && !matchesContributor) continue
      }
      visibleRows.push(row)
    } else {
      // Truly-unmapped target field (no TFM yet). Surfaced under the same
      // filter rules the legacy sidebar used: visible in `all`, `unmapped`,
      // and `needs_transform`.
      const showUnmapped =
        filter === 'all' || filter === 'unmapped' || filter === 'needs_transform'
      if (!showUnmapped) continue

      const f = row.field
      if (searchQuery.trim()) {
        const q = searchQuery.toLowerCase()
        if (!f.name.toLowerCase().includes(q) && !f.table_name.toLowerCase().includes(q)) {
          continue
        }
      }
      visibleRows.push(row)
    }
  }

  if (visibleRows.length === 0) return null

  return (
    <div className="border border-settle-slate-100 rounded-lg overflow-hidden">
      <button
        onClick={() => onToggle(group.targetTableId)}
        className="w-full flex items-center justify-between gap-2 px-3 py-2 bg-white hover:bg-settle-slate-50 transition-colors"
      >
        <div className="flex items-center gap-2 min-w-0">
          {expanded
            ? <ChevronDown className="w-3 h-3 text-settle-slate-400 flex-shrink-0" />
            : <ChevronRight className="w-3 h-3 text-settle-slate-400 flex-shrink-0" />
          }
          <span className="text-[11px] font-mono font-medium text-settle-slate-900 truncate" title={group.targetTableName}>
            {group.targetTableName}
          </span>
        </div>
        <span className="text-[10px] text-settle-slate-400 flex-shrink-0">
          [{visibleRows.length}]
        </span>
      </button>
      {expanded && (
        <div className="bg-gray-50 border-t border-settle-slate-100">
          {visibleRows.map((row) => {
            if (row.kind === 'mapping') {
              return (
                <FieldRow
                  key={row.field.fieldMappingId}
                  field={row.field}
                  isSelected={selectedMappingId === row.field.fieldMappingId}
                  onSelect={() => onSelectField(row.field.fieldMappingId)}
                />
              )
            }
            return (
              <UnmappedFieldRow
                key={row.field.id}
                field={row.field}
                isSelected={selectedUnmappedFieldId === row.field.id}
                onSelect={() => onSelectUnmappedField(row.field.id)}
              />
            )
          })}
        </div>
      )}
    </div>
  )
}

// ── FieldRow (target-primary, two-line) ──────────────────────────────────────

function FieldRow({ field, isSelected, onSelect }: {
  field: FieldItem
  isSelected: boolean
  onSelect: () => void
}) {
  const isVA = field.isValueAssignment
  const status = deriveRowStatus(field)
  const sourceList = formatSourceList(field)

  return (
    <button
      onClick={onSelect}
      className={`w-full px-3 py-2 text-left transition-colors border-b border-settle-slate-50 flex items-start gap-2 ${
        isSelected
          ? 'bg-blue-50 border-l-2 border-l-settle-blue-500'
          : 'hover:bg-settle-slate-50'
      }`}
    >
      <span className={`w-1.5 h-1.5 rounded-full flex-shrink-0 mt-1.5 ${status.dotClass}`} />

      <div className="flex-1 min-w-0">
        <div className="flex items-center justify-between gap-1 mb-0.5">
          <span
            className="text-[11px] font-medium text-settle-slate-900 font-mono truncate"
            title={field.targetFieldName}
          >
            {field.targetFieldName}
          </span>
          <span className={`text-[10px] flex-shrink-0 ${status.textClass}`}>
            {status.label}
          </span>
        </div>
        <div className="flex items-center gap-1 min-w-0">
          {isVA ? (
            <span className="text-[10px] text-settle-slate-400 font-mono truncate">
              No source mapped
            </span>
          ) : (
            <>
              <CornerLeftUp
                data-testid="sidebar-source-arrow"
                className="w-2.5 h-2.5 text-settle-slate-400 flex-shrink-0"
                aria-hidden="true"
              />
              <span
                className="text-[10px] text-settle-slate-400 font-mono truncate"
                title={sourceList.truncated ? `Sources: ${sourceList.full}` : sourceList.full}
              >
                {sourceList.display}
              </span>
            </>
          )}
        </div>
      </div>
    </button>
  )
}

// ── UnmappedFieldRow (target field with no TFM yet) ──────────────────────────

function UnmappedFieldRow({ field, isSelected, onSelect }: {
  field: UnmappedTargetField
  isSelected: boolean
  onSelect: () => void
}) {
  const isRequired = !field.is_nullable
  return (
    <button
      onClick={onSelect}
      className={`w-full px-3 py-2 text-left transition-colors border-b border-settle-slate-50 flex items-start gap-2 ${
        isSelected
          ? 'bg-blue-50 border-l-2 border-l-settle-blue-500'
          : 'hover:bg-settle-slate-50'
      }`}
    >
      <span className={`w-1.5 h-1.5 rounded-full flex-shrink-0 mt-1.5 ${
        isRequired ? 'bg-amber-400' : 'bg-settle-slate-300'
      }`} />
      <div className="flex-1 min-w-0">
        <div className="flex items-center justify-between gap-1 mb-0.5">
          <span
            className="text-[11px] font-medium text-settle-slate-900 font-mono truncate"
            title={field.name}
          >
            {field.name}
          </span>
          <span className={`text-[10px] flex-shrink-0 ${
            isRequired ? 'text-amber-600' : 'text-settle-slate-400'
          }`}>
            {isRequired ? 'Define' : ''}
          </span>
        </div>
        <div className="flex items-center gap-1">
          <span className="text-[10px] text-settle-slate-400 font-mono truncate">
            No source mapped
          </span>
        </div>
      </div>
    </button>
  )
}
