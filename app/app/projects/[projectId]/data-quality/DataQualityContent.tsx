'use client'

import { useState, useEffect, useTransition, useRef, useMemo } from 'react'
import { useRouter } from 'next/navigation'
import type { QualityIssue, FixOption, ReadinessScore, ValidationRule, FixHistory } from '@/lib/types/database'
import { applyFix, acceptRisk, revertFix, runFullScan, getQualityIssues, getFixHistory, markIssueFixed } from '@/lib/actions/quality-fixes'
import { generateFixSuggestions } from '@/lib/quality/fix-engine'
import { addValidationRule, addValidationRuleFromNL, executeCustomRules, deleteValidationRule } from '@/lib/actions/validation-rules'
import { generateManualFix, applyManualFix, previewManualFix } from '@/lib/actions/manual-fix'
import { computeReadinessScore } from '@/lib/quality/readiness-score'
import { CheckCircle } from '@/components/icons'
import { stageAllData } from '@/lib/actions/staging'
import { getVerifiedFixes } from '@/lib/quality/fix-reconciliation'
import type { VerifiedFix } from '@/lib/quality/fix-reconciliation'

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
            className="px-4 py-2 text-sm bg-indigo-600 text-white rounded-lg hover:bg-indigo-700"
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
          <button onClick={onCancel} disabled={loading} className="px-4 py-2 text-sm border border-gray-300 rounded-lg hover:bg-gray-50 disabled:opacity-50">
            Cancel
          </button>
          <button onClick={onConfirm} disabled={loading}
            className="px-4 py-2 text-sm bg-indigo-600 text-white rounded-lg hover:bg-indigo-700 disabled:opacity-50 flex items-center gap-2">
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

// ── Issue Card ────────────────────────────────────────────────────────────────

