'use client'

import { useState, useMemo, useTransition, useCallback } from 'react'
import { useRouter } from 'next/navigation'
import { Check, Pencil, X, ChevronDown, ChevronRight, ArrowRight, Plus } from '@/components/icons'
import {
  updateFieldMappingStatus,
  editFieldMapping,
  addManualFieldMapping,
  addManualTableMapping,
  deleteFieldMapping,
  deleteTableMapping,
  approveAllFieldMappings,
  rejectAllFieldMappings,
  approveHighConfidenceMappings,
  suggestRemainingMappings,
  mapUnmappedField,
  getMappings,
} from '@/lib/actions/mappings'
import type {
  MappingsResult,
  RichTableMapping,
  RichFieldMapping,
  UnmappedField,
  SimpleField,
} from '@/lib/actions/mappings'

// ─── Props ────────────────────────────────────────────────────────────────────

interface Props {
  projectId: string
  initialData: MappingsResult | null
}

type FilterTab = 'needs_review' | 'high_confidence' | 'unmapped' | 'all'

// ─── Confidence helpers ───────────────────────────────────────────────────────

function cBg(c: number | null) {
  if (c === null) return 'bg-gray-100 text-gray-600'
  if (c >= 75) return 'bg-green-100 text-green-700'
  if (c >= 50) return 'bg-amber-100 text-amber-700'
  return 'bg-red-100 text-red-700'
}
function cDot(c: number | null) {
  if (c === null) return 'bg-gray-400'
  if (c >= 75) return 'bg-green-500'
  if (c >= 50) return 'bg-amber-500'
  return 'bg-red-500'
}
function cBar(c: number | null) {
  if (c === null) return 'bg-gray-300'
  if (c >= 75) return 'bg-green-500'
  if (c >= 50) return 'bg-amber-500'
  return 'bg-red-500'
}
function cText(c: number | null) {
  if (c === null) return 'text-gray-500'
  if (c >= 75) return 'text-green-600'
  if (c >= 50) return 'text-amber-600'
  return 'text-red-600'
}

// ─── Small shared components ──────────────────────────────────────────────────

function ConfidenceBadge({ confidence }: { confidence: number | null }) {
  if (confidence === null) return null
  return <span className={`px-2 py-0.5 text-xs font-semibold rounded-full ${cBg(confidence)}`}>{confidence}%</span>
}

function StatusBadge({ status }: { status: RichTableMapping['status'] }) {
  if (status === 'approved') return <span className="px-2 py-0.5 text-xs font-semibold rounded-full bg-green-50 text-green-700 border border-green-200">Approved</span>
  if (status === 'rejected') return <span className="px-2 py-0.5 text-xs font-semibold rounded-full bg-red-50 text-red-700 border border-red-200">Rejected</span>
  return null
}

// Trash icon inline
function TrashIcon({ className = '' }: { className?: string }) {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={className}>
      <polyline points="3 6 5 6 21 6" /><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2" />
    </svg>
  )
}

// ─── Empty State ──────────────────────────────────────────────────────────────

function EmptyState({ projectId }: { projectId: string }) {
  return (
    <div className="flex flex-col items-center justify-center py-24 text-center">
      <div className="w-16 h-16 rounded-full bg-indigo-50 flex items-center justify-center mb-4">
        <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" className="text-indigo-400">
          <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71" />
          <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71" />
        </svg>
      </div>
      <h3 className="text-lg font-semibold text-gray-900 mb-2">No mappings generated yet</h3>
      <p className="text-sm text-gray-500 mb-6 max-w-xs">Go to Data Overview → Schema Overview, select your source and target tables, then click "Generate Mappings".</p>
      <a href={`/app/projects/${projectId}/data-overview`} className="px-5 py-2.5 text-sm font-medium text-white bg-indigo-600 rounded-lg hover:bg-indigo-700 transition-colors">
        Go to Data Overview
      </a>
    </div>
  )
}

// ─── Mapping Progress Bar ─────────────────────────────────────────────────────

function MappingProgress({ tableMappings, allFieldsByTable }: { tableMappings: RichTableMapping[]; allFieldsByTable: Record<string, SimpleField[]> }) {
  const sourceTableIds = new Set(tableMappings.map((tm) => tm.source_table_id))
  const totalSourceFields = Object.entries(allFieldsByTable)
    .filter(([tid]) => sourceTableIds.has(tid))
    .reduce((sum, [, fields]) => sum + fields.length, 0)

  const allFMs = tableMappings.flatMap((tm) => tm.fieldMappings)
  const approvedCount = allFMs.filter((fm) => fm.status === 'approved').length
  const reviewCount = allFMs.filter((fm) => fm.status === 'needs_review').length
  const mappedTotal = allFMs.length

  if (totalSourceFields === 0) return null

  const approvedPct = totalSourceFields > 0 ? (approvedCount / totalSourceFields) * 100 : 0
  const reviewPct = totalSourceFields > 0 ? (reviewCount / totalSourceFields) * 100 : 0

  return (
    <div className="bg-white border border-gray-200 rounded-xl px-5 py-4">
      <div className="flex items-center justify-between mb-2">
        <span className="text-sm font-medium text-gray-700">Mapping Progress</span>
        <span className="text-sm text-gray-500">
          <span className="font-semibold text-gray-900">{mappedTotal}</span> of{' '}
          <span className="font-semibold text-gray-900">{totalSourceFields}</span> source fields mapped
          {totalSourceFields > 0 && <span className="text-gray-400 ml-1">({Math.round((mappedTotal / totalSourceFields) * 100)}%)</span>}
        </span>
      </div>
      <div className="w-full h-2.5 bg-gray-100 rounded-full overflow-hidden flex">
        <div className="h-full bg-green-500 transition-all" style={{ width: `${approvedPct}%` }} title={`${approvedCount} approved`} />
        <div className="h-full bg-amber-400 transition-all" style={{ width: `${reviewPct}%` }} title={`${reviewCount} needs review`} />
      </div>
      <div className="flex items-center gap-4 mt-2">
        <span className="flex items-center gap-1.5 text-xs text-gray-500"><span className="w-2 h-2 rounded-full bg-green-500" />{approvedCount} approved</span>
        <span className="flex items-center gap-1.5 text-xs text-gray-500"><span className="w-2 h-2 rounded-full bg-amber-400" />{reviewCount} needs review</span>
        <span className="flex items-center gap-1.5 text-xs text-gray-500"><span className="w-2 h-2 rounded-full bg-gray-200" />{totalSourceFields - mappedTotal} unmapped</span>
      </div>
    </div>
  )
}

// ─── Delete Confirm Dialog ────────────────────────────────────────────────────

