'use client'

import { useState, useEffect, useTransition, useRef, useMemo } from 'react'
import { useRouter } from 'next/navigation'
import type { QualityIssue, FixOption, ReadinessScore, ValidationRule, FixHistory } from '@/lib/types/database'
import { applyFix, acceptRisk, revertFix, runFullScan, getQualityIssues, getFixHistory, markIssueFixed, getAffectedRowsForIssue } from '@/lib/actions/quality-fixes'
import { generateFixSuggestions } from '@/lib/quality/fix-engine'
import { addValidationRule, addValidationRuleFromNL, executeCustomRules, deleteValidationRule } from '@/lib/actions/validation-rules'
import { generateManualFix, applyManualFix, previewManualFix } from '@/lib/actions/manual-fix'
import { computeReadinessScore } from '@/lib/quality/readiness-score'
import { CheckCircle, ChevronRight, ExternalLink } from '@/components/icons'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { PageHeader } from '@/components/app/PageHeader'
import { stageAllData } from '@/lib/actions/staging'
import { getVerifiedFixes } from '@/lib/quality/fix-reconciliation'
import type { VerifiedFix } from '@/lib/quality/fix-reconciliation'
import { useProjectRole } from '@/lib/hooks/useProjectRole'
import { RoleTooltip } from '@/components/app/RoleTooltip'

// ── Types ─────────────────────────────────────────────────────────────────────

interface FieldStub {
  id: string
  name: string
  data_type: string
  inferred_type: string | null
}
interface TableStub {
  id: string
  name: string
  fields: FieldStub[]
}
interface DatasetStub {
  id: string
  role: string
  name: string
  tables: TableStub[]
}

interface Props {
  projectId: string
  projectName: string
  initialIssues: QualityIssue[]
  initialReadiness: ReadinessScore
  initialRules: ValidationRule[]
  hasMappings: boolean
  allDatasets: DatasetStub[]
  /** Fix history pre-fetched server-side to avoid N+1 per IssueCard */
  initialFixHistory?: FixHistory[]
  /**
   * Source field IDs that have an approved mapping with a saved transform
   * (or needs_transformation = false). Used to compute "Resolved by Transform" state.
   */
  resolvedSourceFieldIds?: string[]
  /** Pre-set filter values from URL search params (deep-links from Transform/staging warning popup) */
  initialFilterTableId?: string
  initialFilterFieldId?: string
  initialFilterSeverity?: string
  initialFilterStatus?: string
  initialFilterStage?: string
  isArchived?: boolean
}

// ── Small helpers ─────────────────────────────────────────────────────────────

function severityColor(s: string) {
  return s === 'blocking' ? 'text-red-600' : 'text-amber-600'
}
function riskColor(r: string) {
  if (r === 'low') return 'bg-green-100 text-green-800'
  if (r === 'medium') return 'bg-amber-100 text-amber-800'
  return 'bg-red-100 text-red-800'
}

// ── SQL Modal ─────────────────────────────────────────────────────────────────

function SQLModal({ sql, onClose }: { sql: string; onClose: () => void }) {
  const [copied, setCopied] = useState(false)
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
      <div className="bg-white rounded-xl shadow-2xl w-full max-w-2xl">
        <div className="flex items-center justify-between p-4 border-b">
          <h3 className="font-semibold text-gray-900">Fix SQL</h3>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600 text-xl">×</button>
        </div>
        <div className="p-4">
          <pre className="bg-gray-950 text-green-300 rounded-lg p-4 text-sm overflow-x-auto whitespace-pre-wrap font-mono max-h-80">
            {sql}
          </pre>
          <p className="text-xs text-gray-500 mt-2 italic">
            This SQL modifies staging data only. All changes are logged and revertable.
          </p>
        </div>
        <div className="flex gap-2 p-4 border-t">
          <button
            onClick={() => { navigator.clipboard.writeText(sql); setCopied(true); setTimeout(() => setCopied(false), 2000) }}
            className="px-4 py-2 text-sm bg-blue-600 text-white rounded-lg hover:bg-blue-700"
          >
            {copied ? '✓ Copied' : 'Copy SQL'}
          </button>
          <button onClick={onClose} className="px-4 py-2 text-sm border border-gray-300 rounded-lg hover:bg-gray-50">Close</button>
        </div>
      </div>
    </div>
  )
}

// ── Confirm Modal ─────────────────────────────────────────────────────────────

function ConfirmModal({
  title, message, confirmLabel = 'Confirm', onConfirm, onCancel, loading
}: { title: string; message: string; confirmLabel?: string; onConfirm: () => void; onCancel: () => void; loading?: boolean }) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
      <div className="bg-white rounded-xl shadow-2xl w-full max-w-md p-6">
        <h3 className="font-semibold text-gray-900 mb-2">{title}</h3>
        <p className="text-sm text-gray-600 mb-6">{message}</p>
        <div className="flex gap-3 justify-end">
          <button onClick={onCancel} disabled={loading} className="px-4 py-2 text-sm font-medium text-gray-700 bg-white border border-gray-300 rounded-lg hover:bg-gray-50 transition-colors disabled:opacity-50">
            Cancel
          </button>
          <button onClick={onConfirm} disabled={loading}
            className="px-4 py-2 text-sm bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:opacity-50 flex items-center gap-2">
            {loading && <span className="w-3.5 h-3.5 border-2 border-white/30 border-t-white rounded-full animate-spin" />}
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  )
}

// ── Inline RotateCcw icon (no external dep needed) ───────────────────────────

function RotateCcwIcon({ className }: { className?: string }) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
    >
      <path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" />
      <path d="M3 3v5h5" />
    </svg>
  )
}

// ── Issue Card helpers ────────────────────────────────────────────────────────

function buildDiagnosticQuery(issue: {
  field_name: string
  issue_kind: string | null
  tableName: string
}): string | null {
  const { tableName, field_name: field, issue_kind } = issue
  if (!tableName || !field) return null
  switch (issue_kind) {
    case 'null_pk':
    case 'null_required':
    case 'high_null_rate':
      return `SELECT * FROM ${tableName} WHERE "${field}" IS NULL OR TRIM("${field}") = ''`
    case 'duplicate_pk':
      return `SELECT "${field}", COUNT(*) AS count FROM ${tableName} GROUP BY "${field}" HAVING COUNT(*) > 1 ORDER BY count DESC`
    case 'orphaned_fk':
      return `SELECT * FROM ${tableName} WHERE "${field}" IS NOT NULL AND TRIM("${field}") <> '' LIMIT 50`
    case 'currency_format':
      return `SELECT "${field}" FROM ${tableName} WHERE "${field}" LIKE '%$%' OR "${field}" LIKE '%,%' LIMIT 50`
    case 'email_format':
      return `SELECT "${field}" FROM ${tableName} WHERE "${field}" IS NOT NULL AND "${field}" NOT LIKE '%@%.%' LIMIT 50`
    case 'phone_format':
      return `SELECT "${field}" FROM ${tableName} WHERE "${field}" IS NOT NULL LIMIT 50`
    case 'type_mismatch_integer':
    case 'type_mismatch_numeric':
      return `SELECT "${field}" FROM ${tableName} WHERE "${field}" IS NOT NULL ORDER BY "${field}" LIMIT 50`
    case 'negative_value':
      return `SELECT "${field}" FROM ${tableName} WHERE "${field}" LIKE '-%' OR "${field}" LIKE '(%' LIMIT 50`
    case 'non_iso_date':
    case 'invalid_date_string':
      return `SELECT "${field}" FROM ${tableName} WHERE "${field}" IS NOT NULL LIMIT 50`
    default:
      return `SELECT * FROM ${tableName} WHERE "${field}" IS NOT NULL LIMIT 50`
  }
}

// ── Issue Card ────────────────────────────────────────────────────────────────

// RoleTooltip is imported from @/components/app/RoleTooltip