function IssueCard({
  issue,
  onUpdate,
  prefetchedFixHistory,
}: {
  issue: QualityIssue
  onUpdate: (updated: QualityIssue) => void
  prefetchedFixHistory?: FixHistory[]
}) {
  const [generatingFix, startGenerating] = useTransition()
  const [applyingIdx, setApplyingIdx] = useState<number | null>(null)
  const [reverting, setReverting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [toast, setToast] = useState<string | null>(null)
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

  function showToast(msg: string) {
    setToast(msg)
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
    const res = await acceptRisk(issue.id, riskReason || undefined)
    setShowAcceptModal(false)
    setRiskReason('')
    if (res.success) {
      showToast('Risk accepted')
      onUpdate({ ...issue, status: 'accepted_risk' })
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
              className="w-full text-sm border rounded-lg p-2 h-24 resize-none focus:outline-none focus:ring-2 focus:ring-indigo-500"
            />
            <div className="flex gap-3 justify-end mt-4">
              <button onClick={() => setShowAcceptModal(false)} className="px-4 py-2 text-sm border border-gray-300 rounded-lg hover:bg-gray-50">Cancel</button>
              <button onClick={handleAcceptRisk} className="px-4 py-2 text-sm bg-gray-700 text-white rounded-lg hover:bg-gray-800">Accept Risk</button>
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
                  <span className="px-1.5 py-0.5 rounded text-[10px] bg-indigo-50 text-indigo-700 border border-indigo-200">
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
        {!isFixed && !isAccepted && (
          <div className="mx-4 mb-4 rounded-lg bg-gradient-to-br from-indigo-50 to-blue-50 border border-indigo-200 p-4">
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
                  className="flex items-center gap-2 px-4 py-2 text-sm border border-indigo-400 text-indigo-700 rounded-lg hover:bg-indigo-100 disabled:opacity-50 transition-colors"
                >
                  {generatingFix ? (
                    <><span className="w-3.5 h-3.5 border-2 border-indigo-300 border-t-indigo-600 rounded-full animate-spin" />Generating suggestions…</>
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
                  <div key={idx} className="bg-white rounded-lg border border-indigo-100 p-3 space-y-2">
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
                      <button
                        onClick={() => setConfirmApply({ idx, fix: opt })}
                        disabled={applyingIdx !== null}
                        className="px-3 py-1.5 text-xs bg-indigo-600 text-white rounded-lg hover:bg-indigo-700 disabled:opacity-50 flex items-center gap-1.5"
                      >
                        {applyingIdx === idx && <span className="w-3 h-3 border-2 border-white/30 border-t-white rounded-full animate-spin" />}
                        Apply Fix
                      </button>
                      <button
                        onClick={() => setShowSQL(opt.sql)}
                        className="text-xs text-indigo-600 hover:text-indigo-800 underline"
                      >
                        View SQL
                      </button>
                    </div>
                  </div>
                ))}
                <div className="pt-1 border-t border-indigo-100 flex items-center justify-between gap-3">
                  <div className="flex items-center gap-2">
                    <button
                      onClick={() => setShowCustomFix(true)}
                      className="flex items-center gap-1.5 px-3 py-1.5 text-sm border border-gray-300 text-gray-700 rounded-lg hover:bg-gray-50 transition-colors"
                    >
                      ✎ Write a Custom Fix
                    </button>
                    <button
                      onClick={handleGenerateFix}
                      disabled={generatingFix}
                      className="flex items-center gap-1.5 px-3 py-1.5 text-sm border border-gray-300 text-gray-500 rounded-lg hover:bg-gray-50 disabled:opacity-50 transition-colors"
                      title="Re-generate fix suggestions with latest AI"
                    >
                      {generatingFix ? (
                        <><span className="w-3 h-3 border-2 border-gray-300 border-t-gray-500 rounded-full animate-spin" />Regenerating…</>
                      ) : (
                        <>↻ Regenerate</>
                      )}
                    </button>
                  </div>
                  <button
                    onClick={() => setShowAcceptModal(true)}
                    className="text-sm text-gray-500 hover:text-gray-700 underline"
                  >
                    Accept Risk
                  </button>
                </div>
              </div>
            )}

            {!hasOptions && !generatingFix && (
              <button
                onClick={() => setShowAcceptModal(true)}
                className="mt-2 text-sm text-gray-500 hover:text-gray-700 underline"
              >
                Accept Risk
              </button>
            )}
          </div>
        )}

        {toast && (
          <div className="mx-4 mb-3 px-3 py-2 bg-green-50 text-green-700 text-sm rounded-lg border border-green-200">
            {toast}
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
              <select
                value={selectedTableId}
                onChange={e => { setSelectedTableId(e.target.value); setSelectedFieldId('') }}
                className="text-sm border rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-indigo-500"
              >
                <option value="">Select table…</option>
                {allDatasets.map(ds => (
                  <optgroup key={ds.id} label={`${ds.name} (${ds.role})`}>
                    {ds.tables.map(t => (
                      <option key={t.id} value={t.id}>{t.name}</option>
                    ))}
                  </optgroup>
                ))}
              </select>
              <select
                value={selectedFieldId}
                onChange={e => setSelectedFieldId(e.target.value)}
                disabled={!selectedTableId}
                className="text-sm border rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-indigo-500 disabled:opacity-50"
              >
                <option value="">Select field…</option>
                {selectedTable?.fields.map(f => (
                  <option key={f.id} value={f.id}>{f.name} ({f.data_type})</option>
                ))}
              </select>
            </div>
          </div>

          {/* Step 2: Mode toggle */}
          <div>
            <label className="text-xs font-semibold text-gray-500 uppercase tracking-wide">Step 2: Define Rule</label>
            <div className="mt-1.5 flex rounded-lg border overflow-hidden">
              <button
                onClick={() => setMode('nl')}
                className={`flex-1 text-sm py-2 ${mode === 'nl' ? 'bg-indigo-600 text-white' : 'bg-white text-gray-600 hover:bg-gray-50'}`}
              >
                ✦ Natural Language
              </button>
              <button
                onClick={() => setMode('manual')}
                className={`flex-1 text-sm py-2 ${mode === 'manual' ? 'bg-indigo-600 text-white' : 'bg-white text-gray-600 hover:bg-gray-50'}`}
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
                <div className="bg-indigo-50 rounded-lg border border-indigo-200 p-3 space-y-2 text-sm">
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
                    className="flex-1 px-4 py-2 text-sm bg-indigo-600 text-white rounded-lg hover:bg-indigo-700 disabled:opacity-50 flex items-center justify-center gap-2"
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
                  className="w-full text-sm border rounded-lg p-3 h-24 resize-none focus:outline-none focus:ring-2 focus:ring-indigo-500"
                />
                <button
                  onClick={handleGenerateNL}
                  disabled={loading || !selectedFieldId || !nlPrompt.trim()}
                  className="w-full px-4 py-2 text-sm bg-indigo-600 text-white rounded-lg hover:bg-indigo-700 disabled:opacity-50 flex items-center justify-center gap-2"
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
                className="w-full text-sm border rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-indigo-500"
              />
              <select
                value={manualType}
                onChange={e => { setManualType(e.target.value); setManualConfig({}) }}
                className="w-full text-sm border rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-indigo-500"
              >
                {ruleTypeOptions.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
              </select>

              {/* Dynamic config based on type */}
              {manualType === 'min_value' && (
                <input type="number" placeholder="Minimum value" onChange={e => setManualConfig({ min: Number(e.target.value) })}
                  className="w-full text-sm border rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-indigo-500" />
              )}
              {manualType === 'max_value' && (
                <input type="number" placeholder="Maximum value" onChange={e => setManualConfig({ max: Number(e.target.value) })}
                  className="w-full text-sm border rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-indigo-500" />
              )}
              {manualType === 'max_length' && (
                <input type="number" placeholder="Maximum length" onChange={e => setManualConfig({ max_length: Number(e.target.value) })}
                  className="w-full text-sm border rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-indigo-500" />
              )}
              {manualType === 'min_length' && (
                <input type="number" placeholder="Minimum length" onChange={e => setManualConfig({ min_length: Number(e.target.value) })}
                  className="w-full text-sm border rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-indigo-500" />
              )}
              {manualType === 'regex' && (
                <input placeholder="Regex pattern (e.g. ^[A-Z]{2}\\d{4}$)" onChange={e => setManualConfig({ pattern: e.target.value })}
                  className="w-full text-sm border rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-indigo-500" />
              )}
              {manualType === 'allowed_values' && (
                <input placeholder="Comma-separated values (e.g. Active, Inactive)" onChange={e => setManualConfig({ values: e.target.value.split(',').map(v => v.trim()) })}
                  className="w-full text-sm border rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-indigo-500" />
              )}
              {manualType === 'range' && (
                <div className="grid grid-cols-2 gap-2">
                  <input type="number" placeholder="Min" onChange={e => setManualConfig(c => ({ ...c, min: Number(e.target.value) }))}
                    className="text-sm border rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-indigo-500" />
                  <input type="number" placeholder="Max" onChange={e => setManualConfig(c => ({ ...c, max: Number(e.target.value) }))}
                    className="text-sm border rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-indigo-500" />
                </div>
              )}
              {(manualType === 'date_after' || manualType === 'date_before') && (
                <input type="date" onChange={e => setManualConfig({ date: e.target.value })}
                  className="w-full text-sm border rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-indigo-500" />
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
                className="w-full px-4 py-2 text-sm bg-indigo-600 text-white rounded-lg hover:bg-indigo-700 disabled:opacity-50 flex items-center justify-center gap-2"
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
        <div className="bg-white rounded-xl shadow-2xl w-full max-w-lg h-full max-h-[90vh] flex flex-col">
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
                  <button onClick={() => setShowSQL(entry.fix_sql)} className="text-xs text-indigo-600 underline hover:text-indigo-800">View SQL</button>
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
}: {
  projectId: string
  allDatasets: DatasetStub[]
  onClose: () => void
  onApplied: () => void
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
            <select
              value={tableId}
              onChange={e => { setTableId(e.target.value); setFieldId(''); setGeneratedSql(''); setSqlText(''); setSqlValidated(false) }}
              className="w-full text-sm border rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-indigo-500"
            >
              <option value="">Select table…</option>
              {allDatasets.map(ds => (
                <optgroup key={ds.id} label={`${ds.name} (${ds.role})`}>
                  {ds.tables.map(t => (
                    <option key={t.id} value={t.id}>{t.name}</option>
                  ))}
                </optgroup>
              ))}
            </select>
            {selectedTable && (
              <select
                value={fieldId}
                onChange={e => setFieldId(e.target.value)}
                className="w-full text-sm border rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-indigo-500"
              >
                <option value="">Entire table (all fields)</option>
                {selectedTable.fields.map(f => (
                  <option key={f.id} value={f.id}>{f.name} ({f.inferred_type ?? f.data_type})</option>
                ))}
              </select>
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
                  className={`flex-1 py-2 flex items-center justify-center gap-1.5 transition-colors ${mode === 'nl' ? 'bg-indigo-600 text-white' : 'text-gray-600 hover:bg-gray-50'}`}
                >
                  <span>✦</span> Natural Language
                </button>
                <button
                  onClick={() => handleModeSwitch('sql')}
                  className={`flex-1 py-2 flex items-center justify-center gap-1.5 transition-colors ${mode === 'sql' ? 'bg-indigo-600 text-white' : 'text-gray-600 hover:bg-gray-50'}`}
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
                    className="w-full text-sm border rounded-lg p-3 h-24 resize-none focus:outline-none focus:ring-2 focus:ring-indigo-500 font-normal"
                  />
                  <button
                    onClick={handleGenerateFix}
                    disabled={generating || !nlDescription.trim()}
                    className="w-full px-4 py-2 text-sm bg-indigo-600 text-white rounded-lg hover:bg-indigo-700 disabled:opacity-50 flex items-center justify-center gap-2"
                  >
                    {generating ? (
                      <><span className="w-3.5 h-3.5 border-2 border-white/30 border-t-white rounded-full animate-spin" />Generating fix…</>
                    ) : '✦ Generate Fix'}
                  </button>

                  {/* Generated SQL review panel */}
                  {generatedSql && (
                    <div className="space-y-3 border border-indigo-200 rounded-lg p-3 bg-indigo-50">
                      <p className="text-xs font-semibold text-indigo-700">Generated SQL — Review before applying</p>
                      <pre className="bg-gray-950 text-green-300 rounded-lg p-3 text-xs overflow-x-auto whitespace-pre-wrap font-mono">
                        {generatedSql}
                      </pre>
                      {estimatedRows !== null && (
                        <p className="text-xs text-indigo-700">
                          Estimated rows affected: <strong>{estimatedRows.toLocaleString()}</strong>
                        </p>
                      )}
                      <div className="flex gap-2">
                        <button
                          onClick={() => handleApplyNL()}
                          disabled={isApplying}
                          className="flex-1 px-3 py-1.5 text-sm bg-indigo-600 text-white rounded-lg hover:bg-indigo-700 disabled:opacity-50 flex items-center justify-center gap-2"
                        >
                          {isApplying ? (
                            <><span className="w-3.5 h-3.5 border-2 border-white/30 border-t-white rounded-full animate-spin" />Applying…</>
                          ) : 'Apply Fix'}
                        </button>
                        <button
                          onClick={() => handleModeSwitch('sql')}
                          className="px-3 py-1.5 text-sm border border-indigo-300 text-indigo-700 rounded-lg hover:bg-indigo-100"
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
                    className="w-full text-sm border rounded-lg p-3 h-36 resize-none focus:outline-none focus:ring-2 focus:ring-indigo-500 font-mono"
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
                    <button
                      onClick={() => handleApplySQL()}
                      disabled={!sqlValidated || isApplying}
                      className="flex-1 px-3 py-1.5 text-sm bg-indigo-600 text-white rounded-lg hover:bg-indigo-700 disabled:opacity-50 flex items-center justify-center gap-2"
                    >
                      {isApplying ? (
                        <><span className="w-3.5 h-3.5 border-2 border-white/30 border-t-white rounded-full animate-spin" />Applying…</>
                      ) : 'Apply Fix'}
                    </button>
                  </div>
                </div>
              )}
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="p-4 border-t shrink-0 flex justify-end">
          <button onClick={onClose} className="px-4 py-2 text-sm border border-gray-300 rounded-lg hover:bg-gray-50">
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
}: {
  issue: QualityIssue
  projectId: string
  onClose: () => void
  onFixApplied: (updated: QualityIssue, rowsAffected?: number) => void
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
      await markIssueFixed(issue.id, result.fixHistoryId)

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
                    className="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm resize-none focus:ring-2 focus:ring-indigo-500 focus:border-transparent"
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
                    className="px-4 py-1.5 text-sm bg-indigo-600 text-white rounded-lg hover:bg-indigo-700 disabled:opacity-50"
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
                        className="text-xs text-indigo-400 hover:text-indigo-300"
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
                  className="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm font-mono resize-none bg-gray-50 focus:ring-2 focus:ring-indigo-500"
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
              className="px-4 py-2 text-sm border border-gray-300 rounded-lg hover:bg-gray-50"
            >
              Cancel
            </button>
            <button
              onClick={() => handleApply()}
              disabled={isApplying || !canApply}
              className="px-4 py-2 text-sm bg-indigo-600 text-white rounded-lg hover:bg-indigo-700 disabled:opacity-50 flex items-center gap-2"
            >
              {isApplying && (
                <span className="w-3.5 h-3.5 border-2 border-white/30 border-t-white rounded-full animate-spin" />
              )}
              {isApplying ? 'Applying…' : 'Apply Fix'}
            </button>
          </div>
        </div>
      </div>
    </>
  )
}

// ── Main Component ────────────────────────────────────────────────────────────

export default function DataQualityContent({
  projectId,
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
}: Props) {
  const router = useRouter()
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
  // Collapsed state for the "Resolved by Transform" section in the issue list
  const [showResolvedSection, setShowResolvedSection] = useState(false)
  const issueRefs = useRef<Record<string, HTMLDivElement>>({})

  // ── Filter state — initialized from URL search params when deep-linking ──
  const validStages = ['all', 'source', 'target_ready'] as const
  const validSeverities = ['all', 'blocking', 'warning'] as const
  const validStatuses = ['all', 'open', 'fixed', 'accepted_risk'] as const

  const [filterStage, setFilterStage] = useState<'all' | 'source' | 'target_ready'>(
    validStages.includes(initialFilterStage as 'all' | 'source' | 'target_ready')
      ? (initialFilterStage as 'all' | 'source' | 'target_ready')
      : 'all'
  )
  const [filterSeverity, setFilterSeverity] = useState<'all' | 'blocking' | 'warning'>(
    validSeverities.includes(initialFilterSeverity as 'all' | 'blocking' | 'warning')
      ? (initialFilterSeverity as 'all' | 'blocking' | 'warning')
      : 'all'
  )
  const [filterTableId, setFilterTableId] = useState<string>(initialFilterTableId ?? 'all')
  const [filterFieldId, setFilterFieldId] = useState<string>(initialFilterFieldId ?? 'all')
  const [filterStatus, setFilterStatus] = useState<'all' | 'open' | 'fixed' | 'accepted_risk'>(
    validStatuses.includes(initialFilterStatus as 'all' | 'open' | 'fixed' | 'accepted_risk')
      ? (initialFilterStatus as 'all' | 'open' | 'fixed' | 'accepted_risk')
      : 'open'
  )

  // ── "Resolved by Transform" helpers ──────────────────────────────────────

  // Set of source field IDs that have an approved mapping with a saved transform.
  // Built once from the server-provided prop; refreshed on router.refresh().
  const resolvedFieldIdSet = useMemo(
    () => new Set(resolvedSourceFieldIds ?? []),
    [resolvedSourceFieldIds]
  )

  // Issue types that can NEVER be auto-resolved by transforms — structural
  // problems (missing PKs, orphaned FKs) that a transform expression can't fix.
  function isNeverResolvable(issue: QualityIssue): boolean {
    const desc = (issue.description ?? '').toLowerCase()
    const title = (issue.title ?? '').toLowerCase()
    if (issue.issue_kind === 'null_primary_key') return true
    if (issue.issue_kind === 'orphaned_fk') return true
    if (issue.issue_kind === 'referential_integrity') return true
    // Fallback: description-based heuristics for older issues without issue_kind
    if (desc.includes('null') && (desc.includes('primary key') || desc.includes('primary_key'))) return true
    if (desc.includes('orphan') || title.includes('orphan')) return true
    if (desc.includes('referential') || title.includes('referential')) return true
    return false
  }

  // Returns 'resolved' for source issues whose field has an approved transform.
  // Returns the original severity for everything else (target issues are never touched).
  function getEffectiveState(issue: QualityIssue): 'blocking' | 'warning' | 'resolved' {
    if (issue.stage !== 'source') return issue.severity
    if (isNeverResolvable(issue)) return issue.severity
    if (issue.field_id && resolvedFieldIdSet.has(issue.field_id)) return 'resolved'
    return issue.severity
  }

  // ── Derived data ─────────────────────────────────────────────────────────

  function isTargetReady(stage: string) {
    return stage === 'in_flight' || stage === 'target'
  }

  // Tables that appear in issues (for Table filter dropdown)
  const tableNameById = useMemo(
    () => new Map<string, string>(allDatasets.flatMap(ds => ds.tables.map(t => [t.id, t.name]))),
    [allDatasets]
  )
  const tablesWithIssues = useMemo(
    () =>
      [...new Set(issues.filter(i => i.table_id).map(i => i.table_id!))]
        .map(id => ({ id, name: tableNameById.get(id) ?? id }))
        .sort((a, b) => a.name.localeCompare(b.name)),
    [issues, tableNameById]
  )

  // Stage breakdown for the readiness dashboard (always all open issues).
  // Source counts use getEffectiveState to exclude transform-resolved issues.
  const { sourceOpen, targetReadyOpen, sourceBlocking, sourceWarning, sourceResolved, targetBlocking, targetWarning } =
    useMemo(() => {
      const openIssues = issues.filter(i => i.status === 'open')
      const src = openIssues.filter(i => i.stage === 'source')
      const tgt = openIssues.filter(i => isTargetReady(i.stage))
      return {
        sourceOpen: src,
        targetReadyOpen: tgt,
        sourceBlocking: src.filter(i => getEffectiveState(i) === 'blocking').length,
        sourceWarning: src.filter(i => getEffectiveState(i) === 'warning').length,
        sourceResolved: src.filter(i => getEffectiveState(i) === 'resolved').length,
        targetBlocking: tgt.filter(i => i.severity === 'blocking').length,
        targetWarning: tgt.filter(i => i.severity === 'warning').length,
      }
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [issues, resolvedFieldIdSet])

  // Filtered issues split into unresolved and resolved-by-transform.
  // "Resolved by Transform" issues are source issues whose field has an approved
  // transform — they're shown collapsed at the bottom, separate from open issues.
  const statusOrder: Record<string, number> = { open: 0, fixed: 1, accepted_risk: 2 }

  const { filteredIssues, filteredResolvedIssues } = useMemo(() => {
    const baseFiltered = issues.filter(issue => {
      if (filterStage === 'source' && issue.stage !== 'source') return false
      if (filterStage === 'target_ready' && !isTargetReady(issue.stage)) return false
      if (filterSeverity !== 'all' && issue.severity !== filterSeverity) return false
      if (filterTableId !== 'all' && issue.table_id !== filterTableId) return false
      if (filterFieldId !== 'all' && issue.field_id !== filterFieldId) return false
      if (filterStatus !== 'all' && issue.status !== filterStatus) return false
      return true
    })

    const sortFn = (a: QualityIssue, b: QualityIssue) => {
      const aOrder = statusOrder[a.status] ?? 0
      const bOrder = statusOrder[b.status] ?? 0
      if (aOrder !== bOrder) return aOrder - bOrder
      if (a.severity !== b.severity) return a.severity === 'blocking' ? -1 : 1
      return (b.affected_records ?? 0) - (a.affected_records ?? 0)
    }

    // Separate resolved (source + transform exists + still open) from everything else.
    // Only open source issues can be "resolved by transform" — already-fixed/accepted
    // issues stay in their normal bucket.
    const unresolved: QualityIssue[] = []
    const resolved: QualityIssue[] = []

    for (const issue of baseFiltered) {
      if (
        issue.status === 'open' &&
        issue.stage === 'source' &&
        getEffectiveState(issue) === 'resolved'
      ) {
        resolved.push(issue)
      } else {
        unresolved.push(issue)
      }
    }

    return {
      filteredIssues: unresolved.sort(sortFn),
      filteredResolvedIssues: resolved.sort((a, b) =>
        (b.affected_records ?? 0) - (a.affected_records ?? 0)
      ),
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [issues, filterStage, filterSeverity, filterTableId, filterFieldId, filterStatus, resolvedFieldIdSet])

  const hasActiveFilters =
    filterStage !== 'all' || filterSeverity !== 'all' || filterTableId !== 'all' || filterFieldId !== 'all' || filterStatus !== 'open'

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

  const totalVisibleIssues = filteredIssues.length + filteredResolvedIssues.length +
    (filterStatus === 'fixed' || filterStatus === 'all' ? filteredVerifiedFixes.length : 0)

  function resetFilters() {
    setFilterStage('all')
    setFilterSeverity('all')
    setFilterTableId('all')
    setFilterFieldId('all')
    setFilterStatus('open')
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
          onApplied={async () => {
            showToast('Manual fix applied — view it in Fix History')
          }}
        />
      )}

      {/* Page Header */}
      <div className="border-b border-gray-200 bg-white px-6 py-4">
        <div className="flex items-start justify-between">
          <div>
            <h1 className="text-2xl font-semibold text-gray-900">Validate</h1>
            <p className="text-sm text-gray-500 mt-0.5">Data quality monitoring and migration readiness</p>
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={() => setShowHistory(true)}
              className="px-3 py-1.5 text-sm border border-gray-300 rounded-lg text-gray-600 hover:bg-gray-50"
            >
              Fix History
            </button>
            <button
              onClick={() => setShowAddRule(true)}
              className="px-3 py-1.5 text-sm border border-indigo-300 rounded-lg text-indigo-700 hover:bg-indigo-50"
            >
              + Add Rule
            </button>
            <button
              onClick={() => setShowCreateFix(true)}
              className="px-3 py-1.5 text-sm border border-violet-300 rounded-lg text-violet-700 hover:bg-violet-50"
            >
              + Create Fix
            </button>
            <button
              onClick={handleRegenerateStagedData}
              disabled={isRestaging || scanning}
              className="px-3 py-1.5 text-sm border border-violet-300 rounded-lg text-violet-700 hover:bg-violet-50 disabled:opacity-50 flex items-center gap-1.5"
              title="Re-apply saved transformations to generate fresh staged data for target-ready validation"
            >
              {isRestaging ? (
                <><span className="w-3 h-3 border-2 border-violet-400/30 border-t-violet-600 rounded-full animate-spin" />Staging…</>
              ) : (
                '↻ Regenerate Staged Data'
              )}
            </button>
            <button
              onClick={handleRunFullScan}
              disabled={scanning || isRestaging}
              className="px-4 py-1.5 text-sm bg-indigo-600 text-white rounded-lg hover:bg-indigo-700 disabled:opacity-50 flex items-center gap-2"
            >
              {scanning ? <><span className="w-3.5 h-3.5 border-2 border-white/30 border-t-white rounded-full animate-spin" />Scanning…</> : '⊙ Run Full Scan'}
            </button>
          </div>
        </div>
      </div>

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

          {/* ── Migration Readiness Dashboard ── */}
          {(() => {
            const blockingCount = sourceBlocking + targetBlocking
            const warningCount = sourceWarning + targetWarning
            const readyCount = readiness.ready_field_count
            const totalIssueCount = blockingCount + warningCount + readyCount
            const score = readiness.score
            const statusLabel =
              readiness.status === 'ready' ? 'Ready' :
              readiness.status === 'at_risk' ? 'Needs Attention' :
              'Not Ready'
            const statusColor =
              readiness.status === 'ready' ? 'text-green-600' :
              readiness.status === 'at_risk' ? 'text-amber-600' :
              'text-red-600'

            return (
              <div className="bg-white rounded-xl border border-gray-200 shadow-sm px-6 py-5">
                {totalIssueCount === 0 || score === 100 ? (
                  /* ── 100% ready state ── */
                  <>
                    <div className="flex items-center gap-3">
                      <CheckCircle className="w-6 h-6 text-green-600 flex-shrink-0" />
                      <div>
                        <div className="flex items-baseline gap-2">
                          <span className="text-2xl font-semibold text-gray-900">100%</span>
                          <span className="text-sm font-medium text-green-600">Ready</span>
                        </div>
                        <p className="text-sm text-gray-500 mt-0.5">
                          All validation checks passed — migration package is ready to execute
                        </p>
                      </div>
                    </div>
                    <div className="mt-3 h-2 bg-green-500 rounded-full" />
                  </>
                ) : (
                  /* ── Normal summary bar ── */
                  <>
                    <div className="flex flex-wrap items-start justify-between gap-4">
                      {/* Score */}
                      <div className="flex-shrink-0">
                        <div className="flex items-baseline gap-2">
                          <span className="text-3xl font-semibold text-gray-900">{score}%</span>
                          <span className={`text-sm font-medium ${statusColor}`}>{statusLabel}</span>
                        </div>
                        <p className="text-sm text-gray-500 mt-0.5">Migration Readiness</p>
                      </div>

                      {/* Stat counts */}
                      <div className="flex items-center gap-6 flex-wrap">
                        {blockingCount > 0 && (
                          <div className="flex items-center gap-2">
                            <span className="w-2 h-2 rounded-full bg-red-500 flex-shrink-0" />
                            <span className="text-sm font-semibold text-red-700 tabular-nums">{blockingCount}</span>
                            <span className="text-sm text-gray-500">Blocking</span>
                          </div>
                        )}
                        {warningCount > 0 && (
                          <div className="flex items-center gap-2">
                            <span className="w-2 h-2 rounded-full bg-amber-400 flex-shrink-0" />
                            <span className="text-sm font-semibold text-amber-700 tabular-nums">{warningCount}</span>
                            <span className="text-sm text-gray-500">Warnings</span>
                          </div>
                        )}
                        <div className="flex items-center gap-2">
                          <span className="w-2 h-2 rounded-full bg-green-500 flex-shrink-0" />
                          <span className="text-sm font-semibold text-green-700 tabular-nums">{readyCount}</span>
                          <span className="text-sm text-gray-500">Ready</span>
                        </div>
                      </div>
                    </div>

                    {/* Proportional progress bar */}
                    <div className="mt-4 h-2 bg-gray-100 rounded-full overflow-hidden flex">
                      {blockingCount > 0 && (
                        <div
                          className="h-full bg-red-500"
                          style={{ width: `${Math.round((blockingCount / totalIssueCount) * 100)}%` }}
                        />
                      )}
                      {warningCount > 0 && (
                        <div
                          className="h-full bg-amber-400"
                          style={{ width: `${Math.round((warningCount / totalIssueCount) * 100)}%` }}
                        />
                      )}
                      {readyCount > 0 && (
                        <div
                          className="h-full bg-green-500"
                          style={{ width: `${Math.round((readyCount / totalIssueCount) * 100)}%` }}
                        />
                      )}
                    </div>

                    {/* Per-stage breakdown */}
                    <div className="mt-3 flex flex-wrap gap-x-6 gap-y-1 text-xs text-gray-500">
                      <div className="flex items-center gap-1.5">
                        <span className="w-1.5 h-1.5 rounded-full bg-blue-400 shrink-0" />
                        <span>
                          <span className="font-medium text-gray-600">Source:</span>
                          {' '}
                          {sourceBlocking === 0 && sourceWarning === 0 ? (
                            sourceResolved > 0 ? (
                              <span className="text-green-600">{sourceResolved} resolved by transform</span>
                            ) : (
                              <span className="text-green-600">No open issues</span>
                            )
                          ) : (
                            <>
                              {sourceBlocking > 0 && <span className="text-red-500">{sourceBlocking} blocking</span>}
                              {sourceBlocking > 0 && sourceWarning > 0 && ' · '}
                              {sourceWarning > 0 && <span className="text-amber-500">{sourceWarning} warnings</span>}
                              {sourceResolved > 0 && (
                                <span className="text-green-600">
                                  {(sourceBlocking > 0 || sourceWarning > 0) ? ' · ' : ''}
                                  {sourceResolved} resolved
                                </span>
                              )}
                            </>
                          )}
                        </span>
                      </div>
                      <div className="flex items-center gap-1.5">
                        <span className="w-1.5 h-1.5 rounded-full bg-purple-400 shrink-0" />
                        <span>
                          <span className="font-medium text-gray-600">Target-Ready:</span>
                          {' '}
                          {targetBlocking === 0 && targetWarning === 0 ? (
                            <span className="text-green-600">No open issues</span>
                          ) : (
                            <>
                              {targetBlocking > 0 && <span className="text-red-500">{targetBlocking} blocking</span>}
                              {targetBlocking > 0 && targetWarning > 0 && ' · '}
                              {targetWarning > 0 && <span className="text-amber-500">{targetWarning} warnings</span>}
                            </>
                          )}
                        </span>
                      </div>
                    </div>
                  </>
                )}
              </div>
            )
          })()}

          {/* ── Active Validation Rules ── */}
          {rules.length > 0 && (
            <details className="bg-white rounded-xl border border-gray-200 shadow-sm">
              <summary className="cursor-pointer px-5 py-3 flex items-center justify-between text-sm font-medium text-gray-700 hover:bg-gray-50 rounded-xl">
                <span>Active Validation Rules ({rules.length})</span>
                <span className="text-gray-400 text-xs">Click to expand</span>
              </summary>
              <div className="px-5 pb-4 space-y-2 border-t pt-3">
                {rules.map(rule => (
                  <div key={rule.id} className="flex items-center justify-between text-sm py-1.5 border-b border-gray-100 last:border-0">
                    <div className="flex items-center gap-2 min-w-0">
                      <span className={`shrink-0 text-xs px-2 py-0.5 rounded-full ${rule.severity === 'blocking' ? 'bg-red-100 text-red-700' : 'bg-amber-100 text-amber-700'}`}>
                        {rule.severity}
                      </span>
                      <span className="font-medium text-gray-900 truncate">{rule.name}</span>
                      <span className="text-gray-400 text-xs truncate">{rule.rule_type}</span>
                      {rule.is_ai_generated && (
                        <span title={rule.ai_original_prompt ?? ''} className="text-xs px-1.5 py-0.5 rounded bg-indigo-50 text-indigo-700 border border-indigo-100">✦ AI</span>
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
                        className="text-xs text-indigo-600 hover:text-indigo-800 underline"
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
              {/* Stage */}
              <div className="flex items-center gap-2">
                <label className="text-xs font-medium text-gray-500 whitespace-nowrap">Stage</label>
                <select
                  value={filterStage}
                  onChange={e => setFilterStage(e.target.value as typeof filterStage)}
                  className="text-sm border border-gray-200 rounded-lg px-2.5 py-1.5 focus:outline-none focus:ring-2 focus:ring-indigo-500 bg-white"
                >
                  <option value="all">All</option>
                  <option value="source">Source</option>
                  <option value="target_ready">Target-Ready</option>
                </select>
              </div>

              <div className="w-px h-4 bg-gray-200" />

              {/* Severity */}
              <div className="flex items-center gap-2">
                <label className="text-xs font-medium text-gray-500 whitespace-nowrap">Severity</label>
                <select
                  value={filterSeverity}
                  onChange={e => setFilterSeverity(e.target.value as typeof filterSeverity)}
                  className="text-sm border border-gray-200 rounded-lg px-2.5 py-1.5 focus:outline-none focus:ring-2 focus:ring-indigo-500 bg-white"
                >
                  <option value="all">All</option>
                  <option value="blocking">Blocking</option>
                  <option value="warning">Warning</option>
                </select>
              </div>

              <div className="w-px h-4 bg-gray-200" />

              {/* Table */}
              <div className="flex items-center gap-2">
                <label className="text-xs font-medium text-gray-500 whitespace-nowrap">Table</label>
                <select
                  value={filterTableId}
                  onChange={e => setFilterTableId(e.target.value)}
                  className="text-sm border border-gray-200 rounded-lg px-2.5 py-1.5 focus:outline-none focus:ring-2 focus:ring-indigo-500 bg-white"
                >
                  <option value="all">All</option>
                  {tablesWithIssues.map(t => (
                    <option key={t.id} value={t.id}>{t.name}</option>
                  ))}
                </select>
              </div>

              <div className="w-px h-4 bg-gray-200" />

              {/* Status */}
              <div className="flex items-center gap-2">
                <label className="text-xs font-medium text-gray-500 whitespace-nowrap">Status</label>
                <select
                  value={filterStatus}
                  onChange={e => setFilterStatus(e.target.value as typeof filterStatus)}
                  className="text-sm border border-gray-200 rounded-lg px-2.5 py-1.5 focus:outline-none focus:ring-2 focus:ring-indigo-500 bg-white"
                >
                  <option value="open">Open</option>
                  <option value="all">All</option>
                  <option value="fixed">Fixed</option>
                  <option value="accepted_risk">Accepted Risk</option>
                </select>
              </div>

              <div className="ml-auto flex items-center gap-3">
                <span className="text-sm text-gray-500">
                  Showing <span className="font-medium text-gray-700">{totalVisibleIssues}</span> items
                  {filteredResolvedIssues.length > 0 && (
                    <span className="text-green-600 ml-1">
                      · {filteredResolvedIssues.length} resolved by transform
                    </span>
                  )}
                  {(filterStatus === 'fixed' || filterStatus === 'all') && filteredVerifiedFixes.length > 0 && (
                    <span className="text-blue-600 ml-1">
                      · {filteredVerifiedFixes.length} verified fixed
                    </span>
                  )}
                </span>
                {hasActiveFilters && (
                  <button
                    onClick={resetFilters}
                    className="text-xs text-indigo-600 hover:text-indigo-800 hover:underline"
                  >
                    Reset filters
                  </button>
                )}
              </div>
            </div>
          </div>


          {/* ── Target-Ready empty state (contextual) ── */}
          {filterStage === 'target_ready' && targetReadyOpen.length === 0 && (
            <div className="bg-blue-50 border border-blue-200 rounded-xl px-4 py-4 flex items-start gap-3">
              <span className="text-blue-500 mt-0.5 shrink-0">ℹ</span>
              <div className="text-sm text-blue-800">
                <p className="font-medium mb-1">No target-ready issues detected.</p>
                <p>Target-ready checks validate your transformed data against target field constraints. Click <strong>↻ Regenerate Staged Data</strong> to apply transforms, then <strong>⊙ Run Full Scan</strong> to detect issues.</p>
              </div>
            </div>
          )}

          {/* ── Issue List ── */}
          {filteredIssues.length === 0 && filteredResolvedIssues.length === 0 &&
           (filterStatus !== 'fixed' && filterStatus !== 'all' || filteredVerifiedFixes.length === 0) ? (
            <div className="bg-white rounded-xl border border-gray-200 shadow-sm p-10 text-center">
              <div className="text-3xl mb-3">✓</div>
              {hasActiveFilters ? (
                <>
                  <p className="font-medium text-gray-700 mb-1">No issues match your filters</p>
                  <p className="text-sm text-gray-500 mb-4">Try adjusting the filters above to see more results.</p>
                  <button
                    onClick={resetFilters}
                    className="px-4 py-2 text-sm border border-gray-300 rounded-lg text-gray-600 hover:bg-gray-50"
                  >
                    Reset filters
                  </button>
                </>
              ) : (
                <p className="text-sm text-gray-500">No issues detected. Upload a CSV and run a scan to check data quality.</p>
              )}
            </div>
          ) : (
            <div className="space-y-4">
              {filteredIssues.map(issue => (
                <div
                  key={issue.id}
                  ref={el => { if (el) issueRefs.current[issue.id] = el }}
                >
                  <IssueCard
                    issue={issue}
                    onUpdate={handleIssueUpdate}
                    prefetchedFixHistory={fixHistory.length > 0 ? fixHistory : undefined}
                  />
                </div>
              ))}

              {/* ── Verified Fixes section (post-rescan reconciliation) ── */}
              {filteredVerifiedFixes.length > 0 && (
                <VerifiedFixesSection fixes={filteredVerifiedFixes} tableNameById={tableNameById} />
              )}

              {/* ── Resolved by Transform section ── */}
              {filteredResolvedIssues.length > 0 && (
                <div className="bg-white rounded-xl border border-green-200 shadow-sm overflow-hidden">
                  {/* Collapsible header */}
                  <button
                    onClick={() => setShowResolvedSection(v => !v)}
                    className="w-full flex items-center gap-3 px-5 py-3.5 hover:bg-green-50/50 transition-colors text-left"
                  >
                    <span className="w-2 h-2 rounded-full bg-green-500 flex-shrink-0" />
                    <span className="text-sm font-medium text-green-700">
                      Resolved by Transform ({filteredResolvedIssues.length})
                    </span>
                    <span className="text-xs text-gray-400 ml-1">
                      — source issues addressed by an approved transformation
                    </span>
                    <span className="ml-auto text-gray-400 text-xs">
                      {showResolvedSection ? '▼' : '▶'}
                    </span>
                  </button>

                  {/* Expandable rows */}
                  {showResolvedSection && (
                    <div className="border-t border-green-100 divide-y divide-green-50">
                      {filteredResolvedIssues.map(issue => (
                        <div
                          key={issue.id}
                          className="flex items-center gap-3 px-5 py-2.5 bg-green-50/40"
                        >
                          <span className="text-green-500 flex-shrink-0 text-sm">✓</span>
                          <div className="flex-1 min-w-0">
                            <p className="text-sm font-medium text-green-900 truncate">
                              {issue.title}
                            </p>
                            <p className="text-xs text-green-700 truncate">
                              {issue.description}
                              {issue.affected_records > 0 && (
                                <span className="text-green-500 ml-1">
                                  · {issue.affected_records.toLocaleString()} rows
                                </span>
                              )}
                            </p>
                          </div>
                          <span className="flex-shrink-0 text-xs font-medium text-green-600 bg-green-100 border border-green-200 px-2 py-0.5 rounded-full whitespace-nowrap">
                            Transform applied
                          </span>
                          {issue.severity === 'blocking' && (
                            <span className="flex-shrink-0 text-xs text-gray-400 line-through">
                              blocking
                            </span>
                          )}
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )}
            </div>
          )}

          {/* Proceed to Mapping CTA */}
          <div className="flex justify-end pb-4">
            <button
              onClick={() => router.push(`/app/projects/${projectId}/mapping`)}
              className="px-5 py-2.5 text-sm bg-indigo-600 text-white rounded-lg hover:bg-indigo-700 font-medium"
            >
              Proceed to Mapping →
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