function DeleteConfirmDialog({
  message,
  onConfirm,
  onCancel,
}: {
  message: string
  onConfirm: () => void
  onCancel: () => void
}) {
  return (
    <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4">
      <div className="bg-white rounded-xl shadow-xl w-full max-w-sm p-6">
        <div className="flex items-start gap-3 mb-5">
          <div className="w-9 h-9 rounded-full bg-red-50 flex items-center justify-center flex-shrink-0">
            <TrashIcon className="text-red-500 w-4 h-4" />
          </div>
          <div>
            <p className="font-semibold text-gray-900 text-sm mb-1">Remove Mapping</p>
            <p className="text-sm text-gray-600">{message}</p>
          </div>
        </div>
        <div className="flex gap-3">
          <button onClick={onCancel} className="flex-1 px-4 py-2.5 text-sm font-medium text-gray-700 border border-gray-200 rounded-lg hover:bg-gray-50">Cancel</button>
          <button onClick={onConfirm} className="flex-1 px-4 py-2.5 text-sm font-medium text-white bg-red-600 rounded-lg hover:bg-red-700">Remove</button>
        </div>
      </div>
    </div>
  )
}

// ─── Add Mapping Modal ────────────────────────────────────────────────────────

function AddMappingModal({
  projectId, allSourceTables, allTargetTables, onClose, onAdded,
}: {
  projectId: string
  allSourceTables: MappingsResult['allSourceTables']
  allTargetTables: MappingsResult['allTargetTables']
  onClose: () => void
  onAdded: () => void
}) {
  const [sourceTableId, setSourceTableId] = useState('')
  const [targetTableId, setTargetTableId] = useState('')
  const [pending, startTransition] = useTransition()
  const [error, setError] = useState<string | null>(null)

  function handleAdd() {
    if (!sourceTableId || !targetTableId) return
    setError(null)
    startTransition(async () => {
      const result = await addManualTableMapping(projectId, sourceTableId, targetTableId)
      if (!result.success) { setError(result.error ?? 'Failed'); return }
      onAdded(); onClose()
    })
  }

  return (
    <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4">
      <div className="bg-white rounded-xl shadow-xl w-full max-w-md">
        <div className="flex items-center justify-between px-6 py-4 border-b border-gray-100">
          <h2 className="font-semibold text-gray-900">Add New Table Mapping</h2>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600"><X className="w-5 h-5" /></button>
        </div>
        <div className="px-6 py-5 space-y-4">
          <div>
            <label className="block text-xs font-medium text-gray-600 mb-1.5">Source Table</label>
            <select value={sourceTableId} onChange={(e) => setSourceTableId(e.target.value)} className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500">
              <option value="">Select source table…</option>
              {allSourceTables.map((t) => <option key={t.id} value={t.id}>{t.datasetName}.{t.name}</option>)}
            </select>
          </div>
          <div>
            <label className="block text-xs font-medium text-gray-600 mb-1.5">Target Table</label>
            <select value={targetTableId} onChange={(e) => setTargetTableId(e.target.value)} className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500">
              <option value="">Select target table…</option>
              {allTargetTables.map((t) => <option key={t.id} value={t.id}>{t.datasetName}.{t.name}</option>)}
            </select>
          </div>
          {error && <p className="text-xs text-red-600">{error}</p>}
        </div>
        <div className="flex gap-3 px-6 py-4 border-t border-gray-100">
          <button onClick={onClose} className="flex-1 px-4 py-2 text-sm font-medium text-gray-700 border border-gray-200 rounded-lg hover:bg-gray-50">Cancel</button>
          <button onClick={handleAdd} disabled={!sourceTableId || !targetTableId || pending} className="flex-1 px-4 py-2 text-sm font-medium text-white bg-indigo-600 rounded-lg hover:bg-indigo-700 disabled:opacity-40">
            {pending ? 'Adding…' : 'Add Mapping'}
          </button>
        </div>
      </div>
    </div>
  )
}

// ─── Inline Add Field Row ─────────────────────────────────────────────────────

function InlineAddFieldRow({
  tm,
  allFieldsByTable,
  onAdded,
  onCancel,
}: {
  tm: RichTableMapping
  allFieldsByTable: Record<string, SimpleField[]>
  onAdded: (newFM: RichFieldMapping) => void
  onCancel: () => void
}) {
  const [srcFieldId, setSrcFieldId] = useState('')
  const [tgtFieldId, setTgtFieldId] = useState('')
  const [pending, startTransition] = useTransition()
  const [error, setError] = useState<string | null>(null)

  const mappedSrcIds = new Set(tm.fieldMappings.map((fm) => fm.source_field_id))
  const mappedTgtIds = new Set(tm.fieldMappings.map((fm) => fm.target_field_id))
  const availSrc = (allFieldsByTable[tm.source_table_id] ?? []).filter((f) => !mappedSrcIds.has(f.id))
  const availTgt = (allFieldsByTable[tm.target_table_id] ?? []).filter((f) => !mappedTgtIds.has(f.id))

  function handleAdd() {
    if (!srcFieldId || !tgtFieldId) return
    setError(null)
    startTransition(async () => {
      const result = await addManualFieldMapping(tm.id, srcFieldId, tgtFieldId)
      if (!result.success) { setError(result.error ?? 'Failed'); return }

      const sf = availSrc.find((f) => f.id === srcFieldId)
      const tf = availTgt.find((f) => f.id === tgtFieldId)
      const newFM: RichFieldMapping = {
        id: result.data!.id,
        table_mapping_id: tm.id,
        source_field_id: srcFieldId,
        target_field_id: tgtFieldId,
        confidence: 100,
        status: 'approved',
        ai_reasoning: 'Manually mapped by user',
        similar_fields_considered: null,
        type_compatibility: null,
        created_at: new Date().toISOString(),
        sourceField: sf ? { id: sf.id, name: sf.name, data_type: sf.data_type, inferred_type: null } : null,
        targetField: tf ? { id: tf.id, name: tf.name, data_type: tf.data_type, inferred_type: null } : null,
        sourceFieldSamples: [],
        targetFieldSamples: [],
      }
      onAdded(newFM)
      setSrcFieldId('')
      setTgtFieldId('')
    })
  }

  if (availSrc.length === 0 || availTgt.length === 0) return null

  return (
    <div className="flex items-center gap-3 px-5 py-3 bg-indigo-50/40 border-t border-indigo-100">
      <select
        value={srcFieldId}
        onChange={(e) => setSrcFieldId(e.target.value)}
        className="flex-1 border border-gray-200 rounded-lg px-2.5 py-1.5 text-xs text-gray-900 bg-white focus:outline-none focus:ring-2 focus:ring-indigo-500"
      >
        <option value="">Source field…</option>
        {availSrc.map((f) => <option key={f.id} value={f.id}>{f.name} — {f.data_type}</option>)}
      </select>
      <ArrowRight className="w-3 h-3 text-gray-400 flex-shrink-0" />
      <select
        value={tgtFieldId}
        onChange={(e) => setTgtFieldId(e.target.value)}
        className="flex-1 border border-gray-200 rounded-lg px-2.5 py-1.5 text-xs text-gray-900 bg-white focus:outline-none focus:ring-2 focus:ring-indigo-500"
      >
        <option value="">Target field…</option>
        {availTgt.map((f) => <option key={f.id} value={f.id}>{f.name} — {f.data_type}</option>)}
      </select>
      <button
        onClick={handleAdd}
        disabled={!srcFieldId || !tgtFieldId || pending}
        className="px-3 py-1.5 text-xs font-medium text-white bg-indigo-600 rounded-lg hover:bg-indigo-700 disabled:opacity-40 flex-shrink-0"
      >
        {pending ? '…' : 'Add'}
      </button>
      <button onClick={onCancel} className="text-gray-400 hover:text-gray-600 flex-shrink-0"><X className="w-3.5 h-3.5" /></button>
      {error && <span className="text-xs text-red-600">{error}</span>}
    </div>
  )
}