function IssueCard({
  issue,
  onUpdate,
  prefetchedFixHistory,
  isArchived = false,
  canEdit = true,
}: {
  issue: QualityIssue
  onUpdate: (updated: QualityIssue) => void
  prefetchedFixHistory?: FixHistory[]
  isArchived?: boolean
  canEdit?: boolean
}) {
  const [generatingFix, startGenerating] = useTransition()
  const [applyingIdx, setApplyingIdx] = useState<number | null>(null)
  const [reverting, setReverting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [toast, setToast] = useState<{ message: string; variant: 'success' | 'error' } | null>(null)
  const [showSQL, setShowSQL] = useState<string | null>(null)
  const [confirmApply, setConfirmApply] = useState<{ idx: number; fix: FixOption } | null>(null)
  const [confirmNoSnapshot, setConfirmNoSnapshot] = useState<number | null>(null)
  const [acceptingRisk, setAcceptingRisk] = useState(false)
  const [riskReason, setRiskReason] = useState('')
  const [showAcceptModal, setShowAcceptModal] = useState(false)
  const [showCustomFix, setShowCustomFix] = useState(false)
  // When prefetchedFixHistory is provided (server-prefetched), derive fixDetails directly.
  // Otherwise fall back to a client-side fetch to stay backward-compatible.
  const [fetchedFixDetails, setFetchedFixDetails] = useState<FixHistory | null>(null)

  // ── Affected rows preview ────────────────────────────────────────────────
  const [showSample, setShowSample] = useState(false)
  const [extraRows, setExtraRows] = useState<Record<string, unknown>[] | null>(null)
  const [loadingMore, setLoadingMore] = useState(false)

  const router = useRouter()

  const sampleRows = (issue.affected_rows_sample as Record<string, unknown>[] | null) ?? []
  const displayRows = extraRows ?? sampleRows

  const titleParts = issue.title?.split('.') ?? []
  const fieldName = titleParts.length >= 2 ? titleParts[titleParts.length - 1] : ''
  const tableName = titleParts.length >= 2 ? titleParts[0] : ''

  const sampleColumns = useMemo(() => {
    if (displayRows.length === 0) return []
    const allCols = Object.keys(displayRows[0])
    const sorted = allCols.filter(c => c === fieldName).concat(allCols.filter(c => c !== fieldName))
    return sorted.slice(0, 6)
  }, [displayRows, fieldName])

  const diagnosticQuery = useMemo(() => {
    const tbl = issue.title?.split('.')[0] ?? ''
    const fld = issue.title?.split('.').pop() ?? ''

    // Try the typed builder first
    if (issue.issue_kind && tbl && fld) {
      return buildDiagnosticQuery({ table_id: issue.table_id ?? '', field_name: fld, issue_kind: issue.issue_kind, tableName: tbl })
    }

    // Fallback: derive query from title/description when issue_kind is missing
    if (tbl && fld) {
      const desc = (issue.description ?? '').toLowerCase()
      if (desc.includes('null') || desc.includes('empty')) {
        return `SELECT * FROM ${tbl} WHERE "${fld}" IS NULL OR TRIM("${fld}") = ''`
      }
      if (desc.includes('orphan') || desc.includes('referential')) {
        return `SELECT * FROM ${tbl} WHERE "${fld}" IS NOT NULL LIMIT 50`
      }
      if (desc.includes('duplicate')) {
        return `SELECT "${fld}", COUNT(*) AS count FROM ${tbl} GROUP BY "${fld}" HAVING COUNT(*) > 1`
      }
      return `SELECT * FROM ${tbl} LIMIT 50`
    }

    return null
  }, [issue])

  const handleLoadMore = async () => {
    setLoadingMore(true)
    try {
      const result = await getAffectedRowsForIssue(issue.id, 20)
      if (result.success && result.rows.length > 0) {
        setExtraRows(result.rows)
      }
    } catch {
      // silently fail — user still sees the initial sample
    } finally {
      setLoadingMore(false)
    }
  }

  const navigateToQueryData = (query: string) => {
    const params = new URLSearchParams({ tab: 'query', q: query, mode: 'sql' })
    router.push(`/app/projects/${issue.project_id}/data-overview?${params.toString()}`)
  }

  const fixDetails: FixHistory | null = prefetchedFixHistory
    ? (prefetchedFixHistory.find(
        (h) => h.quality_issue_id === issue.id && h.status === 'applied'
      ) ?? null)
    : fetchedFixDetails

  useEffect(() => {
    if (prefetchedFixHistory) return
    if (issue.status === 'fixed' || issue.status === 'accepted_risk') {
      getFixHistory(issue.project_id).then((history) => {
        const latest = history.find(
          (h) => h.quality_issue_id === issue.id && h.status === 'applied'
        )
        setFetchedFixDetails(latest ?? null)
      })
    } else {
      setFetchedFixDetails(null)
    }
  }, [issue.status, issue.id, issue.project_id, prefetchedFixHistory])

  function showToast(msg: string, variant: 'success' | 'error' = 'success') {
    setToast({ message: msg, variant })
    setTimeout(() => setToast(null), 3500)
  }

  async function handleGenerateFix() {
    setError(null)
    startGenerating(async () => {
      const res = await generateFixSuggestions(issue.id)
      if (!res.success) {
        setError(res.error ?? 'Failed to generate fix suggestions')
      } else {
        // Refresh issue from server via parent
        const { issues: refreshed } = await getQualityIssues(issue.project_id)
        const updated = refreshed.find(i => i.id === issue.id)
        if (updated) onUpdate(updated)
      }
    })
  }

  async function handleApplyFix(idx: number, skipSnapshot = false) {
    setApplyingIdx(idx)
    setError(null)
    const res = await applyFix(issue.id, idx, skipSnapshot)
    setApplyingIdx(null)
    setConfirmApply(null)
    if (res.requiresSnapshotConfirmation) {
      // Fix uses complex SQL (CTE) — ask user to confirm applying without a snapshot
      setConfirmNoSnapshot(idx)
      return
    }
    if (!res.success) {
      setError(res.error ?? 'Fix failed')
    } else {
      showToast(`✓ Fix applied to ${res.rowsAffected} records`)
      onUpdate({ ...issue, status: 'fixed' })
    }
  }

  async function handleAcceptRisk() {
    setError(null)
    const res = await acceptRisk(issue.id, riskReason || undefined)
    if (res.success) {
      setShowAcceptModal(false)
      setRiskReason('')
      showToast('Risk accepted')
      onUpdate({ ...issue, status: 'accepted_risk' })
    } else {
      showToast(res.error ?? 'Could not accept risk', 'error')
    }
  }

  async function handleRevert() {
    setReverting(true)
    setError(null)
    try {
      // Find the most recent applied fix_history record for this issue
      const history = await getFixHistory(issue.project_id)
      const entry = history.find(h => h.quality_issue_id === issue.id && h.status === 'applied')
      if (!entry) {
        setError('No revertable fix found for this issue')
        setReverting(false)
        return
      }
      const res = await revertFix(entry.id)
      if (!res.success) {
        setError(res.error ?? 'Revert failed')
      } else {
        showToast(`Reverted — ${res.rowsAffected ?? 0} rows restored, issue re-opened`)
        onUpdate({ ...issue, status: 'open' })
      }
    } catch {
      setError('Revert failed. Please try again.')
    }
    setReverting(false)
  }

  const isFixed = issue.status === 'fixed'
  const isAccepted = issue.status === 'accepted_risk'
  const hasOptions = issue.ai_fix_options && issue.ai_fix_options.length > 0

  return (
    <>
      {showSQL && <SQLModal sql={showSQL} onClose={() => setShowSQL(null)} />}
      {showCustomFix && (
        <IssueFixModal
          issue={issue}
          projectId={issue.project_id}
          onClose={() => setShowCustomFix(false)}
          isArchived={isArchived}
          canEdit={canEdit}
          onFixApplied={(updated, rowsAffected) => {
            setShowCustomFix(false)
            onUpdate(updated)
            showToast(`✓ Fix applied to ${rowsAffected?.toLocaleString() ?? ''} records`)
          }}
        />
      )}
      {confirmApply && (
        <ConfirmModal
          title={`Apply fix: ${confirmApply.fix.label}`}
          message={`This will modify approximately ${confirmApply.fix.estimated_rows_affected} records in the table. This action is logged and can be reverted from Fix History.`}
          confirmLabel="Apply Fix"
          loading={applyingIdx === confirmApply.idx}
          onConfirm={() => handleApplyFix(confirmApply.idx)}
          onCancel={() => setConfirmApply(null)}
        />
      )}
      {confirmNoSnapshot !== null && (
        <ConfirmModal
          title="Fix is not reversible"
          message="This fix uses complex SQL that cannot be fully snapshotted. If you apply it, you will NOT be able to revert it automatically — you would need to re-upload the original CSV to restore data. Apply without snapshot?"
          confirmLabel="Apply Without Snapshot"
          loading={applyingIdx === confirmNoSnapshot}
          onConfirm={() => {
            const idx = confirmNoSnapshot
            setConfirmNoSnapshot(null)
            handleApplyFix(idx, true)
          }}
          onCancel={() => setConfirmNoSnapshot(null)}
        />
      )}
      {showAcceptModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
          <div className="bg-white rounded-xl shadow-2xl w-full max-w-md p-6">
            <h3 className="font-semibold text-gray-900 mb-2">Accept Risk</h3>
            <p className="text-sm text-gray-600 mb-3">Why are you accepting this risk? (optional)</p>
            <textarea
              value={riskReason}
              onChange={e => setRiskReason(e.target.value)}
              placeholder="e.g., This field is not used in the target system..."
              className="w-full text-sm border rounded-lg p-2 h-24 resize-none focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
            <div className="flex gap-3 justify-end mt-4">
              <button onClick={() => setShowAcceptModal(false)} className="px-4 py-2 text-sm font-medium text-gray-700 bg-white border border-gray-300 rounded-lg hover:bg-gray-50 transition-colors">Cancel</button>
              <button onClick={handleAcceptRisk} className="text-gray-500 hover:text-gray-700 underline text-sm transition-colors">Accept Risk</button>
            </div>
          </div>
        </div>
      )}

      <div className={`rounded-xl border shadow-sm overflow-hidden ${
        isFixed
          ? 'bg-green-50/50 border-green-200 border-l-[3px] border-l-green-400'
          : isAccepted
          ? 'bg-amber-50/30 border-amber-200 border-l-[3px] border-l-amber-300'
          : 'bg-white'
      }`}>
        {/* Card Header */}
        <div className="p-4 pb-2">
          <div className="flex items-start gap-3">
            <div className="flex-1 min-w-0">
              <div className="flex flex-wrap items-center gap-2 mb-1">
                <span className="text-sm font-semibold text-gray-900 truncate">{issue.title}</span>
                {/* Severity badge */}
                {issue.severity === 'blocking' ? (
                  <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium bg-red-100 text-red-800 border border-red-200">
                    <span>⊘</span> Blocking
                  </span>
                ) : (
                  <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium bg-amber-100 text-amber-800 border border-amber-200">
                    <span>△</span> Warning
                  </span>
                )}
                {/* Status badge */}
                {isFixed && (
                  <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium bg-green-100 text-green-800 border border-green-200">
                    ✓ Fixed
                  </span>
                )}
                {isAccepted && (
                  <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium bg-gray-100 text-gray-600 border border-gray-200">
                    Risk Accepted
                  </span>
                )}
                {/* Detection source */}
                {(issue.detection_type === 'ai_augmented' || issue.detection_source === 'ai_augmented' as string) ? (
                  <span className="px-1.5 py-0.5 rounded text-[10px] bg-violet-50 text-violet-700 border border-violet-200">
                    ✦ AI
                  </span>
                ) : issue.detection_source === 'custom_rule' || issue.detection_type === 'custom_rule' ? (
                  <span className="px-1.5 py-0.5 rounded text-[10px] bg-blue-50 text-blue-700 border border-blue-200">
                    ✦ Custom Rule
                  </span>
                ) : (
                  <span className="px-1.5 py-0.5 rounded text-[10px] bg-gray-100 text-gray-500 border border-gray-200">
                    Auto
                  </span>
                )}
                {/* Stage badge — derived from issue.stage */}
                {issue.stage === 'source' && (
                  <span className="px-1.5 py-0.5 rounded text-[10px] bg-blue-50 text-blue-700 border border-blue-200">
                    Source
                  </span>
                )}
                {(issue.stage === 'in_flight' || issue.stage === 'target') && (
                  <span className="px-1.5 py-0.5 rounded text-[10px] bg-purple-50 text-purple-700 border border-purple-200">
                    Target-Ready
                  </span>
                )}
              </div>
              <p className="text-sm text-gray-700">{issue.description}</p>
              <p className="text-xs text-gray-400 mt-1">Affected records: {issue.affected_records.toLocaleString()}</p>
              {issue.downstream_impact && (
                <p className="text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded px-2 py-1 mt-2">
                  <strong>Impact:</strong> {issue.downstream_impact}
                </p>
              )}

              {/* Root cause attribution */}
              {issue.root_cause && (
                <div className="flex items-start gap-2 mt-2 text-xs">
                  <span className="text-slate-400 shrink-0 pt-px">Root cause:</span>
                  <span className="text-slate-600">{issue.root_cause}</span>
                </div>
              )}
              {issue.root_cause_breakdown && (
                <div className="flex flex-wrap gap-3 mt-1 text-[11px]">
                  {issue.root_cause_breakdown.source_data > 0 && (
                    <span className="text-slate-500">
                      {issue.root_cause_breakdown.source_data.toLocaleString()} from source data
                    </span>
                  )}
                  {issue.root_cause_breakdown.transform_error > 0 && (
                    <span className="text-amber-600">
                      {issue.root_cause_breakdown.transform_error.toLocaleString()} from transform
                    </span>
                  )}
                  {issue.root_cause_breakdown.missing_transform > 0 && (
                    <span className="text-purple-600">
                      {issue.root_cause_breakdown.missing_transform.toLocaleString()} missing transform
                    </span>
                  )}
                </div>
              )}

              {/* View affected rows toggle */}
              {issue.affected_records > 0 && (
                <button
                  onClick={() => setShowSample(s => !s)}
                  className="flex items-center gap-1.5 text-xs text-blue-600 hover:text-blue-800 font-medium mt-2"
                >
                  <ChevronRight className={`h-3.5 w-3.5 transition-transform ${showSample ? 'rotate-90' : ''}`} />
                  View affected rows ({issue.affected_records.toLocaleString()})
                </button>
              )}

              {/* Affected rows preview panel */}
              {showSample && displayRows.length === 0 && (
                <div className="mt-3 px-4 py-3 bg-slate-50 rounded-md text-xs text-slate-500 border space-y-2">
                  <p>Sample data not available for this issue.</p>
                  <div className="flex items-center gap-3 flex-wrap">
                    {diagnosticQuery && (
                      <button
                        onClick={() => navigateToQueryData(diagnosticQuery)}
                        className="text-blue-600 hover:text-blue-800 font-medium"
                      >
                        View affected rows in Query Data →
                      </button>
                    )}
                    <button
                      onClick={async () => {
                        setLoadingMore(true)
                        try {
                          const result = await getAffectedRowsForIssue(issue.id, 5)
                          if (result.success && result.rows.length > 0) {
                            setExtraRows(result.rows)
                          }
                        } finally {
                          setLoadingMore(false)
                        }
                      }}
                      disabled={loadingMore}
                      className="text-blue-600 hover:text-blue-800 font-medium disabled:opacity-50"
                    >
                      {loadingMore ? 'Loading…' : 'Load samples now'}
                    </button>
                  </div>
                </div>
              )}

              {showSample && displayRows.length > 0 && (
                <div className="mt-3 border rounded-md overflow-hidden">
                  <div className="overflow-x-auto max-h-64 overflow-y-auto">
                    <table className="w-full text-xs">
                      <thead className="bg-slate-50 sticky top-0">
                        <tr>
                          {sampleColumns.map(col => (
                            <th key={col} className="px-3 py-2 text-left font-medium text-slate-600 border-b whitespace-nowrap">
                              {col}
                              {col === fieldName && (
                                <span className="ml-1 text-red-500">●</span>
                              )}
                            </th>
                          ))}
                        </tr>
                      </thead>
                      <tbody>
                        {displayRows.map((row, i) => (
                          <tr key={i} className="border-b last:border-0 hover:bg-slate-50/50">
                            {sampleColumns.map(col => (
                              <td key={col} className={`px-3 py-1.5 font-mono ${
                                col === fieldName ? 'text-red-700 bg-red-50/50 font-medium' : 'text-slate-700'
                              }`}>
                                {row[col] === null || row[col] === undefined || row[col] === ''
                                  ? <span className="text-slate-300 italic">null</span>
                                  : String(row[col]).length > 40
                                    ? String(row[col]).slice(0, 40) + '…'
                                    : String(row[col])
                                }
                              </td>
                            ))}
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>

                  <div className="px-3 py-2 bg-slate-50 border-t flex items-center justify-between gap-2">
                    <span className="text-xs text-slate-500">
                      Showing {displayRows.length} of {issue.affected_records.toLocaleString()} affected rows
                    </span>
                    <div className="flex items-center gap-3">
                      {issue.affected_records > displayRows.length && (
                        <button
                          onClick={handleLoadMore}
                          disabled={loadingMore}
                          className="text-xs text-blue-600 hover:text-blue-800 font-medium disabled:opacity-50"
                        >
                          {loadingMore ? 'Loading…' : 'Load more'}
                        </button>
                      )}
                      {diagnosticQuery && (
                        <button
                          onClick={() => navigateToQueryData(diagnosticQuery)}
                          className="text-xs text-blue-600 hover:text-blue-800 font-medium flex items-center gap-1"
                        >
                          Show all in Query Data
                          <ExternalLink className="h-3 w-3" />
                        </button>
                      )}
                    </div>
                  </div>
                </div>
              )}
            </div>

            {/* Revert button — only on fixed or accepted_risk issues */}
            {(isFixed || isAccepted) && (
              <button
                onClick={handleRevert}
                disabled={reverting}
                title="Revert this change"
                className="shrink-0 mt-0.5 p-1.5 rounded-md text-gray-300 hover:text-gray-600 hover:bg-gray-100 disabled:opacity-40 transition-colors"
              >
                {reverting ? (
                  <span className="block w-4 h-4 border-2 border-gray-300 border-t-gray-500 rounded-full animate-spin" />
                ) : (
                  <RotateCcwIcon />
                )}
              </button>
            )}
          </div>
        </div>

        {/* Fix Applied Summary — shown when status === 'fixed' */}
        {isFixed && fixDetails && (
          <div className="mx-4 mb-4 bg-green-50 border border-green-200 rounded-lg p-3">
            <div className="flex items-center gap-2 mb-1">
              <svg className="w-4 h-4 text-green-600 shrink-0" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" d="M9 12.75L11.25 15 15 9.75M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
              </svg>
              <span className="text-sm font-medium text-green-800">Fix Applied</span>
            </div>
            <p className="text-sm text-green-700 ml-6">{fixDetails.fix_description}</p>
            <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 ml-6 mt-1.5 text-xs text-green-600">
              <span>{fixDetails.affected_row_count.toLocaleString()} rows affected</span>
              <span>·</span>
              <span>Applied {new Date(fixDetails.applied_at).toLocaleString()}</span>
              {fixDetails.fix_sql && fixDetails.fix_sql !== '-- Risk accepted, no SQL executed' && (
                <>
                  <span>·</span>
                  <button
                    onClick={() => setShowSQL(fixDetails.fix_sql)}
                    className="text-green-700 hover:text-green-900 underline"
                  >
                    View SQL
                  </button>
                </>
              )}
            </div>
          </div>
        )}

        {/* Risk Accepted Summary — shown when status === 'accepted_risk' */}
        {isAccepted && fixDetails && (
          <div className="mx-4 mb-4 bg-amber-50 border border-amber-200 rounded-lg p-3">
            <div className="flex items-center gap-2 mb-1">
              <svg className="w-4 h-4 text-amber-600 shrink-0" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v3.75m-9.303 3.376c-.866 1.5.217 3.374 1.948 3.374h14.71c1.73 0 2.813-1.874 1.948-3.374L13.949 3.378c-.866-1.5-3.032-1.5-3.898 0L2.697 16.126zM12 15.75h.007v.008H12v-.008z" />
              </svg>
              <span className="text-sm font-medium text-amber-800">Risk Accepted</span>
            </div>
            <p className="text-sm text-amber-700 ml-6">{fixDetails.fix_description}</p>
            <p className="text-xs text-amber-500 ml-6 mt-1">
              Accepted {new Date(fixDetails.applied_at).toLocaleString()}
            </p>
          </div>
        )}

        {/* AI Fix Section */}
        {!isFixed && !isAccepted && !isArchived && (
          <div className="mx-4 mb-4 rounded-lg bg-gradient-to-br from-blue-50 to-blue-50 border border-blue-200 p-4">
            <div className="flex items-center gap-2 mb-3">
              <span className="text-sm font-semibold text-gray-900">✦ AI-Suggested Fix</span>
            </div>

            {error && (
              <p className="text-xs text-red-600 bg-red-50 rounded px-2 py-1 mb-3">{error}</p>
            )}

            {!hasOptions ? (
              <div className="flex items-center gap-2 flex-wrap">
                <button
                  onClick={handleGenerateFix}
                  disabled={generatingFix}
                  className="flex items-center gap-2 px-4 py-2 text-sm border border-blue-400 text-blue-700 rounded-lg hover:bg-blue-100 disabled:opacity-50 transition-colors"
                >
                  {generatingFix ? (
                    <><span className="w-3.5 h-3.5 border-2 border-blue-300 border-t-blue-600 rounded-full animate-spin" />Generating suggestions…</>
                  ) : (
                    <>✦ Generate Fix Suggestions</>
                  )}
                </button>
                <button
                  onClick={() => setShowCustomFix(true)}
                  className="flex items-center gap-1.5 px-4 py-2 text-sm border border-gray-300 text-gray-700 rounded-lg hover:bg-gray-50 transition-colors"
                >
                  ✎ Custom Fix
                </button>
              </div>
            ) : (
              <div className="space-y-3">
                {(issue.ai_fix_options ?? []).map((opt, idx) => (
                  <div key={idx} className="bg-white rounded-lg border border-blue-100 p-3 space-y-2">
                    <div className="flex items-start justify-between gap-2">
                      <div className="flex-1">
                        <p className="text-sm font-semibold text-gray-900">Option {String.fromCharCode(65 + idx)}: {opt.label}</p>
                        <p className="text-sm text-gray-700 mt-0.5">{opt.description}</p>
                      </div>
                      <span className={`text-xs px-2 py-0.5 rounded-full font-medium shrink-0 ${riskColor(opt.risk_level)}`}>
                        {opt.risk_level.charAt(0).toUpperCase() + opt.risk_level.slice(1)} Risk
                      </span>
                    </div>
                    <div className="text-xs space-y-1">
                      <p className="text-gray-500"><span className="font-medium text-gray-700">Tradeoff:</span> {opt.tradeoff}</p>
                      <p className="text-gray-500"><span className="font-medium text-gray-700">Downstream impact:</span> {opt.downstream_impact}</p>
                      <p className="text-gray-500"><span className="font-medium text-gray-700">Estimated rows:</span> {opt.estimated_rows_affected?.toLocaleString() ?? 'Unknown'}</p>
                    </div>
                    <div className="flex items-center gap-3 pt-1">
                      {!isArchived && (
                        <RoleTooltip allowed={canEdit} requiredRole="Editor">
                          <button
                            onClick={() => setConfirmApply({ idx, fix: opt })}
                            disabled={applyingIdx !== null || !canEdit}
                            className="px-3 py-1.5 text-xs bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:opacity-50 flex items-center gap-1.5"
                          >
                            {applyingIdx === idx && <span className="w-3 h-3 border-2 border-white/30 border-t-white rounded-full animate-spin" />}
                            Apply Fix
                          </button>
                        </RoleTooltip>
                      )}
                      <button
                        onClick={() => setShowSQL(opt.sql)}
                        className="text-xs text-blue-600 hover:text-blue-800 underline"
                      >
                        View SQL
                      </button>
                    </div>
                  </div>
                ))}
                <div className="pt-1 border-t border-blue-100 flex items-center justify-between gap-3">
                  <div className="flex items-center gap-2">
                    <RoleTooltip allowed={canEdit} requiredRole="Editor">
                      <button
                        onClick={canEdit ? () => setShowCustomFix(true) : undefined}
                        disabled={!canEdit}
                        className="flex items-center gap-1.5 px-3 py-1.5 text-sm border border-gray-300 text-gray-700 rounded-lg hover:bg-gray-50 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
                      >
                        ✎ Write a Custom Fix
                      </button>
                    </RoleTooltip>
                    <RoleTooltip allowed={canEdit} requiredRole="Editor">
                      <button
                        onClick={canEdit ? handleGenerateFix : undefined}
                        disabled={generatingFix || !canEdit}
                        className="flex items-center gap-1.5 px-3 py-1.5 text-sm border border-gray-300 text-gray-500 rounded-lg hover:bg-gray-50 disabled:opacity-50 transition-colors"
                        title="Re-generate fix suggestions with latest AI"
                      >
                      {generatingFix ? (
                        <><span className="w-3 h-3 border-2 border-gray-300 border-t-gray-500 rounded-full animate-spin" />Regenerating…</>
                      ) : (
                        <>↻ Regenerate</>
                      )}
                      </button>
                    </RoleTooltip>
                  </div>
                  <RoleTooltip allowed={canEdit} requiredRole="Editor">
                    <button
                      onClick={canEdit ? () => setShowAcceptModal(true) : undefined}
                      disabled={!canEdit}
                      className="text-sm text-gray-500 hover:text-gray-700 underline disabled:opacity-40 disabled:cursor-not-allowed"
                    >
                      Accept Risk
                    </button>
                  </RoleTooltip>
                </div>
              </div>
            )}

            {!hasOptions && !generatingFix && (
              <RoleTooltip allowed={canEdit} requiredRole="Editor">
                <button
                  onClick={canEdit ? () => setShowAcceptModal(true) : undefined}
                  disabled={!canEdit}
                  className="mt-2 text-sm text-gray-500 hover:text-gray-700 underline disabled:opacity-40 disabled:cursor-not-allowed"
                >
                  Accept Risk
                </button>
              </RoleTooltip>
            )}
          </div>
        )}

        {toast && (
          <div
            className={`mx-4 mb-3 px-3 py-2 text-sm rounded-lg border ${
              toast.variant === 'success'
                ? 'bg-green-50 text-green-700 border-green-200'
                : 'bg-red-50 text-red-700 border-red-200'
            }`}
          >
            {toast.message}
          </div>
        )}
      </div>
    </>
  )
}

// ── Add Validation Rule Modal ─────────────────────────────────────────────────

function AddRuleModal({
  projectId,
  allDatasets,
  onClose,
  onAdded,
}: {
  projectId: string
  allDatasets: DatasetStub[]
  onClose: () => void
  onAdded: (rule: ValidationRule) => void
}) {
  const [mode, setMode] = useState<'nl' | 'manual'>('nl')
  const [selectedTableId, setSelectedTableId] = useState('')
  const [selectedFieldId, setSelectedFieldId] = useState('')
  const [nlPrompt, setNlPrompt] = useState('')
  const [nlSeverity, setNlSeverity] = useState<'blocking' | 'warning'>('warning')
  const [reviewSeverity, setReviewSeverity] = useState<'blocking' | 'warning'>('warning')
  const [manualType, setManualType] = useState('not_null')
  const [manualName, setManualName] = useState('')
  const [manualSeverity, setManualSeverity] = useState<'blocking' | 'warning'>('warning')
  const [manualConfig, setManualConfig] = useState<Record<string, unknown>>({})
  const [generatedRule, setGeneratedRule] = useState<ValidationRule | null>(null)
  const [loading, startLoading] = useTransition()
  const [error, setError] = useState<string | null>(null)

  const allTables = allDatasets.flatMap(d => d.tables)
  const selectedTable = allTables.find(t => t.id === selectedTableId)
  const selectedField = selectedTable?.fields.find(f => f.id === selectedFieldId) ?? null

  async function handleGenerateNL() {
    if (!selectedFieldId || !nlPrompt.trim()) return
    setError(null)
    startLoading(async () => {
      try {
        const res = await addValidationRuleFromNL(projectId, selectedFieldId, nlPrompt, nlSeverity)
        if (!res?.success) { setError(res?.error ?? 'Failed to generate rule. Have you run the database migration?'); return }
        setGeneratedRule(res.rule!)
        setReviewSeverity(res.rule!.severity)
      } catch (e) {
        setError('Failed to generate rule. Please ensure the database migration (006_data_quality.sql) has been run.')
      }
    })
  }

  async function handleSaveManual() {
    if (!manualName.trim()) { setError('Rule name is required'); return }
    setError(null)
    startLoading(async () => {
      try {
        const res = await addValidationRule(
          projectId,
          selectedFieldId || null,
          selectedTableId || null,
          { name: manualName, rule_type: manualType, rule_config: manualConfig, severity: manualSeverity }
        )
        if (!res?.success) { setError(res?.error ?? 'Failed to save rule. Have you run the database migration?'); return }
        onAdded(res.rule!)
        onClose()
      } catch (e) {
        setError('Failed to save rule. Please ensure the database migration (006_data_quality.sql) has been run.')
      }
    })
  }

  function handleAcceptGenerated() {
    if (!generatedRule) return
    if (reviewSeverity === generatedRule.severity) {
      // Severity unchanged — use the already-saved rule as-is
      onAdded(generatedRule)
      onClose()
    } else {
      // Severity changed on review screen — delete old rule, re-insert with new severity
      startLoading(async () => {
        try {
        await deleteValidationRule(generatedRule.id)
        const res = await addValidationRule(
          projectId,
          generatedRule.field_id,
          generatedRule.table_id,
          {
            name: generatedRule.name,
            rule_type: generatedRule.rule_type,
            rule_config: generatedRule.rule_config,
            severity: reviewSeverity,
            description: generatedRule.description ?? undefined,
          }
        )
        if (!res?.success) { setError(res?.error ?? 'Failed to save rule'); return }
        onAdded(res.rule!)
        onClose()
        } catch (e) {
          setError('Failed to save rule. Please try again.')
        }
      })
    }
  }

  const ruleTypeOptions = [
    { value: 'not_null', label: 'Not Null' },
    { value: 'unique', label: 'Unique' },
    { value: 'min_value', label: 'Min Value' },
    { value: 'max_value', label: 'Max Value' },
    { value: 'min_length', label: 'Min Length' },
    { value: 'max_length', label: 'Max Length' },
    { value: 'regex', label: 'Regex Pattern' },
    { value: 'allowed_values', label: 'Allowed Values' },
    { value: 'range', label: 'Range' },
    { value: 'date_after', label: 'Date After' },
    { value: 'date_before', label: 'Date Before' },
  ]

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
      <div className="bg-white rounded-xl shadow-2xl w-full max-w-lg max-h-[85vh] overflow-y-auto">
        <div className="flex items-center justify-between p-5 border-b sticky top-0 bg-white">
          <h3 className="font-semibold text-gray-900">Add Validation Rule</h3>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600 text-xl">×</button>
        </div>
        <div className="p-5 space-y-4">
          {/* Step 1: Select field */}
          <div>
            <label className="text-xs font-semibold text-gray-500 uppercase tracking-wide">Step 1: Select Table & Field</label>
            <div className="mt-1.5 grid grid-cols-2 gap-2">
              <Select
                value={selectedTableId}
                onValueChange={(val) => { setSelectedTableId(val); setSelectedFieldId('') }}
              >
                <SelectTrigger className="h-9 text-sm w-full">
                  <SelectValue placeholder="Select table…" />
                </SelectTrigger>
                <SelectContent>
                  {allDatasets.map(ds => (
                    ds.tables.map(t => (
                      <SelectItem key={t.id} value={t.id}>{ds.name} — {t.name}</SelectItem>
                    ))
                  ))}
                </SelectContent>
              </Select>
              <Select
                value={selectedFieldId}
                onValueChange={(val) => setSelectedFieldId(val)}
                disabled={!selectedTableId}
              >
                <SelectTrigger className="h-9 text-sm w-full">
                  <SelectValue placeholder="Select field…" />
                </SelectTrigger>
                <SelectContent>
                  {selectedTable?.fields.map(f => (
                    <SelectItem key={f.id} value={f.id}>{f.name} ({f.data_type})</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>

          {/* Step 2: Mode toggle */}
          <div>
            <label className="text-xs font-semibold text-gray-500 uppercase tracking-wide">Step 2: Define Rule</label>
            <div className="mt-1.5 flex rounded-lg border overflow-hidden">
              <button
                onClick={() => setMode('nl')}
                className={`flex-1 text-sm py-2 ${mode === 'nl' ? 'bg-blue-600 text-white' : 'bg-white text-gray-600 hover:bg-gray-50'}`}
              >
                ✦ Natural Language
              </button>
              <button
                onClick={() => setMode('manual')}
                className={`flex-1 text-sm py-2 ${mode === 'manual' ? 'bg-blue-600 text-white' : 'bg-white text-gray-600 hover:bg-gray-50'}`}
              >
                Manual
              </button>
            </div>
          </div>

          {error && <p className="text-sm text-red-600 bg-red-50 rounded-lg px-3 py-2">{error}</p>}

          {mode === 'nl' ? (
            generatedRule ? (
              <div className="space-y-3">
                <p className="text-xs font-semibold text-gray-500 uppercase">Generated Rule — Review</p>
                <div className="bg-blue-50 rounded-lg border border-blue-200 p-3 space-y-2 text-sm">
                  <p><strong>Name:</strong> {generatedRule.name}</p>
                  <p><strong>Type:</strong> {generatedRule.rule_type}</p>
                  <p><strong>Config:</strong> {JSON.stringify(generatedRule.rule_config)}</p>
                  {generatedRule.description && <p><strong>Description:</strong> {generatedRule.description}</p>}
                  {/* Editable severity on review screen */}
                  <div className="flex items-center gap-2 pt-1">
                    <strong>Severity:</strong>
                    <button
                      onClick={() => setReviewSeverity('warning')}
                      className={`text-xs px-2.5 py-1 rounded-full border transition-colors ${reviewSeverity === 'warning' ? 'bg-amber-100 text-amber-800 border-amber-300' : 'text-gray-500 border-gray-200 hover:bg-gray-50'}`}
                    >
                      Warning
                    </button>
                    <button
                      onClick={() => setReviewSeverity('blocking')}
                      className={`text-xs px-2.5 py-1 rounded-full border transition-colors ${reviewSeverity === 'blocking' ? 'bg-red-100 text-red-800 border-red-300' : 'text-gray-500 border-gray-200 hover:bg-gray-50'}`}
                    >
                      Blocking
                    </button>
                  </div>
                </div>
                <div className="flex gap-2">
                  <button
                    onClick={handleAcceptGenerated}
                    disabled={loading}
                    className="flex-1 px-4 py-2 text-sm bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:opacity-50 flex items-center justify-center gap-2"
                  >
                    {loading ? <><span className="w-3.5 h-3.5 border-2 border-white/30 border-t-white rounded-full animate-spin" />Saving…</> : 'Save Rule'}
                  </button>
                  <button onClick={() => setGeneratedRule(null)} disabled={loading} className="px-4 py-2 text-sm border rounded-lg hover:bg-gray-50 disabled:opacity-50">
                    Edit
                  </button>
                </div>
              </div>
            ) : (
              <div className="space-y-3">
                {/* Severity toggle for NL mode */}
                <div className="flex items-center gap-2">
                  <span className="text-sm text-gray-600">Severity:</span>
                  <button
                    onClick={() => setNlSeverity('warning')}
                    className={`text-sm px-3 py-1 rounded-full border transition-colors ${nlSeverity === 'warning' ? 'bg-amber-100 text-amber-800 border-amber-300' : 'text-gray-500 border-gray-200 hover:bg-gray-50'}`}
                  >
                    Warning
                  </button>
                  <button
                    onClick={() => setNlSeverity('blocking')}
                    className={`text-sm px-3 py-1 rounded-full border transition-colors ${nlSeverity === 'blocking' ? 'bg-red-100 text-red-800 border-red-300' : 'text-gray-500 border-gray-200 hover:bg-gray-50'}`}
                  >
                    Blocking
                  </button>
                </div>
                <textarea
                  value={nlPrompt}
                  onChange={e => setNlPrompt(e.target.value)}
                  placeholder="e.g., Revenue should never be negative"
                  className="w-full text-sm border rounded-lg p-3 h-24 resize-none focus:outline-none focus:ring-2 focus:ring-blue-500"
                />
                <button
                  onClick={handleGenerateNL}
                  disabled={loading || !selectedFieldId || !nlPrompt.trim()}
                  className="w-full px-4 py-2 text-sm bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:opacity-50 flex items-center justify-center gap-2"
                >
                  {loading ? <><span className="w-3.5 h-3.5 border-2 border-white/30 border-t-white rounded-full animate-spin" />Generating…</> : '✦ Generate Rule'}
                </button>
              </div>
            )
          ) : (
            <div className="space-y-3">
              <input
                value={manualName}
                onChange={e => setManualName(e.target.value)}
                placeholder="Rule name"
                className="w-full text-sm border rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-blue-500"
              />
              <Select
                value={manualType}
                onValueChange={(val) => { setManualType(val); setManualConfig({}) }}
              >
                <SelectTrigger className="h-9 text-sm w-full">
                  <SelectValue placeholder="Select rule type…" />
                </SelectTrigger>
                <SelectContent>
                  {ruleTypeOptions.map(o => (
                    <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>
                  ))}
                </SelectContent>
              </Select>

              {/* Dynamic config based on type */}
              {manualType === 'min_value' && (
                <input type="number" placeholder="Minimum value" onChange={e => setManualConfig({ min: Number(e.target.value) })}
                  className="w-full text-sm border rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-blue-500" />
              )}
              {manualType === 'max_value' && (
                <input type="number" placeholder="Maximum value" onChange={e => setManualConfig({ max: Number(e.target.value) })}
                  className="w-full text-sm border rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-blue-500" />
              )}
              {manualType === 'max_length' && (
                <input type="number" placeholder="Maximum length" onChange={e => setManualConfig({ max_length: Number(e.target.value) })}
                  className="w-full text-sm border rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-blue-500" />
              )}
              {manualType === 'min_length' && (
                <input type="number" placeholder="Minimum length" onChange={e => setManualConfig({ min_length: Number(e.target.value) })}
                  className="w-full text-sm border rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-blue-500" />
              )}
              {manualType === 'regex' && (
                <input placeholder="Regex pattern (e.g. ^[A-Z]{2}\\d{4}$)" onChange={e => setManualConfig({ pattern: e.target.value })}
                  className="w-full text-sm border rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-blue-500" />
              )}
              {manualType === 'allowed_values' && (
                <input placeholder="Comma-separated values (e.g. Active, Inactive)" onChange={e => setManualConfig({ values: e.target.value.split(',').map(v => v.trim()) })}
                  className="w-full text-sm border rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-blue-500" />
              )}
              {manualType === 'range' && (
                <div className="grid grid-cols-2 gap-2">
                  <input type="number" placeholder="Min" onChange={e => setManualConfig(c => ({ ...c, min: Number(e.target.value) }))}
                    className="text-sm border rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-blue-500" />
                  <input type="number" placeholder="Max" onChange={e => setManualConfig(c => ({ ...c, max: Number(e.target.value) }))}
                    className="text-sm border rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-blue-500" />
                </div>
              )}
              {(manualType === 'date_after' || manualType === 'date_before') && (
                <input type="date" onChange={e => setManualConfig({ date: e.target.value })}
                  className="w-full text-sm border rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-blue-500" />
              )}

              <div className="flex gap-3">
                <label className="text-sm text-gray-600">Severity:</label>
                <button onClick={() => setManualSeverity('warning')}
                  className={`text-sm px-3 py-1 rounded-full border ${manualSeverity === 'warning' ? 'bg-amber-100 text-amber-800 border-amber-300' : 'text-gray-500 hover:bg-gray-50'}`}>
                  Warning
                </button>
                <button onClick={() => setManualSeverity('blocking')}
                  className={`text-sm px-3 py-1 rounded-full border ${manualSeverity === 'blocking' ? 'bg-red-100 text-red-800 border-red-300' : 'text-gray-500 hover:bg-gray-50'}`}>
                  Blocking
                </button>
              </div>

              <button
                onClick={handleSaveManual}
                disabled={loading}
                className="w-full px-4 py-2 text-sm bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:opacity-50 flex items-center justify-center gap-2"
              >
                {loading ? <><span className="w-3.5 h-3.5 border-2 border-white/30 border-t-white rounded-full animate-spin" />Saving…</> : 'Save Rule'}
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

// ── Verified Fixes Section ────────────────────────────────────────────────────
// Shown in the issue list when filterStatus is 'fixed' or 'all'.
// Displays fix_history entries whose quality_issue_id was set to NULL by a
// rescan — meaning the original issue row was deleted (successfully resolved).

function VerifiedFixesSection({
  fixes,
  tableNameById,
}: {
  fixes: VerifiedFix[]
  tableNameById: Map<string, string>
}) {
  const [expanded, setExpanded] = useState(false)

  return (
    <div className="bg-white rounded-xl border border-blue-200 shadow-sm overflow-hidden">
      {/* Header */}
      <button
        onClick={() => setExpanded(e => !e)}
        className="w-full flex items-center justify-between gap-3 px-5 py-3.5 hover:bg-blue-50/40 transition-colors text-left"
      >
        <div className="flex items-center gap-2.5">
          <span className="w-2 h-2 rounded-full bg-blue-500 flex-shrink-0" />
          <span className="text-sm font-semibold text-blue-800">
            Verified Fixed ({fixes.length})
          </span>
          <span className="text-xs text-blue-500 font-normal">
            — confirmed by rescan
          </span>
        </div>
        <span className="text-xs text-gray-400">{expanded ? '▼' : '▶'}</span>
      </button>

      {expanded && (
        <div className="border-t border-blue-100 divide-y divide-blue-50">
          {fixes.map((fix) => {
            const tableName = tableNameById.get(fix.tableId) ?? fix.tableId
            return (
              <div key={fix.id} className="flex items-start gap-3 px-5 py-3 bg-blue-50/30">
                <span className="text-blue-500 flex-shrink-0 mt-0.5 text-sm">✓</span>
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium text-blue-900 truncate">
                    {tableName}
                  </p>
                  <p className="text-xs text-blue-700 mt-0.5 line-clamp-2">
                    {fix.fixDescription}
                  </p>
                  <p className="text-xs text-gray-400 mt-0.5">
                    {fix.affectedRowCount.toLocaleString()} row{fix.affectedRowCount !== 1 ? 's' : ''} fixed
                    {' · '}
                    {new Date(fix.appliedAt).toLocaleDateString()}
                  </p>
                </div>
                <span className="flex-shrink-0 text-xs font-medium text-blue-600 bg-blue-100 border border-blue-200 px-2 py-0.5 rounded-full whitespace-nowrap">
                  Verified fixed
                </span>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}

// ── Fix History Panel ─────────────────────────────────────────────────────────

function FixHistoryPanel({
  projectId,
  onClose,
  onIssueReverted,
}: {
  projectId: string
  onClose: () => void
  onIssueReverted?: (qualityIssueId: string | null) => void
}) {
  const [history, setHistory] = useState<FixHistory[]>([])
  const [loading, setLoading] = useState(true)
  const [revertingId, setRevertingId] = useState<string | null>(null)
  const [showSQL, setShowSQL] = useState<string | null>(null)

  useEffect(() => {
    getFixHistory(projectId).then(h => { setHistory(h); setLoading(false) })
  }, [projectId])

  const [revertError, setRevertError] = useState<string | null>(null)

  async function handleRevert(id: string) {
    setRevertingId(id)
    setRevertError(null)
    const res = await revertFix(id)
    setRevertingId(null)
    if (res.success) {
      const revertedEntry = history.find(e => e.id === id)
      setHistory(h => h.map(e => e.id === id ? { ...e, status: 'reverted' } : e))
      onIssueReverted?.(revertedEntry?.quality_issue_id ?? null)
    } else {
      setRevertError(res.error ?? 'Revert failed')
    }
  }

  return (
    <>
      {showSQL && <SQLModal sql={showSQL} onClose={() => setShowSQL(null)} />}
      <div className="fixed inset-0 z-40 flex items-center justify-end bg-black/30 p-4">
        <div className="bg-white rounded-xl shadow-2xl w-full max-w-xl h-full max-h-[90vh] flex flex-col">
          <div className="flex items-center justify-between p-4 border-b">
            <h3 className="font-semibold text-gray-900">Fix History</h3>
            <button onClick={onClose} className="text-gray-400 hover:text-gray-600 text-xl">×</button>
          </div>
          <div className="flex-1 overflow-y-auto p-4 space-y-3">
            {revertError && (
              <div className="bg-red-50 border border-red-200 rounded-lg px-3 py-2 text-xs text-red-700">
                {revertError}
              </div>
            )}
            {loading ? (
              <p className="text-sm text-gray-400 text-center py-8">Loading…</p>
            ) : history.length === 0 ? (
              <p className="text-sm text-gray-400 text-center py-8">No fixes applied yet.</p>
            ) : history.map(entry => (
              <div key={entry.id} className="border rounded-lg p-3 space-y-1 text-sm">
                <div className="flex items-start justify-between gap-2">
                  <p className="font-medium text-gray-900">{entry.fix_description}</p>
                  <div className="flex flex-col items-end gap-1 shrink-0">
                    <span className={`text-xs px-2 py-0.5 rounded-full ${entry.status === 'applied' ? 'bg-green-100 text-green-700' : 'bg-gray-100 text-gray-500'}`}>
                      {entry.status === 'applied' ? 'Applied' : 'Reverted'}
                    </span>
                    {entry.fix_option_chosen === 'Manual fix' && (
                      <span className="text-[10px] px-1.5 py-0.5 rounded bg-violet-100 text-violet-700 border border-violet-200">
                        Manual
                      </span>
                    )}
                  </div>
                </div>
                <p className="text-gray-500 text-xs">{entry.affected_row_count.toLocaleString()} rows affected · {new Date(entry.applied_at).toLocaleString()}</p>
                <div className="flex gap-3 pt-1 items-center">
                  <button onClick={() => setShowSQL(entry.fix_sql)} className="text-xs text-blue-600 underline hover:text-blue-800">View SQL</button>
                  {entry.status === 'applied' && (
                    entry.snapshot_failed ? (
                      <span
                        title="Cannot revert — no snapshot was taken for this fix. Re-upload the original CSV to restore data."
                        className="text-xs text-gray-300 cursor-not-allowed select-none"
                      >
                        Revert
                      </span>
                    ) : (
                      <button
                        onClick={() => handleRevert(entry.id)}
                        disabled={revertingId === entry.id}
                        className="text-xs text-red-600 underline hover:text-red-800 disabled:opacity-50"
                      >
                        {revertingId === entry.id ? 'Reverting…' : 'Revert'}
                      </button>
                    )
                  )}
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>
    </>
  )
}

// ── Create Manual Fix Modal ───────────────────────────────────────────────────

function CreateManualFixModal({
  projectId,
  allDatasets,
  onClose,
  onApplied,
  isArchived = false,
  canEdit = true,
}: {
  projectId: string
  allDatasets: DatasetStub[]
  onClose: () => void
  onApplied: () => void
  isArchived?: boolean
  canEdit?: boolean
}) {
  const [mode, setMode] = useState<'nl' | 'sql'>('nl')
  const [tableId, setTableId] = useState('')
  const [fieldId, setFieldId] = useState('')
  const [nlDescription, setNlDescription] = useState('')
  const [sqlText, setSqlText] = useState('')
  const [generatedSql, setGeneratedSql] = useState('')
  const [estimatedRows, setEstimatedRows] = useState<number | null>(null)
  const [validationError, setValidationError] = useState<string | null>(null)
  const [sqlValidated, setSqlValidated] = useState(false)
  const [generating, startGenerate] = useTransition()
  const [validating, startValidate] = useTransition()
  const [applying, startApply] = useTransition()
  const [error, setError] = useState<string | null>(null)
  const [toast, setToast] = useState<string | null>(null)
  const [confirmNoSnapshot, setConfirmNoSnapshot] = useState<{ sql: string; desc: string } | null>(null)

  const allTables = allDatasets.flatMap(d => d.tables)
  const selectedTable = allTables.find(t => t.id === tableId)

  // Auto-populate table_id placeholder into SQL editor when table changes
  useEffect(() => {
    if (mode === 'sql' && tableId && !sqlText) {
      setSqlText(`UPDATE data_rows\nSET row_data = jsonb_set(row_data, '{FieldName}', '"new_value"')\nWHERE table_id = '${tableId}'`)
    }
  }, [tableId, mode, sqlText])

  function handleModeSwitch(newMode: 'nl' | 'sql') {
    setMode(newMode)
    // Pre-fill SQL editor with generated SQL when switching from NL
    if (newMode === 'sql' && generatedSql) {
      setSqlText(generatedSql)
    }
    setValidationError(null)
    setSqlValidated(false)
    setEstimatedRows(null)
  }

  function handleGenerateFix() {
    if (!tableId || !nlDescription.trim()) return
    setError(null)
    startGenerate(async () => {
      try {
        const res = await generateManualFix(projectId, tableId, fieldId || null, nlDescription)
        if (res.error) { setError(res.error); return }
        setGeneratedSql(res.sql)
        setEstimatedRows(res.estimatedRows)
      } catch {
        setError('Failed to generate fix. Please try again.')
      }
    })
  }

  function handleValidate() {
    if (!sqlText.trim() || !tableId) return
    setValidationError(null)
    setSqlValidated(false)
    setEstimatedRows(null)
    startValidate(async () => {
      try {
        const res = await previewManualFix(projectId, tableId, sqlText)
        if (!res.valid) {
          setValidationError(res.error ?? 'Invalid SQL')
        } else {
          setSqlValidated(true)
          setEstimatedRows(res.estimatedRows)
        }
      } catch {
        setValidationError('Validation failed. Please try again.')
      }
    })
  }

  function handleApplyNL(skipSnapshot = false) {
    if (!generatedSql || !tableId) return
    setError(null)
    startApply(async () => {
      try {
        const res = await applyManualFix(projectId, tableId, generatedSql, nlDescription, skipSnapshot)
        if (res.requiresSnapshotConfirmation) {
          setConfirmNoSnapshot({ sql: generatedSql, desc: nlDescription })
          return
        }
        if (!res.success) { setError(res.error ?? 'Failed to apply fix'); return }
        setToast(`✓ Fix applied to ${res.rowsAffected} rows`)
        setTimeout(() => { onApplied(); onClose() }, 1500)
      } catch {
        setError('Failed to apply fix. Please try again.')
      }
    })
  }

  function handleApplySQL(skipSnapshot = false) {
    if (!sqlText.trim() || !tableId || !sqlValidated) return
    setError(null)
    startApply(async () => {
      try {
        const desc = nlDescription.trim() || `Manual SQL fix on ${selectedTable?.name ?? 'table'}`
        const res = await applyManualFix(projectId, tableId, sqlText, desc, skipSnapshot)
        if (res.requiresSnapshotConfirmation) {
          setConfirmNoSnapshot({ sql: sqlText, desc })
          return
        }
        if (!res.success) { setError(res.error ?? 'Failed to apply fix'); return }
        setToast(`✓ Fix applied to ${res.rowsAffected} rows`)
        setTimeout(() => { onApplied(); onClose() }, 1500)
      } catch {
        setError('Failed to apply fix. Please try again.')
      }
    })
  }

  const isApplying = applying

  return (
    <>
    {confirmNoSnapshot && (
      <ConfirmModal
        title="Fix is not reversible"
        message="This fix uses complex SQL that cannot be fully snapshotted. If you apply it, you will NOT be able to revert it automatically — you would need to re-upload the original CSV to restore data. Apply without snapshot?"
        confirmLabel="Apply Without Snapshot"
        loading={applying}
        onConfirm={() => {
          const { sql, desc } = confirmNoSnapshot
          setConfirmNoSnapshot(null)
          setError(null)
          startApply(async () => {
            try {
              const res = await applyManualFix(projectId, tableId, sql, desc, true)
              if (!res.success) { setError(res.error ?? 'Failed to apply fix'); return }
              setToast(`✓ Fix applied to ${res.rowsAffected} rows`)
              setTimeout(() => { onApplied(); onClose() }, 1500)
            } catch {
              setError('Failed to apply fix. Please try again.')
            }
          })
        }}
        onCancel={() => setConfirmNoSnapshot(null)}
      />
    )}
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
      <div className="bg-white rounded-xl shadow-2xl w-full max-w-xl max-h-[90vh] flex flex-col">
        {/* Header */}
        <div className="flex items-center justify-between p-4 border-b shrink-0">
          <h3 className="font-semibold text-gray-900">Create Manual Fix</h3>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600 text-xl">×</button>
        </div>

        <div className="flex-1 overflow-y-auto p-4 space-y-4">
          {toast && (
            <div className="bg-green-50 border border-green-200 rounded-lg px-3 py-2 text-sm text-green-700">{toast}</div>
          )}
          {error && (
            <div className="bg-red-50 border border-red-200 rounded-lg px-3 py-2 text-sm text-red-700">{error}</div>
          )}

          {/* Step 1: Select scope */}
          <div className="space-y-2">
            <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide">Step 1 — Select scope</p>
            <Select
              value={tableId}
              onValueChange={(val) => { setTableId(val); setFieldId(''); setGeneratedSql(''); setSqlText(''); setSqlValidated(false) }}
            >
              <SelectTrigger className="h-9 text-sm w-full">
                <SelectValue placeholder="Select table…" />
              </SelectTrigger>
              <SelectContent>
                {allDatasets.map(ds => (
                  ds.tables.map(t => (
                    <SelectItem key={t.id} value={t.id}>{ds.name} — {t.name}</SelectItem>
                  ))
                ))}
              </SelectContent>
            </Select>
            {selectedTable && (
              <Select
                value={fieldId || '__all__'}
                onValueChange={(val) => setFieldId(val === '__all__' ? '' : val)}
              >
                <SelectTrigger className="h-9 text-sm w-full">
                  <SelectValue placeholder="Entire table (all fields)" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="__all__">Entire table (all fields)</SelectItem>
                  {selectedTable.fields.map(f => (
                    <SelectItem key={f.id} value={f.id}>{f.name} ({f.inferred_type ?? f.data_type})</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
          </div>

          {/* Step 2: Define fix */}
          {tableId && (
            <div className="space-y-3">
              <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide">Step 2 — Define fix</p>

              {/* Mode toggle */}
              <div className="flex rounded-lg border border-gray-200 overflow-hidden text-sm">
                <button
                  onClick={() => handleModeSwitch('nl')}
                  className={`flex-1 py-2 flex items-center justify-center gap-1.5 transition-colors ${mode === 'nl' ? 'bg-blue-600 text-white' : 'text-gray-600 hover:bg-gray-50'}`}
                >
                  <span>✦</span> Natural Language
                </button>
                <button
                  onClick={() => handleModeSwitch('sql')}
                  className={`flex-1 py-2 flex items-center justify-center gap-1.5 transition-colors ${mode === 'sql' ? 'bg-blue-600 text-white' : 'text-gray-600 hover:bg-gray-50'}`}
                >
                  <span className="font-mono">{`</>`}</span> SQL Editor
                </button>
              </div>

              {mode === 'nl' ? (
                <div className="space-y-3">
                  <textarea
                    value={nlDescription}
                    onChange={e => { setNlDescription(e.target.value); setGeneratedSql('') }}
                    placeholder={"e.g., Set all null Industry values to 'UNKNOWN'\ne.g., Delete all rows where Status is 'Archived'\ne.g., Convert all phone numbers to E.164 format"}
                    className="w-full text-sm border rounded-lg p-3 h-24 resize-none focus:outline-none focus:ring-2 focus:ring-blue-500 font-normal"
                  />
                  <button
                    onClick={handleGenerateFix}
                    disabled={generating || !nlDescription.trim()}
                    className="w-full px-4 py-2 text-sm bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:opacity-50 flex items-center justify-center gap-2"
                  >
                    {generating ? (
                      <><span className="w-3.5 h-3.5 border-2 border-white/30 border-t-white rounded-full animate-spin" />Generating fix…</>
                    ) : '✦ Generate Fix'}
                  </button>

                  {/* Generated SQL review panel */}
                  {generatedSql && (
                    <div className="space-y-3 border border-blue-200 rounded-lg p-3 bg-blue-50">
                      <p className="text-xs font-semibold text-blue-700">Generated SQL — Review before applying</p>
                      <pre className="bg-gray-950 text-green-300 rounded-lg p-3 text-xs overflow-x-auto whitespace-pre-wrap font-mono">
                        {generatedSql}
                      </pre>
                      {estimatedRows !== null && (
                        <p className="text-xs text-blue-700">
                          Estimated rows affected: <strong>{estimatedRows.toLocaleString()}</strong>
                        </p>
                      )}
                      <div className="flex gap-2">
                        {!isArchived && (
                          <RoleTooltip allowed={canEdit} requiredRole="Editor">
                            <button
                              onClick={() => handleApplyNL()}
                              disabled={isApplying || !canEdit}
                              className="flex-1 px-3 py-1.5 text-sm bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:opacity-50 flex items-center justify-center gap-2"
                            >
                              {isApplying ? (
                                <><span className="w-3.5 h-3.5 border-2 border-white/30 border-t-white rounded-full animate-spin" />Applying…</>
                              ) : 'Apply Fix'}
                            </button>
                          </RoleTooltip>
                        )}
                        <button
                          onClick={() => handleModeSwitch('sql')}
                          className="px-3 py-1.5 text-sm border border-blue-300 text-blue-700 rounded-lg hover:bg-blue-100"
                        >
                          Edit SQL
                        </button>
                      </div>
                    </div>
                  )}
                </div>
              ) : (
                <div className="space-y-3">
                  <textarea
                    value={sqlText}
                    onChange={e => { setSqlText(e.target.value); setSqlValidated(false); setValidationError(null) }}
                    placeholder={`UPDATE data_rows\nSET row_data = jsonb_set(row_data, '{Industry}', '"UNKNOWN"')\nWHERE table_id = '${tableId}'\n  AND (row_data->>'Industry' IS NULL)`}
                    className="w-full text-sm border rounded-lg p-3 h-36 resize-none focus:outline-none focus:ring-2 focus:ring-blue-500 font-mono"
                  />
                  {validationError && (
                    <p className="text-xs text-red-600 bg-red-50 border border-red-200 rounded px-2 py-1">{validationError}</p>
                  )}
                  {sqlValidated && estimatedRows !== null && (
                    <p className="text-xs text-green-700 bg-green-50 border border-green-200 rounded px-2 py-1">
                      ✓ SQL valid — estimated rows affected: <strong>{estimatedRows.toLocaleString()}</strong>
                    </p>
                  )}
                  <div className="flex gap-2">
                    <button
                      onClick={handleValidate}
                      disabled={validating || !sqlText.trim()}
                      className="px-3 py-1.5 text-sm border border-gray-300 text-gray-700 rounded-lg hover:bg-gray-50 disabled:opacity-50 flex items-center gap-2"
                    >
                      {validating ? (
                        <><span className="w-3 h-3 border-2 border-gray-300 border-t-gray-600 rounded-full animate-spin" />Validating…</>
                      ) : 'Validate & Preview'}
                    </button>
                    {!isArchived && (
                      <RoleTooltip allowed={canEdit} requiredRole="Editor">
                        <button
                          onClick={() => handleApplySQL()}
                          disabled={!sqlValidated || isApplying || !canEdit}
                          className="flex-1 px-3 py-1.5 text-sm bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:opacity-50 flex items-center justify-center gap-2"
                        >
                          {isApplying ? (
                            <><span className="w-3.5 h-3.5 border-2 border-white/30 border-t-white rounded-full animate-spin" />Applying…</>
                          ) : 'Apply Fix'}
                        </button>
                      </RoleTooltip>
                    )}
                  </div>
                </div>
              )}
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="p-4 border-t shrink-0 flex justify-end">
          <button onClick={onClose} className="px-4 py-2 text-sm font-medium text-gray-700 bg-white border border-gray-300 rounded-lg hover:bg-gray-50 transition-colors">
            Cancel
          </button>
        </div>
      </div>
    </div>
    </>
  )
}

// ── Issue Fix Modal ───────────────────────────────────────────────────────────
// Pre-populated custom fix modal for a specific quality issue. Mirrors
// CreateManualFixModal but skips the table/field selectors (already known from
// the issue) and marks the linked quality_issue as fixed after applying.

function IssueFixModal({
  issue,
  projectId,
  onClose,
  onFixApplied,
  isArchived = false,
  canEdit = true,
}: {
  issue: QualityIssue
  projectId: string
  onClose: () => void
  onFixApplied: (updated: QualityIssue, rowsAffected?: number) => void
  isArchived?: boolean
  canEdit?: boolean
}) {
  const [mode, setMode] = useState<'nl' | 'sql'>('nl')
  const [nlDescription, setNlDescription] = useState('')
  const [generatedSql, setGeneratedSql] = useState('')
  const [sqlText, setSqlText] = useState('')
  const [isGenerating, setIsGenerating] = useState(false)
  const [isApplying, setIsApplying] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [requiresSnapshot, setRequiresSnapshot] = useState(false)

  const tableId = issue.table_id ?? ''
  const fieldId = issue.field_id ?? null

  function handleAISuggest() {
    const desc = issue.description.toLowerCase()
    const field = issue.title.split('.').pop() ?? 'field'
    const count = issue.affected_records

    let suggestion = `Fix ${count} records with ${issue.description.toLowerCase()}`
    if (desc.includes('null') || desc.includes('missing')) {
      suggestion = `Set null ${field} values to a sensible default or remove the ${count} affected rows`
    } else if (desc.includes('orphan') || desc.includes('referential')) {
      suggestion = `Delete the ${count} orphaned records that reference non-existent parent records`
    } else if (desc.includes('duplicate')) {
      suggestion = `Deduplicate records by keeping the most recent entry for each duplicate ${field}`
    } else if (desc.includes('format') || desc.includes('invalid')) {
      suggestion = `Standardize the ${count} ${field} values to match the expected format`
    }
    setNlDescription(suggestion)
  }

  async function handleGenerateSQL() {
    setError(null)
    setGeneratedSql('')
    setIsGenerating(true)
    try {
      const result = await generateManualFix(projectId, tableId, fieldId, nlDescription, {
        title: issue.title,
        description: issue.description,
        severity: issue.severity,
        affectedRecords: issue.affected_records,
      })
      if ('error' in result && result.error) {
        setError(result.error)
      } else {
        setGeneratedSql(result.sql)
      }
    } finally {
      setIsGenerating(false)
    }
  }

  async function handleApply(skipSnapshot = false) {
    setError(null)
    setIsApplying(true)
    setRequiresSnapshot(false)
    try {
      const sql = mode === 'nl' ? generatedSql : sqlText
      const desc =
        mode === 'nl' && nlDescription.trim()
          ? nlDescription
          : `Custom SQL fix for ${issue.title}`

      const result = await applyManualFix(projectId, tableId, sql, desc, skipSnapshot)

      if (result.requiresSnapshotConfirmation) {
        setRequiresSnapshot(true)
        setIsApplying(false)
        return
      }

      if (!result.success) {
        setError(result.error ?? 'Fix failed')
        return
      }

      // Mark the linked quality issue as fixed and link the fix_history row
      const marked = await markIssueFixed(issue.id, result.fixHistoryId)
      if (!marked.success) {
        setError(
          marked.error ??
            'Fix was applied but updating the issue failed. Check Fix History and refresh the page.'
        )
        return
      }

      onFixApplied({ ...issue, status: 'fixed' }, result.rowsAffected)
    } finally {
      setIsApplying(false)
    }
  }

  const canApply = mode === 'nl' ? !!generatedSql : !!sqlText.trim()

  return (
    <>
      {requiresSnapshot && (
        <ConfirmModal
          title="Fix is not reversible"
          message="This fix uses complex SQL that cannot be fully snapshotted. If you apply it, you will NOT be able to revert it automatically. Apply without snapshot?"
          confirmLabel="Apply Without Snapshot"
          loading={isApplying}
          onConfirm={() => handleApply(true)}
          onCancel={() => setRequiresSnapshot(false)}
        />
      )}
      <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
        <div className="bg-white rounded-xl shadow-2xl w-full max-w-xl max-h-[90vh] flex flex-col">
          {/* Header */}
          <div className="flex items-center justify-between p-4 border-b shrink-0">
            <h3 className="font-semibold text-gray-900">Fix Issue</h3>
            <button
              onClick={onClose}
              className="text-gray-400 hover:text-gray-600 text-xl leading-none"
            >
              ×
            </button>
          </div>

          {/* Scrollable body */}
          <div className="flex-1 overflow-y-auto p-4 space-y-4">
            {/* Issue summary (read-only) */}
            <div className="bg-gray-50 rounded-lg p-3 border border-gray-200">
              <div className="flex flex-wrap items-center gap-2 mb-1">
                <span className="font-medium text-sm text-gray-900">{issue.title}</span>
                {issue.severity === 'blocking' ? (
                  <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium bg-red-100 text-red-800 border border-red-200">
                    <span>⊘</span> Blocking
                  </span>
                ) : (
                  <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium bg-amber-100 text-amber-800 border border-amber-200">
                    <span>△</span> Warning
                  </span>
                )}
                {issue.stage === 'source' && (
                  <span className="px-1.5 py-0.5 rounded text-[10px] bg-blue-50 text-blue-700 border border-blue-200">
                    Source
                  </span>
                )}
                {(issue.stage === 'in_flight' || issue.stage === 'target') && (
                  <span className="px-1.5 py-0.5 rounded text-[10px] bg-purple-50 text-purple-700 border border-purple-200">
                    Target-Ready
                  </span>
                )}
              </div>
              <p className="text-sm text-gray-600">{issue.description}</p>
              <p className="text-xs text-gray-400 mt-1">
                Affected records: {issue.affected_records.toLocaleString()}
              </p>
            </div>

            {/* Mode toggle */}
            <div className="flex gap-1 bg-gray-100 rounded-lg p-1">
              <button
                onClick={() => setMode('nl')}
                className={`flex-1 py-1.5 px-3 rounded-md text-sm font-medium transition-colors ${
                  mode === 'nl'
                    ? 'bg-white text-gray-900 shadow-sm'
                    : 'text-gray-500 hover:text-gray-700'
                }`}
              >
                ✦ Natural Language
              </button>
              <button
                onClick={() => setMode('sql')}
                className={`flex-1 py-1.5 px-3 rounded-md text-sm font-medium transition-colors ${
                  mode === 'sql'
                    ? 'bg-white text-gray-900 shadow-sm'
                    : 'text-gray-500 hover:text-gray-700'
                }`}
              >
                SQL Editor
              </button>
            </div>

            {/* NL mode */}
            {mode === 'nl' && (
              <>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">
                    Describe your fix
                  </label>
                  <textarea
                    value={nlDescription}
                    onChange={(e) => setNlDescription(e.target.value)}
                    className="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm resize-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                    rows={3}
                    placeholder={`e.g., "Delete the ${issue.affected_records} orphaned records" or "Set null values to a default"`}
                  />
                </div>

                <div className="flex items-center gap-2 flex-wrap">
                  <button
                    onClick={handleAISuggest}
                    className="px-3 py-1.5 text-sm text-gray-600 hover:text-gray-900 border border-gray-200 rounded-lg flex items-center gap-1.5 hover:bg-gray-50"
                  >
                    ✦ AI Suggest
                  </button>
                  <button
                    onClick={handleGenerateSQL}
                    disabled={!nlDescription.trim() || isGenerating}
                    className="px-4 py-1.5 text-sm bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:opacity-50"
                  >
                    {isGenerating ? 'Generating…' : 'Generate SQL'}
                  </button>
                  {nlDescription && (
                    <button
                      onClick={() => {
                        setNlDescription('')
                        setGeneratedSql('')
                      }}
                      className="text-sm text-gray-400 hover:text-gray-600"
                    >
                      Clear
                    </button>
                  )}
                </div>

                {generatedSql && (
                  <div className="bg-gray-900 rounded-lg p-3">
                    <div className="flex justify-between items-center mb-2">
                      <span className="text-xs text-gray-400">Generated SQL</span>
                      <button
                        onClick={() => {
                          setSqlText(generatedSql)
                          setMode('sql')
                        }}
                        className="text-xs text-blue-400 hover:text-blue-300"
                      >
                        Edit SQL →
                      </button>
                    </div>
                    <pre className="text-sm text-green-400 font-mono whitespace-pre-wrap overflow-x-auto">
                      {generatedSql}
                    </pre>
                  </div>
                )}
              </>
            )}

            {/* SQL mode */}
            {mode === 'sql' && (
              <>
                <textarea
                  value={sqlText}
                  onChange={(e) => setSqlText(e.target.value)}
                  className="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm font-mono resize-none bg-gray-50 focus:ring-2 focus:ring-blue-500"
                  rows={7}
                  placeholder={`UPDATE data_rows\nSET row_data = ...\nWHERE table_id = '${tableId}'\nAND ...`}
                />
              </>
            )}

            {error && (
              <div className="bg-red-50 border border-red-200 rounded-lg p-3 text-sm text-red-700">
                {error}
              </div>
            )}

          </div>

          {/* Footer */}
          <div className="p-4 border-t shrink-0 flex justify-end gap-2">
            <button
              onClick={onClose}
              className="px-4 py-2 text-sm font-medium text-gray-700 bg-white border border-gray-300 rounded-lg hover:bg-gray-50 transition-colors"
            >
              Cancel
            </button>
            {!isArchived && (
              <RoleTooltip allowed={canEdit} requiredRole="Editor">
                <button
                  onClick={() => handleApply()}
                  disabled={isApplying || !canApply || !canEdit}
                  className="px-4 py-2 text-sm bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:opacity-50 flex items-center gap-2"
                >
                  {isApplying && (
                    <span className="w-3.5 h-3.5 border-2 border-white/30 border-t-white rounded-full animate-spin" />
                  )}
                  {isApplying ? 'Applying…' : 'Apply Fix'}
                </button>
              </RoleTooltip>
            )}
          </div>
        </div>
      </div>
    </>
  )
}

// ── Main Component ────────────────────────────────────────────────────────────

export default function DataQualityContent({
  projectId,
  projectName,
  initialIssues,
  initialReadiness,
  initialRules,
  hasMappings,
  allDatasets,
  initialFixHistory,
  resolvedSourceFieldIds,
  initialFilterTableId,
  initialFilterFieldId,
  initialFilterSeverity,
  initialFilterStatus,
  initialFilterStage,
  isArchived = false,
}: Props) {
  const router = useRouter()
  const { can: canRole } = useProjectRole(projectId)
  const canEdit = canRole('edit')
  const [issues, setIssues] = useState<QualityIssue[]>(initialIssues)
  const [readiness, setReadiness] = useState<ReadinessScore>(initialReadiness)
  const [rules, setRules] = useState<ValidationRule[]>(initialRules)
  const [fixHistory, setFixHistory] = useState<FixHistory[]>(initialFixHistory ?? [])
  const [scanning, startScan] = useTransition()
  const [isRestaging, startRestaging] = useTransition()
  const [showAddRule, setShowAddRule] = useState(false)
  const [showHistory, setShowHistory] = useState(false)
  const [showCreateFix, setShowCreateFix] = useState(false)
  const [scanError, setScanError] = useState<string | null>(null)
  const [scanWarnings, setScanWarnings] = useState<string[]>([])
  const [scanToast, setScanToast] = useState<string | null>(null)
  const [stagingToast, setStagingToast] = useState<string | null>(null)
  // Shown after a fix is applied to remind the user staged data is now outdated
  const [fixAppliedNote, setFixAppliedNote] = useState(false)
  const issueRefs = useRef<Record<string, HTMLDivElement>>({})

  // ── Filter state ─────────────────────────────────────────────────────────
  const validSeverities = ['all', 'blocking', 'warning'] as const
  const validStatuses = ['all', 'open', 'fixed', 'accepted_risk'] as const

  const [filterSeverity, setFilterSeverity] = useState<'all' | 'blocking' | 'warning'>(
    validSeverities.includes(initialFilterSeverity as 'all' | 'blocking' | 'warning')
      ? (initialFilterSeverity as 'all' | 'blocking' | 'warning')
      : 'all'
  )
  const [filterTableId, setFilterTableId] = useState<string>(initialFilterTableId ?? 'all')
  const [filterStatus, setFilterStatus] = useState<'all' | 'open' | 'fixed' | 'accepted_risk'>(
    validStatuses.includes(initialFilterStatus as 'all' | 'open' | 'fixed' | 'accepted_risk')
      ? (initialFilterStatus as 'all' | 'open' | 'fixed' | 'accepted_risk')
      : 'open'
  )
  const [filterRootCause, setFilterRootCause] = useState<'all' | 'source_data' | 'transform_error' | 'missing_transform'>('all')
  const [searchQuery, setSearchQuery] = useState('')
  const [expandedTables, setExpandedTables] = useState<Set<string>>(new Set())

  // ── Derived data ─────────────────────────────────────────────────────────

  // All target tables from allDatasets
  const targetTables = useMemo(
    () => allDatasets.filter(d => d.role === 'target').flatMap(d => d.tables),
    [allDatasets]
  )

  // Table name lookup (all tables, used in filter dropdowns and verified fixes)
  const tableNameById = useMemo(
    () => new Map<string, string>(allDatasets.flatMap(ds => ds.tables.map(t => [t.id, t.name]))),
    [allDatasets]
  )

  // In-flight issues only (source issues live in Data Profiling)
  const inFlightIssues = useMemo(
    () => issues.filter(i => i.stage === 'in_flight'),
    [issues]
  )

  // Target tables that have at least one in-flight issue = considered staged/validated
  const stagedTargetTableIds = useMemo(
    () => new Set(inFlightIssues.map(i => i.table_id).filter(Boolean) as string[]),
    [inFlightIssues]
  )

  // Unstaged target tables (no in-flight issues recorded yet)
  const unstagedTables = useMemo(
    () => targetTables.filter(t => !stagedTargetTableIds.has(t.id)),
    [targetTables, stagedTargetTableIds]
  )

  // Readiness counts (in-flight open issues only)
  const { inFlightBlocking, inFlightWarning } = useMemo(() => {
    const open = inFlightIssues.filter(i => i.status === 'open')
    return {
      inFlightBlocking: open.filter(i => i.severity === 'blocking').length,
      inFlightWarning: open.filter(i => i.severity === 'warning').length,
    }
  }, [inFlightIssues])

  // Table groups: in-flight issues grouped by target table, with filters applied
  const statusOrder: Record<string, number> = { open: 0, fixed: 1, accepted_risk: 2 }

  const sortFn = (a: QualityIssue, b: QualityIssue) => {
    const aOrder = statusOrder[a.status] ?? 0
    const bOrder = statusOrder[b.status] ?? 0
    if (aOrder !== bOrder) return aOrder - bOrder
    if (a.severity !== b.severity) return a.severity === 'blocking' ? -1 : 1
    return (b.affected_records ?? 0) - (a.affected_records ?? 0)
  }

  interface TableGroup {
    tableId: string
    tableName: string
    isStaged: boolean
    blocking: number
    warnings: number
    issues: QualityIssue[]
  }

  const tableGroups = useMemo<TableGroup[]>(() => {
    const issuesByTable = new Map<string, QualityIssue[]>()
    for (const issue of inFlightIssues) {
      if (!issue.table_id) continue
      // Apply filters
      if (filterSeverity !== 'all' && issue.severity !== filterSeverity) continue
      if (filterTableId !== 'all' && issue.table_id !== filterTableId) continue
      if (filterStatus !== 'all' && issue.status !== filterStatus) continue
      if (filterRootCause !== 'all') {
        const bd = issue.root_cause_breakdown
        if (!bd || (bd[filterRootCause] ?? 0) === 0) continue
      }
      if (searchQuery.trim()) {
        const q = searchQuery.toLowerCase()
        const fieldPart = (issue.title ?? '').split('.').pop()?.toLowerCase() ?? ''
        if (!fieldPart.includes(q) && !(issue.description ?? '').toLowerCase().includes(q)) continue
      }
      const list = issuesByTable.get(issue.table_id) ?? []
      list.push(issue)
      issuesByTable.set(issue.table_id, list)
    }

    return targetTables.map(t => {
      const tableIssues = (issuesByTable.get(t.id) ?? []).sort(sortFn)
      return {
        tableId: t.id,
        tableName: t.name,
        isStaged: stagedTargetTableIds.has(t.id),
        blocking: tableIssues.filter(i => i.severity === 'blocking').length,
        warnings: tableIssues.filter(i => i.severity === 'warning').length,
        issues: tableIssues,
      }
    })
  }, [inFlightIssues, targetTables, stagedTargetTableIds, filterSeverity, filterTableId, filterStatus, filterRootCause, searchQuery])

  // Tables with issues visible after filtering (for "no results" detection)
  const tablesWithVisibleIssues = tableGroups.filter(g => g.isStaged && g.issues.length > 0)

  // Flat filtered list for verified-fixes section (uses all issues)
  const filteredIssues = useMemo(() => {
    return inFlightIssues.filter(issue => {
      if (filterSeverity !== 'all' && issue.severity !== filterSeverity) return false
      if (filterTableId !== 'all' && issue.table_id !== filterTableId) return false
      if (filterStatus !== 'all' && issue.status !== filterStatus) return false
      return true
    }).sort(sortFn)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [inFlightIssues, filterSeverity, filterTableId, filterStatus])

  const hasActiveFilters =
    filterSeverity !== 'all' || filterTableId !== 'all' || filterStatus !== 'open' ||
    filterRootCause !== 'all' || searchQuery.trim() !== ''

  // Tables that appear in in-flight issues (for Table filter dropdown)
  const tablesWithIssues = useMemo(
    () =>
      [...new Set(inFlightIssues.filter(i => i.table_id).map(i => i.table_id!))]
        .map(id => ({ id, name: tableNameById.get(id) ?? id }))
        .sort((a, b) => a.name.localeCompare(b.name)),
    [inFlightIssues, tableNameById]
  )

  // ── Verified fixes (fix_history reconciliation) ───────────────────────────
  // fix_history entries where quality_issue_id IS NULL mean the original issue
  // row was deleted by a rescan — i.e., the fix was applied and then the data
  // was rescanned.  These no longer appear in quality_issues, so they're
  // invisible in the normal issue list.  We surface them separately.
  const verifiedFixes = useMemo<VerifiedFix[]>(
    () => getVerifiedFixes(fixHistory),
    [fixHistory]
  )

  // Apply the table filter to verified fixes (no stage/severity applicable)
  const filteredVerifiedFixes = useMemo<VerifiedFix[]>(() => {
    if (filterTableId !== 'all') {
      return verifiedFixes.filter((f) => f.tableId === filterTableId)
    }
    return verifiedFixes
  }, [verifiedFixes, filterTableId])

  function resetFilters() {
    setFilterSeverity('all')
    setFilterTableId('all')
    setFilterStatus('open')
    setFilterRootCause('all')
    setSearchQuery('')
  }

  function toggleTable(tableId: string) {
    setExpandedTables(prev => {
      const next = new Set(prev)
      if (next.has(tableId)) next.delete(tableId)
      else next.add(tableId)
      return next
    })
  }

  function showToast(msg: string) {
    setScanToast(msg)
    setTimeout(() => setScanToast(null), 3500)
  }

  function handleRegenerateStagedData() {
    setStagingToast(null)
    startRestaging(async () => {
      const result = await stageAllData(projectId)
      if (result.success) {
        const total = result.tables.reduce((s, t) => s + t.rowCount, 0)
        setStagingToast(`Staged data regenerated — ${total.toLocaleString()} rows across ${result.tables.length} table(s)`)
        setFixAppliedNote(false)
        setTimeout(() => setStagingToast(null), 4000)
      } else {
        setStagingToast(`Staging failed: ${result.error ?? 'Unknown error'}`)
        setTimeout(() => setStagingToast(null), 5000)
      }
    })
  }

  async function handleIssueUpdate(updated: QualityIssue) {
    setIssues(prev => prev.map(i => i.id === updated.id ? updated : i))
    const [newScore, freshHistory] = await Promise.all([
      computeReadinessScore(projectId),
      // Refresh fix history so IssueCards immediately show the new fix summary
      getFixHistory(projectId),
    ])
    setReadiness(newScore)
    setFixHistory(freshHistory)
    // Show stale-staging reminder when a source fix was just applied
    if (updated.status === 'fixed' && updated.stage === 'source' && hasMappings) {
      setFixAppliedNote(true)
    }
  }

  function handleRunFullScan() {
    setScanError(null)
    setScanWarnings([])
    startScan(async () => {
      const res = await runFullScan(projectId)
      if (!res.success) {
        setScanError(res.error ?? 'Scan failed')
        return
      }
      const [freshIssues, freshScore] = await Promise.all([
        getQualityIssues(projectId),
        computeReadinessScore(projectId),
      ])
      setIssues(freshIssues.issues)
      setReadiness(freshScore)
      if (res.warnings && res.warnings.length > 0) {
        setScanWarnings(res.warnings)
      }
      const staleNote = hasMappings
        ? ' · Regenerate staged data for accurate target-ready validation.'
        : ''
      const warnNote =
        res.warnings && res.warnings.length > 0
          ? ` · ${res.warnings.length} warning${res.warnings.length !== 1 ? 's' : ''}`
          : ''
      showToast(`Scan complete — ${res.issueCount} open issues found${staleNote}${warnNote}`)
    })
  }

  function scrollToIssue(issueId: string) {
    setFilterStatus('open')
    // Expand all table groups so the issue is visible
    setExpandedTables(prev => {
      const next = new Set(prev)
      targetTables.forEach(t => next.add(t.id))
      return next
    })
    setTimeout(() => {
      issueRefs.current[issueId]?.scrollIntoView({ behavior: 'smooth', block: 'center' })
    }, 100)
  }

  return (
    <div className="flex-1 bg-gray-50 flex flex-col min-h-0">
      {showAddRule && (
        <AddRuleModal
          projectId={projectId}
          allDatasets={allDatasets}
          onClose={() => setShowAddRule(false)}
          onAdded={r => { setRules(prev => [r, ...prev]); setShowAddRule(false) }}
        />
      )}
      {showHistory && (
        <FixHistoryPanel
          projectId={projectId}
          onClose={() => setShowHistory(false)}
          onIssueReverted={async () => {
            const { issues: fresh } = await getQualityIssues(projectId)
            setIssues(fresh)
          }}
        />
      )}
      {showCreateFix && (
        <CreateManualFixModal
          projectId={projectId}
          allDatasets={allDatasets}
          onClose={() => setShowCreateFix(false)}
          isArchived={isArchived}
          canEdit={canEdit}
          onApplied={async () => {
            showToast('Manual fix applied — view it in Fix History')
          }}
        />
      )}

      {/* Page Header */}
      <PageHeader projectName={projectName} title="Validate" subtitle="Data quality monitoring and migration readiness">
        <div className="flex items-center gap-2 flex-shrink-0">
          <button
            onClick={() => setShowHistory(true)}
            className="bg-slate-50 border border-slate-200 text-slate-500 font-medium hover:bg-slate-100 rounded-lg px-4 py-2 text-sm"
          >
            Fix History
          </button>
          <button
            onClick={() => setShowAddRule(true)}
            className="bg-white border border-slate-200 text-slate-700 font-medium hover:bg-slate-50 hover:border-slate-300 rounded-lg px-4 py-2 text-sm"
          >
            + Add Rule
          </button>
          <button
            onClick={() => setShowCreateFix(true)}
            className="bg-white border border-slate-200 text-slate-700 font-medium hover:bg-slate-50 hover:border-slate-300 rounded-lg px-4 py-2 text-sm"
          >
            + Create Fix
          </button>
          <button
            onClick={handleRegenerateStagedData}
            disabled={isRestaging || scanning}
            className="bg-slate-50 border border-slate-200 text-slate-500 font-medium hover:bg-slate-100 rounded-lg px-4 py-2 text-sm disabled:opacity-50 flex items-center gap-1.5"
            title="Re-apply saved transformations to generate fresh staged data for target-ready validation"
          >
            {isRestaging ? (
              <><span className="w-3 h-3 border-2 border-slate-400/30 border-t-slate-600 rounded-full animate-spin" />Staging…</>
            ) : (
              '↻ Regenerate Staged Data'
            )}
          </button>
          {!isArchived && (
            <RoleTooltip allowed={canEdit} requiredRole="Editor">
              <button
                onClick={canEdit ? handleRunFullScan : undefined}
                disabled={scanning || isRestaging || !canEdit}
                className="px-4 py-1.5 text-sm bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:opacity-50 flex items-center gap-2"
              >
                {scanning ? <><span className="w-3.5 h-3.5 border-2 border-white/30 border-t-white rounded-full animate-spin" />Scanning…</> : '⊙ Run Full Scan'}
              </button>
            </RoleTooltip>
          )}
        </div>
      </PageHeader>

      <div className="flex-1 overflow-auto">
        <div className="p-6 space-y-6 max-w-5xl mx-auto">

          {/* Notifications */}
          {scanError && (
            <div className="bg-red-50 border border-red-200 rounded-lg px-4 py-3 text-sm text-red-700">{scanError}</div>
          )}
          {scanWarnings.length > 0 && (
            <div className="bg-amber-50 border border-amber-200 rounded-lg p-4">
              <div className="flex items-start justify-between">
                <div>
                  <h4 className="text-sm font-medium text-amber-800 mb-1">
                    Scan completed with {scanWarnings.length} warning{scanWarnings.length !== 1 ? 's' : ''}
                  </h4>
                  <ul className="text-sm text-amber-700 space-y-1">
                    {scanWarnings.map((w, i) => (
                      <li key={i} className="flex items-start gap-2">
                        <span className="text-amber-500 mt-0.5">⚠</span>
                        <span>{w}</span>
                      </li>
                    ))}
                  </ul>
                </div>
                <button
                  onClick={() => setScanWarnings([])}
                  className="text-amber-400 hover:text-amber-600 text-lg leading-none ml-4 flex-shrink-0"
                >
                  ×
                </button>
              </div>
            </div>
          )}
          {scanToast && (
            <div className="bg-green-50 border border-green-200 rounded-lg px-4 py-3 text-sm text-green-700">{scanToast}</div>
          )}
          {stagingToast && (
            <div className={`border rounded-lg px-4 py-3 text-sm ${stagingToast.startsWith('Staging failed') ? 'bg-red-50 border-red-200 text-red-700' : 'bg-violet-50 border-violet-200 text-violet-800'}`}>{stagingToast}</div>
          )}
          {fixAppliedNote && (
            <div className="bg-amber-50 border border-amber-200 rounded-lg px-4 py-3 flex items-start gap-3">
              <span className="text-amber-600 text-base leading-none mt-0.5 flex-shrink-0">ℹ</span>
              <div className="flex-1 min-w-0 text-sm text-amber-800">
                <span className="font-medium">Fix applied — staged data may now be outdated.</span>
                {' '}Go to the <strong>Transform</strong> tab and click{' '}
                <strong>"Stage All Data"</strong> to re-apply transforms with the fixed source data.
              </div>
              <button
                onClick={() => setFixAppliedNote(false)}
                className="text-amber-500 hover:text-amber-700 text-lg leading-none flex-shrink-0"
                aria-label="Dismiss"
              >
                ×
              </button>
            </div>
          )}

          {/* ── Migration Readiness Banner ── */}
          <div className="bg-white border border-gray-200 rounded-xl px-5 py-4 shadow-sm">
            <h2 className="text-sm font-semibold text-slate-900 mb-1.5">Migration Readiness</h2>
            <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-sm">
              {inFlightBlocking > 0 ? (
                <span className="text-red-600 font-medium">{inFlightBlocking} blocking</span>
              ) : (
                <span className="text-green-600 font-medium flex items-center gap-1">
                  <CheckCircle className="w-4 h-4" /> No blocking issues
                </span>
              )}
              <span className="text-slate-300">·</span>
              <span className={inFlightWarning > 0 ? 'text-amber-600' : 'text-slate-400'}>
                {inFlightWarning} warning{inFlightWarning !== 1 ? 's' : ''}
              </span>
              <span className="text-slate-300">·</span>
              <span className="text-slate-500">
                {stagedTargetTableIds.size} of {targetTables.length} table{targetTables.length !== 1 ? 's' : ''} staged
              </span>
            </div>
            {unstagedTables.length > 0 && (
              <p className="text-xs text-slate-400 mt-1.5">
                Not yet staged: {unstagedTables.map(t => t.name).join(', ')}
              </p>
            )}
          </div>

          {/* ── Active Validation Rules ── */}
          {rules.length > 0 && (
            <details className="bg-white rounded-xl border border-gray-200 shadow-sm">
              <summary className="cursor-pointer px-5 py-3 flex items-center justify-between text-sm font-medium text-gray-700 hover:bg-gray-50 rounded-xl">
                <span>Active Validation Rules ({rules.length})</span>
                <span className="text-gray-400 text-xs">Click to expand</span>
              </summary>
              <div className="px-5 pb-4 space-y-2 border-t pt-3">
                {rules.map(rule => (
                  <div key={rule.id} className="flex items-center justify-between text-sm py-1.5 px-2 -mx-2 rounded border-b border-gray-100 last:border-0 hover:bg-gray-50 cursor-default">
                    <div className="flex items-center gap-2 min-w-0">
                      <span className={`shrink-0 text-xs px-2 py-0.5 rounded-full ${rule.severity === 'blocking' ? 'bg-red-100 text-red-700' : 'bg-amber-100 text-amber-700'}`}>
                        {rule.severity}
                      </span>
                      <span className="font-medium text-gray-900 truncate">
                        {rule.table_id && tableNameById.get(rule.table_id) ? (
                          <><span className="text-gray-400">{tableNameById.get(rule.table_id)}.</span>{rule.name}</>
                        ) : rule.name}
                      </span>
                      <span className="text-gray-400 text-xs truncate">{rule.rule_type}</span>
                      {rule.is_ai_generated && (
                        <span title={rule.ai_original_prompt ?? ''} className="text-xs px-1.5 py-0.5 rounded bg-blue-50 text-blue-700 border border-blue-100">✦ AI</span>
                      )}
                    </div>
                    <div className="flex items-center gap-2 shrink-0">
                      <button
                        onClick={async () => {
                          if (!rule.table_id) return
                          await executeCustomRules(projectId, rule.table_id)
                          const [freshIssues, freshScore] = await Promise.all([
                            getQualityIssues(projectId),
                            computeReadinessScore(projectId),
                          ])
                          setIssues(freshIssues.issues)
                          setReadiness(freshScore)
                        }}
                        className="text-xs text-blue-600 hover:text-blue-800 underline"
                      >
                        Run
                      </button>
                      <button
                        onClick={async () => {
                          await deleteValidationRule(rule.id)
                          setRules(prev => prev.filter(r => r.id !== rule.id))
                        }}
                        className="text-xs text-red-400 hover:text-red-600"
                      >
                        Delete
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            </details>
          )}

          {/* ── Filter Bar ── */}
          <div className="bg-white rounded-xl border border-gray-200 shadow-sm px-4 py-3">
            <div className="flex flex-wrap items-center gap-3">
              {/* Severity */}
              <div className="flex items-center gap-2">
                <label className="text-xs font-medium text-gray-500 whitespace-nowrap">Severity</label>
                <Select
                  value={filterSeverity}
                  onValueChange={(val) => setFilterSeverity(val as typeof filterSeverity)}
                >
                  <SelectTrigger className="h-8 text-xs w-[130px]">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">All</SelectItem>
                    <SelectItem value="blocking">Blocking</SelectItem>
                    <SelectItem value="warning">Warning</SelectItem>
                  </SelectContent>
                </Select>
              </div>

              <div className="w-px h-4 bg-gray-200" />

              {/* Root Cause */}
              <div className="flex items-center gap-2">
                <label className="text-xs font-medium text-gray-500 whitespace-nowrap">Root Cause</label>
                <Select
                  value={filterRootCause}
                  onValueChange={(val) => setFilterRootCause(val as typeof filterRootCause)}
                >
                  <SelectTrigger className="h-8 text-xs w-[160px]">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">All Root Causes</SelectItem>
                    <SelectItem value="source_data">Source Data</SelectItem>
                    <SelectItem value="transform_error">Transform Error</SelectItem>
                    <SelectItem value="missing_transform">Missing Transform</SelectItem>
                  </SelectContent>
                </Select>
              </div>

              <div className="w-px h-4 bg-gray-200" />

              {/* Status */}
              <div className="flex items-center gap-2">
                <label className="text-xs font-medium text-gray-500 whitespace-nowrap">Status</label>
                <Select
                  value={filterStatus}
                  onValueChange={(val) => setFilterStatus(val as typeof filterStatus)}
                >
                  <SelectTrigger className="h-8 text-xs w-[130px]">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="open">Open</SelectItem>
                    <SelectItem value="all">All</SelectItem>
                    <SelectItem value="fixed">Fixed</SelectItem>
                    <SelectItem value="accepted_risk">Accepted Risk</SelectItem>
                  </SelectContent>
                </Select>
              </div>

              <div className="w-px h-4 bg-gray-200" />

              {/* Search */}
              <input
                type="text"
                placeholder="Search by field…"
                value={searchQuery}
                onChange={e => setSearchQuery(e.target.value)}
                className="h-8 text-xs border border-gray-200 rounded-md px-3 w-44 focus:outline-none focus:ring-1 focus:ring-blue-400"
              />

              <div className="ml-auto flex items-center gap-3">
                <span className="text-sm text-gray-500">
                  {tablesWithVisibleIssues.length > 0
                    ? <><span className="font-medium text-gray-700">{tablesWithVisibleIssues.reduce((s, g) => s + g.issues.length, 0)}</span> issues in {tablesWithVisibleIssues.length} table{tablesWithVisibleIssues.length !== 1 ? 's' : ''}</>
                    : 'No matching issues'}
                </span>
                {hasActiveFilters && (
                  <button
                    onClick={resetFilters}
                    className="text-xs text-blue-600 hover:text-blue-800 hover:underline"
                  >
                    Reset filters
                  </button>
                )}
              </div>
            </div>
          </div>

          {/* ── Table-Grouped Issue List ── */}
          {targetTables.length === 0 ? (
            <div className="bg-white rounded-xl border border-gray-200 shadow-sm p-10 text-center">
              <p className="text-sm text-gray-500">No target tables found. Add a target schema to begin validation.</p>
            </div>
          ) : tablesWithVisibleIssues.length === 0 && tableGroups.every(g => !g.isStaged || g.issues.length === 0) && hasActiveFilters ? (
            <div className="bg-white rounded-xl border border-gray-200 shadow-sm p-10 text-center">
              <div className="text-3xl mb-3">✓</div>
              <p className="font-medium text-gray-700 mb-1">No issues match your filters</p>
              <p className="text-sm text-gray-500 mb-4">Try adjusting the filters above to see more results.</p>
              <button onClick={resetFilters} className="px-4 py-2 text-sm border border-gray-300 rounded-lg text-gray-600 hover:bg-gray-50">
                Reset filters
              </button>
            </div>
          ) : (
            <div className="space-y-3">
              {tableGroups.map(group => (
                <div key={group.tableId} className="border border-gray-200 rounded-xl overflow-hidden bg-white shadow-sm">
                  {/* Table header — always visible */}
                  <button
                    onClick={() => toggleTable(group.tableId)}
                    className="w-full flex items-center justify-between px-5 py-3 bg-slate-50 hover:bg-slate-100 transition-colors"
                  >
                    <div className="flex items-center gap-3 min-w-0">
                      <ChevronRight className={`h-4 w-4 text-slate-400 flex-shrink-0 transition-transform ${expandedTables.has(group.tableId) ? 'rotate-90' : ''}`} />
                      <span className="text-sm font-semibold text-slate-900 truncate">{group.tableName}</span>
                      {group.isStaged ? (
                        <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-green-100 text-green-700 flex-shrink-0">staged</span>
                      ) : (
                        <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-slate-100 text-slate-500 flex-shrink-0">not staged</span>
                      )}
                    </div>
                    <div className="flex items-center gap-3 text-xs flex-shrink-0 ml-3">
                      {!group.isStaged ? (
                        <span className="text-slate-400">pending</span>
                      ) : group.blocking === 0 && group.warnings === 0 ? (
                        <span className="text-green-600 font-medium">✓ All checks passed</span>
                      ) : (
                        <>
                          {group.blocking > 0 && (
                            <span className="text-red-600 font-medium">{group.blocking} blocking</span>
                          )}
                          {group.warnings > 0 && (
                            <span className="text-amber-600">{group.warnings} warning{group.warnings !== 1 ? 's' : ''}</span>
                          )}
                        </>
                      )}
                    </div>
                  </button>

                  {/* Issue cards — shown when expanded */}
                  {expandedTables.has(group.tableId) && (
                    group.isStaged ? (
                      group.issues.length === 0 ? (
                        <div className="px-5 py-4 text-sm text-green-600 border-t border-gray-100">
                          All validation checks passed for this table.
                        </div>
                      ) : (
                        <div className="divide-y divide-gray-100 border-t border-gray-100">
                          {group.issues.map(issue => (
                            <div
                              key={issue.id}
                              ref={el => { if (el) issueRefs.current[issue.id] = el }}
                              className="px-4 py-3"
                            >
                              <IssueCard
                                issue={issue}
                                onUpdate={handleIssueUpdate}
                                prefetchedFixHistory={fixHistory.length > 0 ? fixHistory : undefined}
                                isArchived={isArchived}
                                canEdit={canEdit}
                              />
                            </div>
                          ))}
                        </div>
                      )
                    ) : (
                      <div className="px-5 py-4 text-xs text-slate-400 border-t border-gray-100">
                        Stage this table&apos;s transforms to run validation checks. Use <strong>↻ Regenerate Staged Data</strong> on the Transform page, then <strong>⊙ Run Full Scan</strong>.
                      </div>
                    )
                  )}
                </div>
              ))}

              {/* ── Verified Fixes section (post-rescan reconciliation) ── */}
              {filteredVerifiedFixes.length > 0 && (
                <VerifiedFixesSection fixes={filteredVerifiedFixes} tableNameById={tableNameById} />
              )}
            </div>
          )}

          {/* Continue to Migration Center CTA */}
          <div className="flex justify-end pb-4">
            <button
              onClick={() => router.push(`/app/projects/${projectId}/outputs`)}
              className="px-5 py-2.5 text-sm bg-blue-600 text-white rounded-lg hover:bg-blue-700 font-medium"
            >
              Continue to Migration Center →
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