// ─── Field Mapping Row ────────────────────────────────────────────────────────

function FieldMappingRow({
  fm, onSelect, onApprove, onReject, onDelete,
}: {
  fm: RichFieldMapping
  onSelect: () => void
  onApprove: () => void
  onReject: () => void
  onDelete: () => void
}) {
  const isApproved = fm.status === 'approved'
  const isRejected = fm.status === 'rejected'

  return (
    <div
      className={`flex items-center px-5 py-3 hover:bg-gray-50 cursor-pointer transition-colors ${isApproved ? 'bg-green-50/60' : isRejected ? 'bg-red-50/30' : ''}`}
      onClick={onSelect}
    >
      <div className="w-[36%] flex items-center gap-2 min-w-0">
        <span className={`w-2 h-2 rounded-full flex-shrink-0 ${cDot(fm.confidence)}`} />
        <span className={`text-sm truncate ${isRejected ? 'line-through text-gray-400' : 'text-gray-900'}`}>
          {fm.sourceField?.name ?? '—'}
        </span>
      </div>
      <div className="w-[28%] flex items-center justify-center gap-1">
        <span className={`text-xs font-semibold ${cText(fm.confidence)}`}>{fm.confidence !== null ? `${fm.confidence}%` : '—'}</span>
        <ArrowRight className="w-3 h-3 text-gray-300" />
      </div>
      <div className="w-[36%] flex items-center justify-between gap-2 min-w-0">
        <div className="flex items-center gap-2 min-w-0 flex-1">
          <span className={`w-2 h-2 rounded-full flex-shrink-0 ${cDot(fm.confidence)}`} />
          <span className={`text-sm truncate ${isRejected ? 'line-through text-gray-400' : 'text-gray-900'}`}>
            {fm.targetField?.name ?? '—'}
          </span>
        </div>
        <div className="flex items-center gap-0.5" onClick={(e) => e.stopPropagation()}>
          <button onClick={onApprove} title="Accept" className={`p-1 rounded transition-colors ${isApproved ? 'text-green-600' : 'text-gray-300 hover:text-green-600 hover:bg-green-50'}`}>
            <Check className="w-3.5 h-3.5" />
          </button>
          <button onClick={onSelect} title="Edit" className="p-1 rounded text-gray-300 hover:text-indigo-600 hover:bg-indigo-50 transition-colors">
            <Pencil className="w-3.5 h-3.5" />
          </button>
          <button onClick={onReject} title={isRejected ? 'Mark needs review' : 'Reject'} className={`p-1 rounded transition-colors ${isRejected ? 'text-red-500' : 'text-gray-300 hover:text-red-500 hover:bg-red-50'}`}>
            <X className="w-3.5 h-3.5" />
          </button>
          <button onClick={onDelete} title="Delete permanently" className="p-1 rounded text-gray-300 hover:text-red-600 hover:bg-red-50 transition-colors">
            <TrashIcon className="text-inherit" />
          </button>
        </div>
      </div>
    </div>
  )
}

// ─── Table Mapping Card ───────────────────────────────────────────────────────

function TableMappingCard({
  tm,
  expanded,
  onToggle,
  onSelectFM,
  onApproveFM,
  onRejectFM,
  onDeleteFM,
  onApproveAll,
  onRejectAll,
  onDeleteTM,
  showAddRow,
  onShowAddRow,
  onHideAddRow,
  onFieldAdded,
  allFieldsByTable,
  suggestingThis,
  onSuggestRemaining,
}: {
  tm: RichTableMapping
  expanded: boolean
  onToggle: () => void
  onSelectFM: (fm: RichFieldMapping) => void
  onApproveFM: (fmId: string) => void
  onRejectFM: (fmId: string) => void
  onDeleteFM: (fmId: string) => void
  onApproveAll: () => void
  onRejectAll: () => void
  onDeleteTM: () => void
  showAddRow: boolean
  onShowAddRow: () => void
  onHideAddRow: () => void
  onFieldAdded: (fm: RichFieldMapping) => void
  allFieldsByTable: Record<string, SimpleField[]>
  suggestingThis: boolean
  onSuggestRemaining: () => void
}) {
  const srcDs = tm.sourceTable?.dataset
  const tgtDs = tm.targetTable?.dataset
  const mappedSrcIds = new Set(tm.fieldMappings.map((fm) => fm.source_field_id))
  const mappedTgtIds = new Set(tm.fieldMappings.map((fm) => fm.target_field_id))
  const availSrc = (allFieldsByTable[tm.source_table_id] ?? []).filter((f) => !mappedSrcIds.has(f.id))
  const availTgt = (allFieldsByTable[tm.target_table_id] ?? []).filter((f) => !mappedTgtIds.has(f.id))
  const hasUnmapped = availSrc.length > 0 && availTgt.length > 0

  return (
    <div className="border border-gray-200 rounded-xl overflow-hidden">
      {/* Header */}
      <div className="flex items-center px-5 py-4 hover:bg-gray-50 transition-colors">
        <div className="flex items-center gap-2 flex-1 cursor-pointer min-w-0" onClick={onToggle}>
          <div className="flex-1 min-w-0">
            <p className="text-xs text-gray-400 mb-0.5 truncate">{srcDs?.name}</p>
            <p className="font-semibold text-gray-900 truncate">{tm.sourceTable?.name ?? '—'}</p>
            <p className="text-xs text-gray-500 mt-0.5">{tm.fieldMappings.length} field{tm.fieldMappings.length !== 1 ? 's' : ''}</p>
          </div>
          <div className="flex items-center px-3 flex-shrink-0">
            <div className="w-6 border-t-2 border-dashed border-indigo-200" />
            <ArrowRight className="w-4 h-4 text-indigo-400 -ml-1" />
          </div>
          <div className="flex-1 min-w-0 text-right">
            <p className="text-xs text-gray-400 mb-0.5 truncate">{tgtDs?.name}</p>
            <p className="font-semibold text-gray-900 truncate">{tm.targetTable?.name ?? '—'}</p>
            <div className="flex items-center justify-end gap-1.5 mt-1">
              <ConfidenceBadge confidence={tm.confidence} />
              <StatusBadge status={tm.status} />
            </div>
          </div>
          <div className="ml-3 flex-shrink-0">
            {expanded ? <ChevronDown className="w-4 h-4 text-gray-400" /> : <ChevronRight className="w-4 h-4 text-gray-400" />}
          </div>
        </div>

        {/* Table-level actions */}
        <div className="flex items-center gap-1 ml-3" onClick={(e) => e.stopPropagation()}>
          <button
            onClick={onApproveAll}
            title="Approve all field mappings"
            className="px-2 py-1 text-xs font-medium text-green-700 bg-green-50 hover:bg-green-100 rounded transition-colors"
          >
            Approve All
          </button>
          <button
            onClick={onRejectAll}
            title="Reject all field mappings"
            className="px-2 py-1 text-xs font-medium text-gray-600 bg-gray-100 hover:bg-gray-200 rounded transition-colors"
          >
            Reject All
          </button>
          <button
            onClick={onDeleteTM}
            title="Delete this table mapping"
            className="p-1.5 text-gray-400 hover:text-red-600 hover:bg-red-50 rounded transition-colors"
          >
            <TrashIcon />
          </button>
        </div>
      </div>

      {/* Expanded field list */}
      {expanded && (
        <div className="border-t border-gray-100">
          {/* Column headers */}
          <div className="flex items-center px-5 py-2 bg-gray-50 border-b border-gray-100">
            <div className="w-[36%] text-xs font-medium text-gray-500">Source Field</div>
            <div className="w-[28%] text-center text-xs font-medium text-gray-500">Confidence</div>
            <div className="w-[36%] text-xs font-medium text-gray-500">Target Field</div>
          </div>

          {tm.fieldMappings.length === 0 ? (
            <div className="px-5 py-4 text-sm text-gray-400 text-center">No field mappings yet.</div>
          ) : (
            tm.fieldMappings.map((fm) => (
              <FieldMappingRow
                key={fm.id}
                fm={fm}
                onSelect={() => onSelectFM(fm)}
                onApprove={() => onApproveFM(fm.id)}
                onReject={() => onRejectFM(fm.id)}
                onDelete={() => onDeleteFM(fm.id)}
              />
            ))
          )}

          {/* Inline add field row */}
          {showAddRow && (
            <InlineAddFieldRow
              tm={tm}
              allFieldsByTable={allFieldsByTable}
              onAdded={onFieldAdded}
              onCancel={onHideAddRow}
            />
          )}

          {/* Bottom action bar */}
          <div className="flex items-center gap-3 px-5 py-3 border-t border-gray-100 bg-gray-50/50">
            {!showAddRow && (
              <button
                onClick={onShowAddRow}
                className="flex items-center gap-1.5 text-xs font-medium text-indigo-600 hover:text-indigo-800 transition-colors"
              >
                <Plus className="w-3.5 h-3.5" />
                Add Field Mapping
              </button>
            )}
            {hasUnmapped && (
              <button
                onClick={onSuggestRemaining}
                disabled={suggestingThis}
                className="flex items-center gap-1.5 text-xs font-medium text-gray-600 hover:text-gray-900 border border-gray-200 bg-white hover:bg-gray-50 px-2.5 py-1 rounded-lg transition-colors disabled:opacity-50"
              >
                {suggestingThis ? (
                  <>
                    <span className="w-3 h-3 border-2 border-gray-400 border-t-transparent rounded-full animate-spin" />
                    Suggesting…
                  </>
                ) : (
                  <>
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M12 2a10 10 0 1 0 10 10" /><path d="M12 6v6l4 2" /></svg>
                    AI Suggest Remaining
                  </>
                )}
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  )
}

// ─── Mapping Details Panel ────────────────────────────────────────────────────

function MappingDetailsPanel({
  fm,
  parentTM,
  allFieldsByTable,
  onClose,
  onApprove,
  onReject,
  onDelete,
  onEdit,
}: {
  fm: RichFieldMapping
  parentTM: RichTableMapping | undefined
  allFieldsByTable: Record<string, SimpleField[]>
  onClose: () => void
  onApprove: (id: string) => void
  onReject: (id: string) => void
  onDelete: (id: string) => void
  onEdit: (id: string, updates: { source_field_id?: string; target_field_id?: string }) => void
}) {
  const [editSrcMode, setEditSrcMode] = useState(false)
  const [editTgtMode, setEditTgtMode] = useState(false)
  const [newSrcId, setNewSrcId] = useState(fm.source_field_id)
  const [newTgtId, setNewTgtId] = useState(fm.target_field_id)
  const [pending, startTransition] = useTransition()

  const mappedSrcIds = new Set(parentTM?.fieldMappings.filter((f) => f.id !== fm.id).map((f) => f.source_field_id) ?? [])
  const mappedTgtIds = new Set(parentTM?.fieldMappings.filter((f) => f.id !== fm.id).map((f) => f.target_field_id) ?? [])
  const allSrcFields = allFieldsByTable[parentTM?.source_table_id ?? ''] ?? []
  const allTgtFields = allFieldsByTable[parentTM?.target_table_id ?? ''] ?? []

  function handleEditTgt() {
    if (!newTgtId || newTgtId === fm.target_field_id) { setEditTgtMode(false); return }
    startTransition(async () => {
      onEdit(fm.id, { target_field_id: newTgtId })
      setEditTgtMode(false)
    })
  }

  function handleEditSrc() {
    if (!newSrcId || newSrcId === fm.source_field_id) { setEditSrcMode(false); return }
    startTransition(async () => {
      onEdit(fm.id, { source_field_id: newSrcId })
      setEditSrcMode(false)
    })
  }

  const confidence = fm.confidence
  const similarFields = fm.similar_fields_considered ?? []

  return (
    <div className="w-76 flex-shrink-0 bg-white border border-gray-200 rounded-xl overflow-hidden flex flex-col h-fit sticky top-4" style={{ width: '296px' }}>
      <div className="flex items-center justify-between px-5 py-4 border-b border-gray-100">
        <h3 className="font-semibold text-gray-900 text-sm">Mapping Details</h3>
        <button onClick={onClose} className="text-gray-400 hover:text-gray-600"><X className="w-4 h-4" /></button>
      </div>

      <div className="px-5 py-4 space-y-4 overflow-y-auto max-h-[70vh]">
        {/* Source → Target display */}
        <div className="flex items-center gap-2">
          <div className="flex-1 min-w-0">
            <p className="text-xs text-gray-500 mb-0.5">Source Field</p>
            <p className="font-semibold text-gray-900 text-sm truncate">{fm.sourceField?.name ?? '—'}</p>
            <p className="text-xs text-gray-400">{fm.sourceField?.data_type}</p>
          </div>
          <ArrowRight className="w-4 h-4 text-gray-400 flex-shrink-0" />
          <div className="flex-1 min-w-0 text-right">
            <p className="text-xs text-gray-500 mb-0.5">Target Field</p>
            <p className="font-semibold text-gray-900 text-sm truncate">{fm.targetField?.name ?? '—'}</p>
            <p className="text-xs text-gray-400">{fm.targetField?.data_type}</p>
          </div>
        </div>

        {/* Confidence bar */}
        <div>
          <div className="flex items-center justify-between mb-1.5">
            <span className="text-xs text-gray-500">Confidence</span>
            <span className={`text-xs font-bold ${cText(confidence)}`}>{confidence !== null ? `${confidence}%` : '—'}</span>
          </div>
          <div className="w-full bg-gray-100 rounded-full h-2">
            <div className={`h-2 rounded-full transition-all ${cBar(confidence)}`} style={{ width: `${confidence ?? 0}%` }} />
          </div>
        </div>

        {/* AI Reasoning */}
        {fm.ai_reasoning && (
          <div className="bg-blue-50 border border-blue-100 rounded-lg p-3">
            <div className="flex items-center gap-1.5 mb-1.5">
              <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor" className="text-blue-500"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm1 15h-2v-6h2v6zm0-8h-2V7h2v2z" /></svg>
              <span className="text-xs font-semibold text-blue-700">AI-Generated</span>
            </div>
            <p className="text-xs text-blue-800 leading-relaxed">{fm.ai_reasoning}</p>
          </div>
        )}

        {/* Similar fields */}
        {similarFields.length > 0 && (
          <div>
            <p className="text-xs font-medium text-gray-600 mb-1.5">Similar Fields Considered</p>
            <div className="flex flex-wrap gap-1">
              {similarFields.map((f, i) => <span key={i} className="px-2 py-0.5 bg-gray-100 text-gray-600 text-xs rounded">{f}</span>)}
            </div>
          </div>
        )}

        {/* Type compatibility */}
        {fm.type_compatibility && (
          <div>
            <p className="text-xs font-medium text-gray-600 mb-1">Type Compatibility</p>
            <p className="text-xs text-gray-700 bg-gray-50 rounded-lg px-3 py-2 font-mono leading-relaxed">{fm.type_compatibility}</p>
          </div>
        )}

        {/* Example values */}
        {(fm.sourceFieldSamples.length > 0 || fm.targetFieldSamples.length > 0) && (
          <div>
            <p className="text-xs font-medium text-gray-600 mb-1.5">Example Values</p>
            {fm.sourceFieldSamples.length > 0 && (
              <div className="flex items-start gap-2 mb-1">
                <span className="text-xs text-gray-500 w-12 flex-shrink-0 pt-0.5">Source:</span>
                <div className="flex flex-wrap gap-1">{fm.sourceFieldSamples.map((v, i) => <span key={i} className="text-xs bg-indigo-50 text-indigo-700 px-1.5 py-0.5 rounded">{v}</span>)}</div>
              </div>
            )}
            {fm.targetFieldSamples.length > 0 && (
              <div className="flex items-start gap-2">
                <span className="text-xs text-gray-500 w-12 flex-shrink-0 pt-0.5">Target:</span>
                <div className="flex flex-wrap gap-1">{fm.targetFieldSamples.map((v, i) => <span key={i} className="text-xs bg-purple-50 text-purple-700 px-1.5 py-0.5 rounded">{v}</span>)}</div>
              </div>
            )}
          </div>
        )}

        {/* Change Source Field */}
        <div>
          <div className="flex items-center justify-between mb-1">
            <p className="text-xs font-medium text-gray-600">Change Source Field</p>
            {!editSrcMode && (
              <button onClick={() => setEditSrcMode(true)} className="text-xs text-indigo-600 hover:text-indigo-800">Change</button>
            )}
          </div>
          {editSrcMode ? (
            <>
              <select
                value={newSrcId}
                onChange={(e) => setNewSrcId(e.target.value)}
                className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500"
              >
                <option value={fm.source_field_id}>{fm.sourceField?.name} (current)</option>
                {allSrcFields.filter((f) => f.id !== fm.source_field_id && !mappedSrcIds.has(f.id)).map((f) => (
                  <option key={f.id} value={f.id}>{f.name} ({f.data_type})</option>
                ))}
              </select>
              <div className="flex gap-2 mt-2">
                <button onClick={handleEditSrc} disabled={pending} className="flex-1 px-3 py-1.5 text-xs font-medium text-white bg-indigo-600 rounded-lg disabled:opacity-40">
                  {pending ? '…' : 'Save'}
                </button>
                <button onClick={() => { setEditSrcMode(false); setNewSrcId(fm.source_field_id) }} className="flex-1 px-3 py-1.5 text-xs font-medium text-gray-700 border border-gray-200 rounded-lg">
                  Cancel
                </button>
              </div>
            </>
          ) : (
            <p className="text-xs text-gray-500 bg-gray-50 rounded px-2 py-1.5">{fm.sourceField?.name ?? '—'}</p>
          )}
        </div>

        {/* Change Target Field */}
        <div>
          <div className="flex items-center justify-between mb-1">
            <p className="text-xs font-medium text-gray-600">Change Target Field</p>
            {!editTgtMode && (
              <button onClick={() => setEditTgtMode(true)} className="text-xs text-indigo-600 hover:text-indigo-800">Change</button>
            )}
          </div>
          {editTgtMode ? (
            <>
              <select
                value={newTgtId}
                onChange={(e) => setNewTgtId(e.target.value)}
                className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500"
              >
                <option value={fm.target_field_id}>{fm.targetField?.name} (current)</option>
                {allTgtFields.filter((f) => f.id !== fm.target_field_id).map((f) => (
                  <option key={f.id} value={f.id}>
                    {f.name} ({f.data_type}){mappedTgtIds.has(f.id) ? ' ⚠ already mapped' : ''}
                  </option>
                ))}
              </select>
              <div className="flex gap-2 mt-2">
                <button onClick={handleEditTgt} disabled={pending} className="flex-1 px-3 py-1.5 text-xs font-medium text-white bg-indigo-600 rounded-lg disabled:opacity-40">
                  {pending ? '…' : 'Save'}
                </button>
                <button onClick={() => { setEditTgtMode(false); setNewTgtId(fm.target_field_id) }} className="flex-1 px-3 py-1.5 text-xs font-medium text-gray-700 border border-gray-200 rounded-lg">
                  Cancel
                </button>
              </div>
            </>
          ) : (
            <p className="text-xs text-gray-500 bg-gray-50 rounded px-2 py-1.5">{fm.targetField?.name ?? '—'}</p>
          )}
        </div>
      </div>

      {/* Actions */}
      <div className="px-5 py-4 border-t border-gray-100 space-y-2">
        {fm.status !== 'approved' && (
          <button onClick={() => { onApprove(fm.id); onClose() }} className="w-full px-4 py-2.5 text-sm font-medium text-white bg-green-600 rounded-lg hover:bg-green-700 transition-colors">
            Accept Mapping
          </button>
        )}
        <button
          onClick={() => { onDelete(fm.id); onClose() }}
          className="w-full text-sm text-red-600 hover:text-red-700 py-1"
        >
          Remove Mapping
        </button>
      </div>
    </div>
  )
}

// ─── Unmapped Fields View ─────────────────────────────────────────────────────

function UnmappedView({
  unmappedSource,
  unmappedTarget,
  projectId,
  onMapped,
}: {
  unmappedSource: UnmappedField[]
  unmappedTarget: UnmappedField[]
  projectId: string
  onMapped: () => void
}) {
  const [mappingFor, setMappingFor] = useState<string | null>(null)
  const [selectedTgtId, setSelectedTgtId] = useState('')
  const [pending, startTransition] = useTransition()
  const [errors, setErrors] = useState<Record<string, string>>({})

  function handleMap(srcFieldId: string) {
    if (!selectedTgtId) return
    startTransition(async () => {
      const result = await mapUnmappedField(projectId, srcFieldId, selectedTgtId)
      if (!result.success) {
        setErrors((prev) => ({ ...prev, [srcFieldId]: result.error ?? 'Failed' }))
      } else {
        setMappingFor(null)
        setSelectedTgtId('')
        onMapped()
      }
    })
  }

  if (unmappedSource.length === 0 && unmappedTarget.length === 0) {
    return <div className="text-center py-12 text-gray-400 text-sm">All fields are mapped.</div>
  }

  return (
    <div className="grid grid-cols-2 gap-6">
      {/* Unmapped source */}
      <div>
        <h3 className="text-sm font-semibold text-gray-700 mb-3 flex items-center gap-2">
          <span className="w-2 h-2 rounded-full bg-indigo-400" />
          Unmapped Source Fields
          <span className="text-xs font-normal text-gray-400">({unmappedSource.length})</span>
        </h3>
        {unmappedSource.length === 0 ? (
          <p className="text-sm text-gray-400">All source fields are mapped.</p>
        ) : (
          <div className="space-y-2">
            {unmappedSource.map((f) => (
              <div key={f.id} className="px-3 py-2.5 bg-indigo-50/60 border border-indigo-100 rounded-lg">
                <div className="flex items-center justify-between gap-2">
                  <div className="min-w-0">
                    <p className="text-sm font-medium text-gray-800 truncate">{f.table?.name}.{f.name}</p>
                    <p className="text-xs text-gray-500">{f.data_type}</p>
                  </div>
                  {mappingFor === f.id ? (
                    <button onClick={() => { setMappingFor(null); setSelectedTgtId('') }} className="text-xs text-gray-400">Cancel</button>
                  ) : (
                    <button
                      onClick={() => { setMappingFor(f.id); setSelectedTgtId('') }}
                      className="text-xs font-medium text-indigo-600 hover:text-indigo-800 whitespace-nowrap"
                    >
                      Map to →
                    </button>
                  )}
                </div>
                {mappingFor === f.id && (
                  <div className="mt-2 flex gap-2">
                    <select
                      value={selectedTgtId}
                      onChange={(e) => setSelectedTgtId(e.target.value)}
                      className="flex-1 border border-gray-200 rounded px-2 py-1 text-xs focus:outline-none focus:ring-2 focus:ring-indigo-500"
                    >
                      <option value="">Select target field…</option>
                      {unmappedTarget.map((tf) => (
                        <option key={tf.id} value={tf.id}>{tf.table?.name}.{tf.name} ({tf.data_type})</option>
                      ))}
                    </select>
                    <button
                      onClick={() => handleMap(f.id)}
                      disabled={!selectedTgtId || pending}
                      className="px-2.5 py-1 text-xs font-medium text-white bg-indigo-600 rounded hover:bg-indigo-700 disabled:opacity-40"
                    >
                      Map
                    </button>
                  </div>
                )}
                {errors[f.id] && <p className="text-xs text-red-600 mt-1">{errors[f.id]}</p>}
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Unmapped target */}
      <div>
        <h3 className="text-sm font-semibold text-gray-700 mb-3 flex items-center gap-2">
          <span className="w-2 h-2 rounded-full bg-purple-400" />
          Unmapped Target Fields
          <span className="text-xs font-normal text-gray-400">({unmappedTarget.length})</span>
        </h3>
        {unmappedTarget.length === 0 ? (
          <p className="text-sm text-gray-400">All target fields are mapped.</p>
        ) : (
          <div className="space-y-2">
            {unmappedTarget.map((f) => (
              <div key={f.id} className="px-3 py-2.5 bg-purple-50/60 border border-purple-100 rounded-lg">
                <p className="text-sm font-medium text-gray-800 truncate">{f.table?.name}.{f.name}</p>
                <p className="text-xs text-gray-500">{f.data_type}</p>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}

// ─── Main Component ───────────────────────────────────────────────────────────

export default function MappingContent({ projectId, initialData }: Props) {
  const router = useRouter()
  const [, startTransition] = useTransition()

  const [data, setData] = useState<MappingsResult | null>(initialData)
  const [tableMappings, setTableMappings] = useState<RichTableMapping[]>(initialData?.tableMappings ?? [])
  const [unmappedSource, setUnmappedSource] = useState<UnmappedField[]>(initialData?.unmappedSourceFields ?? [])
  const [unmappedTarget, setUnmappedTarget] = useState<UnmappedField[]>(initialData?.unmappedTargetFields ?? [])
  const allFieldsByTable = data?.allFieldsByTable ?? {}

  const [activeFilter, setActiveFilter] = useState<FilterTab>('needs_review')
  const [expandedIds, setExpandedIds] = useState<Set<string>>(new Set())
  const [selectedFM, setSelectedFM] = useState<RichFieldMapping | null>(null)
  const [showAddModal, setShowAddModal] = useState(false)
  const [addRowForTMId, setAddRowForTMId] = useState<string | null>(null)
  const [deleteTMTarget, setDeleteTMTarget] = useState<RichTableMapping | null>(null)
  const [suggestingTMId, setSuggestingTMId] = useState<string | null>(null)
  const [approvingHC, setApprovingHC] = useState(false)
  const [hcConfirmCount, setHcConfirmCount] = useState<number | null>(null)

  // Tab counts
  const allFMs = useMemo(() => tableMappings.flatMap((tm) => tm.fieldMappings), [tableMappings])
  const needsReviewCount = useMemo(() => allFMs.filter((fm) => fm.status === 'needs_review').length, [allFMs])
  const highConfCount = useMemo(() => tableMappings.filter((tm) => (tm.confidence ?? 0) >= 75).length, [tableMappings])
  const unmappedCount = unmappedSource.length + unmappedTarget.length

  // High-confidence count for bulk approve button
  const hcFMCount = useMemo(() => allFMs.filter((fm) => fm.status === 'needs_review' && (fm.confidence ?? 0) >= 85).length, [allFMs])

  const filteredMappings = useMemo(() => {
    switch (activeFilter) {
      case 'needs_review': return tableMappings.filter((tm) => tm.status === 'needs_review' || tm.fieldMappings.some((fm) => fm.status === 'needs_review'))
      case 'high_confidence': return tableMappings.filter((tm) => (tm.confidence ?? 0) >= 75)
      case 'all': return tableMappings
      default: return []
    }
  }, [tableMappings, activeFilter])

  const sourceDatasetName = tableMappings[0]?.sourceTable?.dataset?.name ?? ''
  const targetDatasetName = tableMappings[0]?.targetTable?.dataset?.name ?? ''

  const refreshData = useCallback(() => {
    startTransition(async () => {
      const fresh = await getMappings(projectId)
      if (fresh) {
        setData(fresh)
        setTableMappings(fresh.tableMappings)
        setUnmappedSource(fresh.unmappedSourceFields)
        setUnmappedTarget(fresh.unmappedTargetFields)
      }
    })
  }, [projectId])

  function toggleExpand(id: string) {
    setExpandedIds((prev) => {
      const next = new Set(prev)
      next.has(id) ? next.delete(id) : next.add(id)
      return next
    })
  }

  // Optimistic FM update
  function updateFM(fmId: string, patch: Partial<RichFieldMapping>) {
    setTableMappings((prev) => prev.map((tm) => ({ ...tm, fieldMappings: tm.fieldMappings.map((fm) => fm.id === fmId ? { ...fm, ...patch } : fm) })))
    if (selectedFM?.id === fmId) setSelectedFM((prev) => prev ? { ...prev, ...patch } : null)
  }

  function handleApprove(fmId: string) {
    updateFM(fmId, { status: 'approved' })
    startTransition(async () => {
      const r = await updateFieldMappingStatus(fmId, 'approved')
      if (!r.success) updateFM(fmId, { status: 'needs_review' })
    })
  }

  function handleReject(fmId: string) {
    const fm = allFMs.find((f) => f.id === fmId)
    const newStatus = fm?.status === 'rejected' ? 'needs_review' : 'rejected'
    updateFM(fmId, { status: newStatus })
    startTransition(async () => {
      const r = await updateFieldMappingStatus(fmId, newStatus)
      if (!r.success) updateFM(fmId, { status: fm?.status ?? 'needs_review' })
    })
  }

  function handleDeleteFM(fmId: string) {
    setTableMappings((prev) => prev.map((tm) => ({ ...tm, fieldMappings: tm.fieldMappings.filter((fm) => fm.id !== fmId) })))
    if (selectedFM?.id === fmId) setSelectedFM(null)
    startTransition(async () => { await deleteFieldMapping(fmId) })
  }

  function handleEditFM(fmId: string, updates: { source_field_id?: string; target_field_id?: string }) {
    const parentTM = tableMappings.find((tm) => tm.fieldMappings.some((fm) => fm.id === fmId))
    const oldFM = allFMs.find((f) => f.id === fmId)

    const srcField = updates.source_field_id
      ? (allFieldsByTable[parentTM?.source_table_id ?? ''] ?? []).find((f) => f.id === updates.source_field_id)
      : null
    const tgtField = updates.target_field_id
      ? (allFieldsByTable[parentTM?.target_table_id ?? ''] ?? []).find((f) => f.id === updates.target_field_id)
      : null

    const patch: Partial<RichFieldMapping> = { confidence: null, status: 'needs_review' }
    if (updates.source_field_id) {
      patch.source_field_id = updates.source_field_id
      patch.sourceField = srcField ? { id: srcField.id, name: srcField.name, data_type: srcField.data_type, inferred_type: null } : null
      patch.ai_reasoning = `Manually re-mapped source from ${oldFM?.sourceField?.name ?? '?'} to ${srcField?.name ?? '?'}`
    }
    if (updates.target_field_id) {
      patch.target_field_id = updates.target_field_id
      patch.targetField = tgtField ? { id: tgtField.id, name: tgtField.name, data_type: tgtField.data_type, inferred_type: null } : null
      patch.ai_reasoning = `Manually re-mapped target from ${oldFM?.targetField?.name ?? '?'} to ${tgtField?.name ?? '?'}`
    }
    updateFM(fmId, patch)
    startTransition(async () => { await editFieldMapping(fmId, { ...updates, confidence: null, ai_reasoning: patch.ai_reasoning ?? undefined }) })
  }

  function handleApproveAll(tmId: string) {
    setTableMappings((prev) => prev.map((tm) => tm.id !== tmId ? tm : { ...tm, status: 'approved', fieldMappings: tm.fieldMappings.map((fm) => ({ ...fm, status: 'approved' as const })) }))
    startTransition(async () => { await approveAllFieldMappings(tmId) })
  }

  function handleRejectAll(tmId: string) {
    setTableMappings((prev) => prev.map((tm) => tm.id !== tmId ? tm : { ...tm, fieldMappings: tm.fieldMappings.map((fm) => ({ ...fm, status: 'rejected' as const })) }))
    startTransition(async () => { await rejectAllFieldMappings(tmId) })
  }

  function confirmDeleteTM() {
    if (!deleteTMTarget) return
    const id = deleteTMTarget.id
    setTableMappings((prev) => prev.filter((tm) => tm.id !== id))
    if (selectedFM?.table_mapping_id === id) setSelectedFM(null)
    setDeleteTMTarget(null)
    startTransition(async () => { await deleteTableMapping(id); refreshData() })
  }

  function handleFieldAdded(tmId: string, newFM: RichFieldMapping) {
    setTableMappings((prev) => prev.map((tm) => tm.id !== tmId ? tm : { ...tm, fieldMappings: [...tm.fieldMappings, newFM] }))
    // Refresh to update unmapped counts
    refreshData()
  }

  async function handleSuggestRemaining(tmId: string) {
    setSuggestingTMId(tmId)
    const result = await suggestRemainingMappings(tmId)
    setSuggestingTMId(null)
    if (result.success && result.newMappingsCount > 0) refreshData()
  }

  function handleApproveHighConf() {
    if (hcConfirmCount === null) {
      setHcConfirmCount(hcFMCount)
      return
    }
    setApprovingHC(true)
    setHcConfirmCount(null)
    startTransition(async () => {
      const r = await approveHighConfidenceMappings(projectId, 85)
      setApprovingHC(false)
      if (r.success) refreshData()
    })
  }

  if (tableMappings.length === 0) {
    return <div className="px-6 py-4"><EmptyState projectId={projectId} /></div>
  }

  return (
    <div className="px-6 py-6 space-y-5">
      {/* Progress bar */}
      <MappingProgress tableMappings={tableMappings} allFieldsByTable={allFieldsByTable} />

      {/* Source ↔ Target header */}
      {(sourceDatasetName || targetDatasetName) && (
        <div className="flex items-center gap-3">
          <span className="text-sm font-semibold text-indigo-700 bg-indigo-50 px-3 py-1.5 rounded-lg">{sourceDatasetName}</span>
          <div className="flex items-center gap-1 text-gray-400">
            <div className="w-8 border-t border-dashed border-gray-300" />
            <ArrowRight className="w-4 h-4" />
          </div>
          <span className="text-sm font-semibold text-purple-700 bg-purple-50 px-3 py-1.5 rounded-lg">{targetDatasetName}</span>
        </div>
      )}

      {/* Filter tabs + bulk approve */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-1 p-1 bg-gray-100 rounded-xl">
          {([
            { key: 'needs_review', label: 'Needs Review', count: needsReviewCount, cc: 'bg-amber-100 text-amber-700' },
            { key: 'high_confidence', label: 'High Confidence', count: highConfCount, cc: 'bg-green-100 text-green-700' },
            { key: 'unmapped', label: 'Unmapped', count: unmappedCount, cc: 'bg-gray-200 text-gray-600' },
            { key: 'all', label: 'All', count: tableMappings.length, cc: 'bg-gray-200 text-gray-600' },
          ] as const).map((tab) => (
            <button
              key={tab.key}
              onClick={() => setActiveFilter(tab.key)}
              className={`flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium rounded-lg transition-colors ${activeFilter === tab.key ? 'bg-white text-gray-900 shadow-sm' : 'text-gray-600 hover:text-gray-900'}`}
            >
              {tab.label}
              <span className={`text-xs px-1.5 py-0.5 rounded-full ${tab.cc}`}>{tab.count}</span>
            </button>
          ))}
        </div>

        {hcFMCount > 0 && (
          hcConfirmCount !== null ? (
            <div className="flex items-center gap-2 px-3 py-2 bg-green-50 border border-green-200 rounded-lg">
              <span className="text-xs text-green-800">Approve {hcConfirmCount} mapping{hcConfirmCount !== 1 ? 's' : ''}?</span>
              <button onClick={handleApproveHighConf} disabled={approvingHC} className="text-xs font-medium text-white bg-green-600 px-2.5 py-1 rounded hover:bg-green-700 disabled:opacity-40">Confirm</button>
              <button onClick={() => setHcConfirmCount(null)} className="text-xs text-gray-500 hover:text-gray-700">Cancel</button>
            </div>
          ) : (
            <button
              onClick={handleApproveHighConf}
              disabled={approvingHC}
              className="flex items-center gap-1.5 px-3 py-2 text-sm font-medium text-green-700 bg-green-50 border border-green-200 rounded-lg hover:bg-green-100 transition-colors disabled:opacity-40"
            >
              <Check className="w-3.5 h-3.5" />
              Approve All High Confidence ({hcFMCount})
            </button>
          )
        )}
      </div>

      {/* Main content */}
      <div className="flex gap-5 items-start">
        <div className="flex-1 space-y-3 min-w-0">
          {activeFilter === 'unmapped' ? (
            <UnmappedView
              unmappedSource={unmappedSource}
              unmappedTarget={unmappedTarget}
              projectId={projectId}
              onMapped={refreshData}
            />
          ) : filteredMappings.length === 0 ? (
            <div className="text-center py-12 text-sm text-gray-400 border border-dashed border-gray-200 rounded-xl">
              {activeFilter === 'needs_review' ? 'All mappings have been reviewed.' : activeFilter === 'high_confidence' ? 'No high-confidence mappings.' : 'No mappings found.'}
            </div>
          ) : (
            filteredMappings.map((tm) => (
              <TableMappingCard
                key={tm.id}
                tm={tm}
                expanded={expandedIds.has(tm.id)}
                onToggle={() => toggleExpand(tm.id)}
                onSelectFM={(fm) => setSelectedFM(fm)}
                onApproveFM={handleApprove}
                onRejectFM={handleReject}
                onDeleteFM={handleDeleteFM}
                onApproveAll={() => handleApproveAll(tm.id)}
                onRejectAll={() => handleRejectAll(tm.id)}
                onDeleteTM={() => setDeleteTMTarget(tm)}
                showAddRow={addRowForTMId === tm.id}
                onShowAddRow={() => { setAddRowForTMId(tm.id); setExpandedIds((p) => new Set([...p, tm.id])) }}
                onHideAddRow={() => setAddRowForTMId(null)}
                onFieldAdded={(fm) => handleFieldAdded(tm.id, fm)}
                allFieldsByTable={allFieldsByTable}
                suggestingThis={suggestingTMId === tm.id}
                onSuggestRemaining={() => handleSuggestRemaining(tm.id)}
              />
            ))
          )}
        </div>

        {/* Details panel */}
        {selectedFM && (
          <MappingDetailsPanel
            fm={selectedFM}
            parentTM={tableMappings.find((tm) => tm.id === selectedFM.table_mapping_id)}
            allFieldsByTable={allFieldsByTable}
            onClose={() => setSelectedFM(null)}
            onApprove={handleApprove}
            onReject={handleReject}
            onDelete={handleDeleteFM}
            onEdit={handleEditFM}
          />
        )}
      </div>

      {/* Bottom bar */}
      <div className="flex items-center justify-between pt-2 border-t border-gray-100">
        <button onClick={() => setShowAddModal(true)} className="flex items-center gap-2 text-sm font-medium text-gray-600 hover:text-indigo-700 transition-colors">
          <Plus className="w-4 h-4" />
          Add New Mapping
        </button>
        <button onClick={() => router.push(`/app/projects/${projectId}/transform`)} className="px-5 py-2.5 text-sm font-medium text-white bg-indigo-600 rounded-lg hover:bg-indigo-700 transition-colors">
          Proceed to Transform →
        </button>
      </div>

      {/* Modals */}
      {showAddModal && data && (
        <AddMappingModal
          projectId={projectId}
          allSourceTables={data.allSourceTables}
          allTargetTables={data.allTargetTables}
          onClose={() => setShowAddModal(false)}
          onAdded={refreshData}
        />
      )}

      {deleteTMTarget && (
        <DeleteConfirmDialog
          message={`Remove ${deleteTMTarget.sourceTable?.name ?? '?'} → ${deleteTMTarget.targetTable?.name ?? '?'} and all ${deleteTMTarget.fieldMappings.length} field mapping${deleteTMTarget.fieldMappings.length !== 1 ? 's' : ''}?`}
          onConfirm={confirmDeleteTM}
          onCancel={() => setDeleteTMTarget(null)}
        />
      )}
    </div>
  )
}
