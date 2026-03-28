'use client'

import { useState, useMemo, useTransition, useCallback, useEffect } from 'react'
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
  regenerateFieldMappings,
  generateMappings,
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

type FilterTab = 'all' | 'needs_review' | 'approved' | 'unmapped' | 'many_to_one' | 'one_to_many'

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

// ─── Table Selector (used in GenerateMappingsPanel) ──────────────────────────

function TableSelector({
  title,
  tables,
  selected,
  onToggle,
  colorClass = 'text-indigo-600',
}: {
  title: string
  tables: { id: string; name: string; datasetName: string }[]
  selected: Set<string>
  onToggle: (id: string) => void
  colorClass?: string
}) {
  const allSelected = tables.length > 0 && tables.every((t) => selected.has(t.id))
  const noneSelected = tables.every((t) => !selected.has(t.id))

  function toggleAll() {
    if (allSelected) tables.forEach((t) => onToggle(t.id))
    else tables.filter((t) => !selected.has(t.id)).forEach((t) => onToggle(t.id))
  }

  return (
    <div className="border border-gray-200 rounded-xl p-4 flex flex-col">
      <div className="flex items-center justify-between mb-3">
        <h4 className="text-sm font-semibold text-gray-800">{title}</h4>
        <button
          onClick={toggleAll}
          className={`text-xs font-medium ${colorClass} hover:opacity-80 transition-opacity`}
        >
          {allSelected ? 'Deselect All' : 'Select All'}
        </button>
      </div>
      {tables.length === 0 ? (
        <p className="text-xs text-gray-400 py-2">No tables available.</p>
      ) : (
        <div className="space-y-1.5 overflow-y-auto max-h-48">
          {tables.map((t) => (
            <label key={t.id} className="flex items-center gap-2.5 cursor-pointer group">
              <input
                type="checkbox"
                checked={selected.has(t.id)}
                onChange={() => onToggle(t.id)}
                className={`w-4 h-4 rounded border-gray-300 focus:ring-2 focus:ring-indigo-500 cursor-pointer`}
              />
              <span className="text-sm text-gray-800 group-hover:text-gray-900">{t.name}</span>
              {t.datasetName && (
                <span className="text-xs text-gray-400 truncate">{t.datasetName}</span>
              )}
            </label>
          ))}
        </div>
      )}
      <p className="text-xs text-gray-400 mt-2 pt-2 border-t border-gray-100">
        {selected.size > 0 ? `${Array.from(selected).filter(id => tables.some(t => t.id === id)).length} of ${tables.length} selected` : `${tables.length} table${tables.length !== 1 ? 's' : ''}`}
      </p>
    </div>
  )
}

// ─── Generate Mappings Panel ──────────────────────────────────────────────────

function GenerateMappingsPanel({
  projectId,
  sourceTables,
  targetTables,
  onDone,
  onCancel,
}: {
  projectId: string
  sourceTables: { id: string; name: string; datasetName: string }[]
  targetTables: { id: string; name: string; datasetName: string }[]
  onDone: (result: { generated: number; skipped: number; message?: string }) => void
  onCancel?: () => void
}) {
  const [selectedSrc, setSelectedSrc] = useState<Set<string>>(
    () => new Set(sourceTables.map((t) => t.id))
  )
  const [selectedTgt, setSelectedTgt] = useState<Set<string>>(
    () => new Set(targetTables.map((t) => t.id))
  )
  const [generating, setGenerating] = useState(false)
  const [error, setError] = useState<string | null>(null)

  function toggleSrc(id: string) {
    setSelectedSrc((prev) => { const n = new Set(prev); n.has(id) ? n.delete(id) : n.add(id); return n })
  }
  function toggleTgt(id: string) {
    setSelectedTgt((prev) => { const n = new Set(prev); n.has(id) ? n.delete(id) : n.add(id); return n })
  }

  const canGenerate = selectedSrc.size > 0 && selectedTgt.size > 0

  async function handleGenerate() {
    setError(null)
    setGenerating(true)
    try {
      const result = await generateMappings(projectId, [...selectedSrc], [...selectedTgt])
      if (!result.success) {
        setError(result.error ?? 'Generation failed. Please try again.')
        setGenerating(false)
        return
      }
      onDone({ generated: result.generated ?? 0, skipped: result.skipped ?? 0, message: result.message })
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Generation failed. Please try again.')
      setGenerating(false)
    }
  }

  if (sourceTables.length === 0 || targetTables.length === 0) {
    return (
      <div className="text-center py-8 text-sm text-gray-500">
        {sourceTables.length === 0
          ? 'All source tables already have mappings. Use "+ Add New Mapping" for additional pairs.'
          : 'All target tables already have mappings. Use "+ Add New Mapping" for additional pairs.'}
      </div>
    )
  }

  return (
    <div className="relative">
      {generating && (
        <div className="absolute inset-0 bg-white/95 flex items-center justify-center z-10 rounded-xl">
          <div className="text-center px-4">
            <div className="w-10 h-10 border-4 border-indigo-600 border-t-transparent rounded-full animate-spin mx-auto mb-3" />
            <p className="font-semibold text-gray-900 text-sm">Generating AI-powered mappings…</p>
            <p className="text-xs text-gray-500 mt-1">Analyzing schemas and sample data. This may take 15–30 seconds.</p>
          </div>
        </div>
      )}

      <div className="grid grid-cols-2 gap-4 mb-4">
        <TableSelector
          title="Source Tables"
          tables={sourceTables}
          selected={selectedSrc}
          onToggle={toggleSrc}
          colorClass="text-indigo-600"
        />
        <TableSelector
          title="Target Tables"
          tables={targetTables}
          selected={selectedTgt}
          onToggle={toggleTgt}
          colorClass="text-purple-600"
        />
      </div>

      {error && (
        <div className="flex items-start gap-2 px-3 py-2.5 bg-red-50 border border-red-200 rounded-lg mb-4 text-xs text-red-700">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="flex-shrink-0 mt-0.5"><circle cx="12" cy="12" r="10" /><line x1="12" y1="8" x2="12" y2="12" /><line x1="12" y1="16" x2="12.01" y2="16" /></svg>
          {error}
        </div>
      )}

      <div className="flex items-center justify-between">
        {onCancel ? (
          <button onClick={onCancel} className="px-4 py-2 text-sm font-medium text-gray-700 border border-gray-200 rounded-lg hover:bg-gray-50 transition-colors">
            Cancel
          </button>
        ) : <div />}
        <button
          onClick={handleGenerate}
          disabled={!canGenerate || generating}
          className="px-5 py-2.5 text-sm font-medium text-white bg-indigo-600 rounded-lg hover:bg-indigo-700 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
        >
          {generating ? 'Generating…' : 'Generate Mappings'}
        </button>
      </div>
    </div>
  )
}

// ─── Regenerate Confirm Dialog ────────────────────────────────────────────────

function RegenerateConfirmDialog({
  sourceTableName,
  targetTableName,
  fieldCount,
  onConfirm,
  onCancel,
}: {
  sourceTableName: string
  targetTableName: string
  fieldCount: number
  onConfirm: () => void
  onCancel: () => void
}) {
  return (
    <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4">
      <div className="bg-white rounded-xl shadow-xl w-full max-w-sm p-6">
        <div className="flex items-start gap-3 mb-5">
          <div className="w-9 h-9 rounded-full bg-amber-50 flex items-center justify-center flex-shrink-0">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="text-amber-500">
              <polyline points="23 4 23 10 17 10" /><polyline points="1 20 1 14 7 14" />
              <path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15" />
            </svg>
          </div>
          <div>
            <p className="font-semibold text-gray-900 text-sm mb-1">Regenerate Field Mappings</p>
            <p className="text-sm text-gray-600">
              This will replace all {fieldCount > 0 ? `${fieldCount} ` : ''}field mapping{fieldCount !== 1 ? 's' : ''} for{' '}
              <span className="font-medium text-gray-800">{sourceTableName} → {targetTableName}</span>.
              Any approved or edited mappings will be lost.
            </p>
          </div>
        </div>
        <div className="flex gap-3">
          <button onClick={onCancel} className="flex-1 px-4 py-2.5 text-sm font-medium text-gray-700 border border-gray-200 rounded-lg hover:bg-gray-50">Cancel</button>
          <button onClick={onConfirm} className="flex-1 px-4 py-2.5 text-sm font-medium text-white bg-amber-600 rounded-lg hover:bg-amber-700">Regenerate</button>
        </div>
      </div>
    </div>
  )
}

// ─── Mapping Progress Bar ─────────────────────────────────────────────────────

function MappingProgress({
  tableMappings,
  allFieldsByTable,
  onShowUncovered,
}: {
  tableMappings: RichTableMapping[]
  allFieldsByTable: Record<string, SimpleField[]>
  onShowUncovered: () => void
}) {
  const allFMs = tableMappings.flatMap((tm) => tm.fieldMappings)
  // Review progress tracks primary rows only — contributing rows are implicitly managed
  const primaryFMs = allFMs.filter((fm) => !fm.is_contributing)
  const totalToReview = primaryFMs.length
  const approvedCount = primaryFMs.filter((fm) => fm.status === 'approved').length
  const rejectedCount = primaryFMs.filter((fm) => fm.status === 'rejected').length
  const reviewedCount = approvedCount + rejectedCount
  const awaitingCount = totalToReview - reviewedCount
  const reviewPct = totalToReview > 0 ? Math.round((reviewedCount / totalToReview) * 100) : 0

  // Source field coverage
  const sourceTableIds = new Set(tableMappings.map((tm) => tm.source_table_id))
  const targetTableIds = new Set(tableMappings.map((tm) => tm.target_table_id))
  const totalSourceFields = Object.entries(allFieldsByTable)
    .filter(([tid]) => sourceTableIds.has(tid))
    .reduce((sum, [, fields]) => sum + fields.length, 0)
  const totalTargetFields = Object.entries(allFieldsByTable)
    .filter(([tid]) => targetTableIds.has(tid))
    .reduce((sum, [, fields]) => sum + fields.length, 0)
  const coveredSourceFieldIds = new Set(
    allFMs.filter((fm) => fm.status !== 'rejected').map((fm) => fm.source_field_id)
  )
  // Target coverage: count unique target fields with at least one primary non-rejected mapping
  const coveredTargetFieldIds = new Set(
    primaryFMs.filter((fm) => fm.status !== 'rejected').map((fm) => fm.target_field_id)
  )
  const uncoveredCount = Math.max(0, totalSourceFields - coveredSourceFieldIds.size)
  const isFullyCovered = uncoveredCount === 0
  const isTargetFullyCovered = totalTargetFields > 0 && coveredTargetFieldIds.size >= totalTargetFields

  if (totalToReview === 0 && totalSourceFields === 0) return null

  const approvePct = totalToReview > 0 ? (approvedCount / totalToReview) * 100 : 0

  return (
    <div className="bg-white border border-gray-200 rounded-xl px-5 py-4 space-y-3">
      {/* Header row: label left, approved status top-right */}
      <div className="flex items-center justify-between">
        <span className="text-sm font-medium text-gray-700">Mapping Review</span>
        <div className="text-sm text-gray-600 whitespace-nowrap">
          {awaitingCount > 0 ? (
            <>
              <span className="font-medium text-amber-600">{awaitingCount} awaiting</span>
              <span className="text-gray-400 mx-1">·</span>
              <span className="font-semibold text-gray-900">{approvedCount}/{totalToReview}</span>
              <span className="text-gray-500"> approved</span>
            </>
          ) : (
            <>
              <span className="font-semibold text-gray-900">{approvedCount}/{totalToReview}</span>
              <span className="text-gray-500"> approved</span>
              <span className="ml-1 text-green-600">✓</span>
            </>
          )}
        </div>
      </div>

      {/* Full-width progress bar */}
      <div className="w-full h-2 bg-gray-100 rounded-full overflow-hidden">
        <div
          className="h-full bg-green-500 rounded-full transition-all duration-300"
          style={{ width: `${approvePct}%` }}
        />
      </div>

      {/* Coverage metrics — source left, target right */}
      <div className="flex items-center gap-6 text-sm">
        {totalSourceFields > 0 && (
          <div className="flex items-center gap-1.5">
            <span className="w-2 h-2 rounded-full bg-blue-400 inline-block flex-shrink-0" />
            <span className="text-gray-600">
              {coveredSourceFieldIds.size}/{totalSourceFields} source fields used
            </span>
            {uncoveredCount > 0 && (
              <button
                onClick={onShowUncovered}
                className="text-xs text-amber-600 hover:text-amber-700 hover:underline transition-colors"
              >
                ({uncoveredCount} unmapped)
              </button>
            )}
          </div>
        )}
        {totalTargetFields > 0 && (
          <div className="flex items-center gap-1.5">
            {coveredTargetFieldIds.size >= totalTargetFields ? (
              <span className="text-green-600 text-base leading-none">✅</span>
            ) : (
              <span className="w-2 h-2 rounded-full bg-amber-400 inline-block flex-shrink-0" />
            )}
            <span className={coveredTargetFieldIds.size >= totalTargetFields ? 'text-green-700' : 'text-amber-700'}>
              {coveredTargetFieldIds.size}/{totalTargetFields} target fields mapped
            </span>
          </div>
        )}
        {rejectedCount > 0 && (
          <span className="text-sm text-red-500 ml-auto">{rejectedCount} rejected</span>
        )}
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
  const [generatingFields, setGeneratingFields] = useState(false)
  const [error, setError] = useState<string | null>(null)

  function handleAdd() {
    if (!sourceTableId || !targetTableId) return
    setError(null)
    startTransition(async () => {
      // Step 1: Create the table mapping (duplicate check is in server action)
      const result = await addManualTableMapping(projectId, sourceTableId, targetTableId)
      if (!result.success) { setError(result.error ?? 'Failed'); return }

      // Step 2: Auto-generate field mappings with AI
      setGeneratingFields(true)
      await suggestRemainingMappings(result.data!.id)
      setGeneratingFields(false)

      onAdded()
      onClose()
    })
  }

  return (
    <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4">
      <div className="bg-white rounded-xl shadow-xl w-full max-w-md">
        <div className="flex items-center justify-between px-6 py-4 border-b border-gray-100">
          <h2 className="font-semibold text-gray-900">Add New Table Mapping</h2>
          <button onClick={onClose} disabled={pending} className="text-gray-400 hover:text-gray-600 disabled:opacity-40"><X className="w-5 h-5" /></button>
        </div>
        <div className="px-6 py-5 space-y-4">
          <div>
            <label className="block text-xs font-medium text-gray-600 mb-1.5">Source Table</label>
            <select value={sourceTableId} onChange={(e) => setSourceTableId(e.target.value)} disabled={pending} className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500 disabled:opacity-60">
              <option value="">Select source table…</option>
              {allSourceTables.map((t) => <option key={t.id} value={t.id}>{t.datasetName}.{t.name}</option>)}
            </select>
          </div>
          <div>
            <label className="block text-xs font-medium text-gray-600 mb-1.5">Target Table</label>
            <select value={targetTableId} onChange={(e) => setTargetTableId(e.target.value)} disabled={pending} className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500 disabled:opacity-60">
              <option value="">Select target table…</option>
              {allTargetTables.map((t) => <option key={t.id} value={t.id}>{t.datasetName}.{t.name}</option>)}
            </select>
          </div>
          {generatingFields && (
            <div className="flex items-center gap-2.5 px-3 py-2.5 bg-indigo-50 border border-indigo-100 rounded-lg text-xs text-indigo-700">
              <span className="w-3.5 h-3.5 border-2 border-indigo-500 border-t-transparent rounded-full animate-spin flex-shrink-0" />
              Generating field mappings with AI… this may take 15–30 seconds.
            </div>
          )}
          {error && <p className="text-xs text-red-600">{error}</p>}
        </div>
        <div className="flex gap-3 px-6 py-4 border-t border-gray-100">
          <button onClick={onClose} disabled={pending} className="flex-1 px-4 py-2 text-sm font-medium text-gray-700 border border-gray-200 rounded-lg hover:bg-gray-50 disabled:opacity-40">Cancel</button>
          <button onClick={handleAdd} disabled={!sourceTableId || !targetTableId || pending} className="flex-1 px-4 py-2 text-sm font-medium text-white bg-indigo-600 rounded-lg hover:bg-indigo-700 disabled:opacity-40">
            {pending ? (generatingFields ? 'Generating fields…' : 'Adding…') : 'Add Mapping'}
          </button>
        </div>
      </div>
    </div>
  )
}

// ─── Inline Add Field Row ─────────────────────────────────────────────────────

const SUPPRESS_MULTI_TARGET_KEY = 'mine_suppress_multi_target_warning'

type MappingType = 'one_to_one' | 'many_to_one' | 'one_to_many'

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

  // Mapping type selector
  const [mappingType, setMappingType] = useState<MappingType>('one_to_one')
  const [contributingFieldIds, setContributingFieldIds] = useState<string[]>([])
  const [additionalTargetIds, setAdditionalTargetIds] = useState<string[]>([])
  const [combinationHint, setCombinationHint] = useState('')
  const [splitHint, setSplitHint] = useState('')

  // Multi-target warning state
  const [showMultiTargetWarning, setShowMultiTargetWarning] = useState(false)
  const [suppressMTW, setSuppressMTW] = useState(false)
  const [suppressMTWChecked, setSuppressMTWChecked] = useState(false)

  // Multi-source info state
  const [showMultiSourceInfo, setShowMultiSourceInfo] = useState(false)

  // Pending pair when waiting for user to confirm dialogs
  const [pendingPair, setPendingPair] = useState<{ srcId: string; tgtId: string } | null>(null)

  // Read suppress preference from localStorage on mount
  useEffect(() => {
    setSuppressMTW(localStorage.getItem(SUPPRESS_MULTI_TARGET_KEY) === 'true')
  }, [])

  // ALL source fields are available — multi-target is now allowed with a warning
  const allSrcFields = allFieldsByTable[tm.source_table_id] ?? []
  const allTgtFields = allFieldsByTable[tm.target_table_id] ?? []

  // Fields with at least one active (non-rejected) mapping — used for visual indicators
  const activelymappedSrcIds = new Set(
    tm.fieldMappings.filter((fm) => fm.status !== 'rejected').map((fm) => fm.source_field_id)
  )
  const mappedTgtIds = new Set(
    tm.fieldMappings.filter((fm) => fm.status !== 'rejected').map((fm) => fm.target_field_id)
  )

  function proceedWithAdd(srcId: string, tgtId: string, isContributing: boolean) {
    startTransition(async () => {
      const result = await addManualFieldMapping(tm.id, srcId, tgtId, isContributing)
      if (!result.success) { setError(result.error ?? 'Failed'); return }

      const sf = allSrcFields.find((f) => f.id === srcId)
      const tf = allTgtFields.find((f) => f.id === tgtId)
      const newFM: RichFieldMapping = {
        id: result.data!.id,
        table_mapping_id: tm.id,
        source_field_id: srcId,
        target_field_id: tgtId,
        confidence: 100,
        status: 'approved',
        ai_reasoning: isContributing ? 'Contributing source — manually mapped by user' : 'Manually mapped by user',
        similar_fields_considered: null,
        type_compatibility: null,
        is_contributing: isContributing,
        created_at: new Date().toISOString(),
        sourceField: sf ? { id: sf.id, name: sf.name, data_type: sf.data_type, inferred_type: null } : null,
        targetField: tf ? { id: tf.id, name: tf.name, data_type: tf.data_type, inferred_type: null } : null,
        sourceFieldSamples: [],
        targetFieldSamples: [],
        sourceFieldNullPercentage: 0,
      }
      onAdded(newFM)
      setSrcFieldId('')
      setTgtFieldId('')
      setPendingPair(null)
    })
  }

  function checkAndProceed(srcId: string, tgtId: string) {
    setError(null)
    // Step 1: multi-target check — source already has an active mapping in this TM?
    const srcAlreadyMapped = activelymappedSrcIds.has(srcId)
    if (srcAlreadyMapped && !suppressMTW) {
      setPendingPair({ srcId, tgtId })
      setShowMultiTargetWarning(true)
      return
    }
    // Step 2: multi-source check — target already has an active mapping from a different source?
    const tgtAlreadyMapped = mappedTgtIds.has(tgtId)
    if (tgtAlreadyMapped) {
      setPendingPair({ srcId, tgtId })
      setShowMultiSourceInfo(true)
      return
    }
    proceedWithAdd(srcId, tgtId, false)
  }

  // Multi-field submit: many-to-one or one-to-many
  async function handleAddMulti() {
    setError(null)
    const sf = allSrcFields.find((f) => f.id === srcFieldId)
    const tf = allTgtFields.find((f) => f.id === tgtFieldId)

    if (mappingType === 'many_to_one') {
      const primaryReasoning = combinationHint
        ? `Many-to-one mapping — manually created. [Combination: ${combinationHint}]`
        : 'Many-to-one mapping — manually created'
      const primaryResult = await addManualFieldMapping(tm.id, srcFieldId, tgtFieldId, false, primaryReasoning)
      if (!primaryResult.success) { setError(primaryResult.error ?? 'Failed'); return }
      for (const cfId of contributingFieldIds.filter((id) => id !== '')) {
        await addManualFieldMapping(tm.id, cfId, tgtFieldId, true)
      }
      const newFM: RichFieldMapping = {
        id: primaryResult.data!.id,
        table_mapping_id: tm.id,
        source_field_id: srcFieldId,
        target_field_id: tgtFieldId,
        confidence: 100,
        status: 'approved',
        ai_reasoning: primaryReasoning,
        similar_fields_considered: null,
        type_compatibility: null,
        is_contributing: false,
        created_at: new Date().toISOString(),
        sourceField: sf ? { id: sf.id, name: sf.name, data_type: sf.data_type, inferred_type: null } : null,
        targetField: tf ? { id: tf.id, name: tf.name, data_type: tf.data_type, inferred_type: null } : null,
        sourceFieldSamples: [],
        targetFieldSamples: [],
        sourceFieldNullPercentage: 0,
      }
      onAdded(newFM)
      setSrcFieldId(''); setTgtFieldId(''); setContributingFieldIds([]); setCombinationHint('')
    } else if (mappingType === 'one_to_many') {
      const primaryReasoning = splitHint
        ? `One-to-many mapping — manually created. [Split: ${splitHint}]`
        : 'One-to-many mapping — manually created'
      const primaryResult = await addManualFieldMapping(tm.id, srcFieldId, tgtFieldId, false, primaryReasoning)
      if (!primaryResult.success) { setError(primaryResult.error ?? 'Failed'); return }
      for (const tfId of additionalTargetIds.filter((id) => id !== '')) {
        await addManualFieldMapping(tm.id, srcFieldId, tfId, false)
      }
      const newFM: RichFieldMapping = {
        id: primaryResult.data!.id,
        table_mapping_id: tm.id,
        source_field_id: srcFieldId,
        target_field_id: tgtFieldId,
        confidence: 100,
        status: 'approved',
        ai_reasoning: primaryReasoning,
        similar_fields_considered: null,
        type_compatibility: null,
        is_contributing: false,
        created_at: new Date().toISOString(),
        sourceField: sf ? { id: sf.id, name: sf.name, data_type: sf.data_type, inferred_type: null } : null,
        targetField: tf ? { id: tf.id, name: tf.name, data_type: tf.data_type, inferred_type: null } : null,
        sourceFieldSamples: [],
        targetFieldSamples: [],
        sourceFieldNullPercentage: 0,
      }
      onAdded(newFM)
      setSrcFieldId(''); setTgtFieldId(''); setAdditionalTargetIds([]); setSplitHint('')
    }
  }

  function handleAdd() {
    if (!srcFieldId || !tgtFieldId) return
    if (mappingType !== 'one_to_one') {
      startTransition(async () => { await handleAddMulti() })
      return
    }
    checkAndProceed(srcFieldId, tgtFieldId)
  }

  function confirmMultiTarget() {
    if (suppressMTWChecked) localStorage.setItem(SUPPRESS_MULTI_TARGET_KEY, 'true')
    setShowMultiTargetWarning(false)
    // Now check multi-source
    const tgtAlreadyMapped = pendingPair && mappedTgtIds.has(pendingPair.tgtId)
    if (tgtAlreadyMapped) {
      setShowMultiSourceInfo(true)
      return
    }
    if (pendingPair) proceedWithAdd(pendingPair.srcId, pendingPair.tgtId, false)
  }

  function confirmMultiSource() {
    setShowMultiSourceInfo(false)
    if (pendingPair) proceedWithAdd(pendingPair.srcId, pendingPair.tgtId, true)
  }

  function cancelDialog() {
    setShowMultiTargetWarning(false)
    setShowMultiSourceInfo(false)
    setPendingPair(null)
    setSuppressMTWChecked(false)
  }

  if (allSrcFields.length === 0) {
    return (
      <div className="flex items-center justify-between gap-3 px-5 py-3 bg-gray-50 border-t border-gray-100">
        <span className="text-xs text-gray-500">No source fields found for this table.</span>
        <button onClick={onCancel} className="text-xs text-gray-500 hover:text-gray-700 underline flex-shrink-0">Close</button>
      </div>
    )
  }

  if (allTgtFields.length === 0) {
    return (
      <div className="flex items-center justify-between gap-3 px-5 py-3 bg-gray-50 border-t border-gray-100">
        <span className="text-xs text-gray-500">No target fields found for this table.</span>
        <button onClick={onCancel} className="text-xs text-gray-500 hover:text-gray-700 underline flex-shrink-0">Close</button>
      </div>
    )
  }

  const pendingSrcName = pendingPair ? (allSrcFields.find((f) => f.id === pendingPair.srcId)?.name ?? '?') : ''
  const pendingTgtName = pendingPair ? (allTgtFields.find((f) => f.id === pendingPair.tgtId)?.name ?? '?') : ''
  const existingTgtForSrc = pendingPair
    ? tm.fieldMappings.find((f) => f.source_field_id === pendingPair.srcId && f.status !== 'rejected')?.targetField?.name
    : null
  const existingSrcForTgt = pendingPair
    ? tm.fieldMappings.find((f) => f.target_field_id === pendingPair.tgtId && f.status !== 'rejected' && !f.is_contributing)?.sourceField?.name
    : null

  return (
    <>
      {/* Multi-target warning dialog */}
      {showMultiTargetWarning && (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4" onClick={cancelDialog}>
          <div className="bg-white rounded-xl shadow-xl w-full max-w-md p-6 space-y-4" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-start gap-3">
              <span className="text-2xl">⚠️</span>
              <div>
                <h3 className="font-semibold text-gray-900">Multiple Target Mappings</h3>
                <p className="text-sm text-gray-600 mt-1">
                  <strong>&quot;{pendingSrcName}&quot;</strong> is already mapped to <strong>&quot;{existingTgtForSrc}&quot;</strong> in this table mapping.
                  Are you sure you also want to map it to <strong>&quot;{pendingTgtName}&quot;</strong>?
                </p>
                <p className="text-xs text-gray-500 mt-2">
                  This is fine if the same source value is needed in multiple target fields.
                </p>
              </div>
            </div>
            <label className="flex items-center gap-2 text-sm text-gray-600 cursor-pointer select-none">
              <input
                type="checkbox"
                checked={suppressMTWChecked}
                onChange={(e) => setSuppressMTWChecked(e.target.checked)}
                className="rounded border-gray-300 text-indigo-600 focus:ring-indigo-500"
              />
              Don&apos;t show this warning again
            </label>
            <div className="flex justify-end gap-3">
              <button onClick={cancelDialog} className="px-4 py-2 text-sm font-medium text-gray-700 hover:text-gray-900">
                Cancel
              </button>
              <button
                onClick={confirmMultiTarget}
                className="px-4 py-2 text-sm font-medium text-white bg-amber-500 hover:bg-amber-600 rounded-lg"
              >
                Map Anyway
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Multi-source info dialog */}
      {showMultiSourceInfo && (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4" onClick={cancelDialog}>
          <div className="bg-white rounded-xl shadow-xl w-full max-w-md p-6 space-y-4" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-start gap-3">
              <span className="text-2xl">📋</span>
              <div>
                <h3 className="font-semibold text-gray-900">Multiple Source Fields → One Target</h3>
                <p className="text-sm text-gray-600 mt-1">
                  <strong>&quot;{pendingTgtName}&quot;</strong> already receives data from <strong>&quot;{existingSrcForTgt}&quot;</strong>.
                  Adding <strong>&quot;{pendingSrcName}&quot;</strong> as a contributing source.
                </p>
                <p className="text-sm text-gray-600 mt-2">
                  On the Transform tab, write a transformation that combines both fields
                  (e.g., <code className="bg-gray-100 px-1 rounded text-xs">CONCAT(first_name, &apos; &apos;, last_name)</code>).
                  The transform will be set on the primary mapping ({existingSrcForTgt} → {pendingTgtName}).
                </p>
              </div>
            </div>
            <div className="flex justify-end gap-3">
              <button onClick={cancelDialog} className="px-4 py-2 text-sm font-medium text-gray-700 hover:text-gray-900">
                Cancel
              </button>
              <button
                onClick={confirmMultiSource}
                className="px-4 py-2 text-sm font-medium text-white bg-indigo-600 hover:bg-indigo-700 rounded-lg"
              >
                Add Contributing Mapping
              </button>
            </div>
          </div>
        </div>
      )}

      <div className="px-5 py-3 bg-indigo-50/40 border-t border-indigo-100 space-y-2.5">
        {/* Mapping type selector */}
        <div className="flex items-center gap-2">
          <span className="text-xs text-gray-500 flex-shrink-0">Type:</span>
          <div className="flex rounded-lg border border-gray-200 overflow-hidden text-[11px]">
            {([
              { key: 'one_to_one', label: '1 → 1', activeClass: 'bg-gray-800 text-white' },
              { key: 'many_to_one', label: 'Many → 1', activeClass: 'bg-blue-600 text-white' },
              { key: 'one_to_many', label: '1 → Many', activeClass: 'bg-purple-600 text-white' },
            ] as const).map((opt) => (
              <button
                key={opt.key}
                type="button"
                onClick={() => {
                  setMappingType(opt.key)
                  setContributingFieldIds([])
                  setAdditionalTargetIds([])
                  setCombinationHint('')
                  setSplitHint('')
                }}
                className={`px-2.5 py-1 font-medium transition-colors ${mappingType === opt.key ? opt.activeClass : 'bg-white text-gray-600 hover:bg-gray-50'}`}
              >
                {opt.label}
              </button>
            ))}
          </div>
        </div>

        {/* Primary source + target selects */}
        <div className="flex items-center gap-3">
          <select
            value={srcFieldId}
            onChange={(e) => setSrcFieldId(e.target.value)}
            className="flex-1 border border-gray-200 rounded-lg px-2.5 py-1.5 text-xs text-gray-900 bg-white focus:outline-none focus:ring-2 focus:ring-indigo-500"
          >
            <option value="">{mappingType === 'many_to_one' ? 'Primary source field…' : 'Source field…'}</option>
            {allSrcFields.map((f) => (
              <option key={f.id} value={f.id}>
                {f.name} — {f.data_type}{activelymappedSrcIds.has(f.id) ? ' (mapped)' : ''}
              </option>
            ))}
          </select>
          <ArrowRight className="w-3 h-3 text-gray-400 flex-shrink-0" />
          <select
            value={tgtFieldId}
            onChange={(e) => setTgtFieldId(e.target.value)}
            className="flex-1 border border-gray-200 rounded-lg px-2.5 py-1.5 text-xs text-gray-900 bg-white focus:outline-none focus:ring-2 focus:ring-indigo-500"
          >
            <option value="">{mappingType === 'one_to_many' ? 'Primary target field…' : 'Target field…'}</option>
            {allTgtFields.map((f) => (
              <option key={f.id} value={f.id}>
                {f.name} — {f.data_type}{mappedTgtIds.has(f.id) ? ' ✓' : ''}
              </option>
            ))}
          </select>
          <button
            onClick={handleAdd}
            disabled={!srcFieldId || !tgtFieldId || pending}
            className="px-3 py-1.5 text-xs font-medium text-white bg-indigo-600 rounded-lg hover:bg-indigo-700 disabled:opacity-40 flex-shrink-0"
          >
            {pending ? '…' : 'Add'}
          </button>
          <button onClick={onCancel} className="text-gray-400 hover:text-gray-600 flex-shrink-0">
            <X className="w-3.5 h-3.5" />
          </button>
        </div>

        {/* Many-to-one: additional contributing source fields */}
        {mappingType === 'many_to_one' && (
          <div className="space-y-1.5 pl-1">
            <p className="text-[11px] font-medium text-blue-700">Contributing source fields:</p>
            {contributingFieldIds.map((cfId, idx) => (
              <div key={idx} className="flex items-center gap-2">
                <span className="text-gray-300 text-xs">↳</span>
                <select
                  value={cfId}
                  onChange={(e) => {
                    const updated = [...contributingFieldIds]
                    updated[idx] = e.target.value
                    setContributingFieldIds(updated)
                  }}
                  className="flex-1 border border-blue-200 rounded-lg px-2 py-1 text-xs text-gray-900 bg-white focus:outline-none focus:ring-2 focus:ring-blue-400"
                >
                  <option value="">Select contributing field…</option>
                  {allSrcFields
                    .filter((f) => f.id !== srcFieldId && !contributingFieldIds.filter((_, i) => i !== idx).includes(f.id))
                    .map((f) => <option key={f.id} value={f.id}>{f.name} — {f.data_type}</option>)
                  }
                </select>
                <button
                  type="button"
                  onClick={() => setContributingFieldIds((ids) => ids.filter((_, i) => i !== idx))}
                  className="text-gray-400 hover:text-red-500 flex-shrink-0"
                >
                  <X className="w-3 h-3" />
                </button>
              </div>
            ))}
            <button
              type="button"
              onClick={() => setContributingFieldIds((ids) => [...ids, ''])}
              className="text-[11px] text-blue-600 hover:text-blue-800 flex items-center gap-1"
            >
              <Plus className="w-3 h-3" /> Add contributing field
            </button>
          </div>
        )}

        {/* Combination Hint — shown for Many→1 */}
        {mappingType === 'many_to_one' && (
          <div>
            <input
              type="text"
              placeholder="Combination hint, e.g., 'Concatenate with space'"
              value={combinationHint}
              onChange={(e) => setCombinationHint(e.target.value)}
              className="w-full text-xs border border-gray-200 rounded-lg px-2.5 py-1.5 text-gray-700 placeholder:text-gray-400 focus:outline-none focus:ring-1 focus:ring-blue-500"
            />
          </div>
        )}

        {/* One-to-many: additional target fields */}
        {mappingType === 'one_to_many' && (
          <div className="space-y-1.5 pl-1">
            <p className="text-[11px] font-medium text-purple-700">Additional target fields:</p>
            {additionalTargetIds.map((tfId, idx) => (
              <div key={idx} className="flex items-center gap-2">
                <span className="text-gray-300 text-xs">↳</span>
                <select
                  value={tfId}
                  onChange={(e) => {
                    const updated = [...additionalTargetIds]
                    updated[idx] = e.target.value
                    setAdditionalTargetIds(updated)
                  }}
                  className="flex-1 border border-purple-200 rounded-lg px-2 py-1 text-xs text-gray-900 bg-white focus:outline-none focus:ring-2 focus:ring-purple-400"
                >
                  <option value="">Select target field…</option>
                  {allTgtFields
                    .filter((f) => f.id !== tgtFieldId && !additionalTargetIds.filter((_, i) => i !== idx).includes(f.id))
                    .map((f) => <option key={f.id} value={f.id}>{f.name} — {f.data_type}</option>)
                  }
                </select>
                <button
                  type="button"
                  onClick={() => setAdditionalTargetIds((ids) => ids.filter((_, i) => i !== idx))}
                  className="text-gray-400 hover:text-red-500 flex-shrink-0"
                >
                  <X className="w-3 h-3" />
                </button>
              </div>
            ))}
            <button
              type="button"
              onClick={() => setAdditionalTargetIds((ids) => [...ids, ''])}
              className="text-[11px] text-purple-600 hover:text-purple-800 flex items-center gap-1"
            >
              <Plus className="w-3 h-3" /> Add target field
            </button>
          </div>
        )}

        {/* Split Hint — shown for 1→Many */}
        {mappingType === 'one_to_many' && (
          <div>
            <input
              type="text"
              placeholder="Split hint, e.g., 'Split on space separator'"
              value={splitHint}
              onChange={(e) => setSplitHint(e.target.value)}
              className="w-full text-xs border border-gray-200 rounded-lg px-2.5 py-1.5 text-gray-700 placeholder:text-gray-400 focus:outline-none focus:ring-1 focus:ring-purple-500"
            />
          </div>
        )}

        {error && <p className="text-xs text-red-600">{error}</p>}
      </div>
    </>
  )
}

// ─── Field Mapping Row ────────────────────────────────────────────────────────

function FieldMappingRow({
  fm, allTMFMs, onSelect, onApprove, onReject, onDelete,
}: {
  fm: RichFieldMapping
  /** All field mappings in this table mapping — used to compute multi-target/source badges */
  allTMFMs: RichFieldMapping[]
  onSelect: () => void
  onApprove: () => void
  onReject: () => void
  onDelete: () => void
}) {
  const isApproved = fm.status === 'approved'
  const isRejected = fm.status === 'rejected'

  // Contributing rows for this primary's target field (many-to-one detection)
  const contributingFMs = !fm.is_contributing
    ? allTMFMs.filter(
        (f) => f.target_field_id === fm.target_field_id && f.id !== fm.id && f.is_contributing && f.status !== 'rejected'
      )
    : []
  const isManyToOne = contributingFMs.length > 0

  // One-to-many detection: this source field has multiple non-contributing non-rejected primaries
  const oneToManyCount = !fm.is_contributing
    ? allTMFMs.filter(
        (f) => f.source_field_id === fm.source_field_id && !f.is_contributing && f.status !== 'rejected'
      ).length
    : 0
  const isOneToMany = oneToManyCount > 1

  // Contributing rows render as subordinate — indented, no action buttons
  if (fm.is_contributing) {
    return (
      <div
        className={`flex items-center px-5 py-2 cursor-pointer transition-colors ${isRejected ? 'bg-red-50/20' : 'bg-blue-50/20 hover:bg-blue-50/40'}`}
        onClick={onSelect}
      >
        <div className="w-[36%] flex items-center gap-2 min-w-0 pl-5">
          <span className="text-gray-300 flex-shrink-0 text-xs">↳</span>
          <span className={`text-sm truncate ${isRejected ? 'line-through text-gray-400' : 'text-gray-500'}`}>
            {fm.sourceField?.name ?? '—'}
          </span>
          <span className="flex-shrink-0 text-[10px] font-medium px-1.5 py-0.5 rounded bg-slate-100 text-slate-500">
            contributing
          </span>
        </div>
        <div className="w-[28%] flex items-center justify-center gap-1">
          <span className="text-xs text-gray-300">—</span>
        </div>
        <div className="w-[36%] flex items-center gap-1.5 min-w-0">
          <span className={`w-1.5 h-1.5 rounded-full flex-shrink-0 bg-blue-300`} />
          <span className={`text-sm truncate ${isRejected ? 'line-through text-gray-400' : 'text-gray-500'}`}>
            {fm.targetField?.name ?? '—'}
          </span>
        </div>
      </div>
    )
  }

  return (
    <div
      className={`flex items-center px-5 py-3 hover:bg-gray-50 cursor-pointer transition-colors ${isApproved ? 'bg-green-50/60' : isRejected ? 'bg-red-50/30' : ''} ${isManyToOne ? 'border-l-2 border-l-blue-400' : ''}`}
      onClick={onSelect}
    >
      <div className="w-[36%] flex items-center gap-2 min-w-0">
        <span className={`w-2 h-2 rounded-full flex-shrink-0 ${cDot(fm.confidence)}`} />
        {isManyToOne ? (
          <div className="flex flex-col min-w-0 flex-1">
            <div className="flex items-center gap-1.5">
              <span className={`text-sm truncate ${isRejected ? 'line-through text-gray-400' : 'text-gray-900'}`}>
                {fm.sourceField?.name ?? '—'}
              </span>
              <span
                title={`Many-to-one: ${fm.sourceField?.name} + ${contributingFMs.map(c => c.sourceField?.name).join(', ')} → ${fm.targetField?.name}`}
                className="flex-shrink-0 text-[10px] font-medium px-1.5 py-0.5 rounded-full bg-blue-100 text-blue-700 border border-blue-200"
              >
                +{contributingFMs.length}
              </span>
            </div>
            <div className="text-[10px] text-gray-400 truncate mt-0.5">
              {contributingFMs.map((c) => c.sourceField?.name ?? '?').join(', ')}
            </div>
          </div>
        ) : (
          <>
            <span className={`text-sm truncate ${isRejected ? 'line-through text-gray-400' : 'text-gray-900'}`}>
              {fm.sourceField?.name ?? '—'}
            </span>
            {isOneToMany && (
              <span
                title={`One-to-many: ${fm.sourceField?.name} maps to ${oneToManyCount} target fields`}
                className="flex-shrink-0 text-[10px] font-medium px-1.5 py-0.5 rounded-full bg-purple-100 text-purple-700 border border-purple-200"
              >
                1→{oneToManyCount}
              </span>
            )}
          </>
        )}
      </div>
      <div className="w-[28%] flex items-center justify-center gap-1">
        <span className={`text-xs font-semibold ${cText(fm.confidence)}`}>{fm.confidence !== null ? `${fm.confidence}%` : '—'}</span>
        <ArrowRight className="w-3 h-3 text-gray-300" />
      </div>
      <div className="w-[36%] flex items-center justify-between gap-2 min-w-0">
        <div className="flex items-center gap-1.5 min-w-0 flex-1">
          <span className={`w-2 h-2 rounded-full flex-shrink-0 ${cDot(fm.confidence)}`} />
          <span className={`text-sm truncate ${isRejected ? 'line-through text-gray-400' : 'text-gray-900'}`}>
            {fm.targetField?.name ?? '—'}
          </span>
          {/* Primary multi-source badge (when contributing rows exist) */}
          {isManyToOne && (
            <span
              title={`${fm.targetField?.name} receives from ${contributingFMs.length + 1} source fields combined`}
              className="flex-shrink-0 text-[10px] font-medium px-1.5 py-0.5 rounded-full bg-indigo-100 text-indigo-600 border border-indigo-200"
            >
              many→1
            </span>
          )}
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
  regeneratingThis,
  onRegenerate,
  showContributingRows,
  showInlineUnmapped,
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
  regeneratingThis: boolean
  onRegenerate: () => void
  showContributingRows: boolean
  showInlineUnmapped: boolean
}) {
  const srcDs = tm.sourceTable?.dataset
  const tgtDs = tm.targetTable?.dataset
  const activeSrcIds = new Set(tm.fieldMappings.filter((fm) => fm.status !== 'rejected').map((fm) => fm.source_field_id))
  const activeTgtIds = new Set(tm.fieldMappings.filter((fm) => fm.status !== 'rejected').map((fm) => fm.target_field_id))
  const mappedSrcIds = new Set(tm.fieldMappings.map((fm) => fm.source_field_id))
  const mappedTgtIds = new Set(tm.fieldMappings.map((fm) => fm.target_field_id))
  const allSrcFields = allFieldsByTable[tm.source_table_id] ?? []
  const allTgtFields = allFieldsByTable[tm.target_table_id] ?? []
  const availSrc = allSrcFields.filter((f) => !mappedSrcIds.has(f.id))
  const availTgt = allTgtFields.filter((f) => !mappedTgtIds.has(f.id))
  const hasUnmapped = availSrc.length > 0 && availTgt.length > 0
  const unmappedTgtFields = allTgtFields.filter((f) => !activeTgtIds.has(f.id))
  const unmappedSrcFields = allSrcFields.filter((f) => !activeSrcIds.has(f.id))

  // Track which unmapped field's "+ Map" was clicked so InlineAddFieldRow renders right below it
  const [addAfterUnmappedId, setAddAfterUnmappedId] = useState<string | null>(null)
  // Track unmapped fields the user has explicitly approved as "intentionally unmapped"
  const [approvedUnmappedIds, setApprovedUnmappedIds] = useState<Set<string>>(new Set())

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
            onClick={onRegenerate}
            disabled={regeneratingThis}
            title="Regenerate field mappings with AI"
            className="flex items-center gap-1 px-2 py-1 text-xs font-medium text-indigo-600 bg-indigo-50 hover:bg-indigo-100 rounded transition-colors disabled:opacity-50"
          >
            {regeneratingThis ? (
              <>
                <span className="w-2.5 h-2.5 border-2 border-indigo-400 border-t-transparent rounded-full animate-spin" />
                Regenerating…
              </>
            ) : (
              <>
                <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                  <polyline points="23 4 23 10 17 10" /><polyline points="1 20 1 14 7 14" />
                  <path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15" />
                </svg>
                Regenerate
              </>
            )}
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
            (() => {
              // Respect showContributingRows: in most views contributing rows are hidden (they show via +N badge on primary)
              const visibleFMs = showContributingRows
                ? tm.fieldMappings
                : tm.fieldMappings.filter((fm) => !fm.is_contributing)

              // Detect one-to-many groups: source fields with multiple non-contributing non-rejected primary rows
              const srcPrimaryCounts = new Map<string, number>()
              for (const row of visibleFMs) {
                if (row.is_contributing || row.status === 'rejected') continue
                srcPrimaryCounts.set(row.source_field_id, (srcPrimaryCounts.get(row.source_field_id) ?? 0) + 1)
              }
              const oneToManySrcIds = new Set(
                [...srcPrimaryCounts.entries()].filter(([, c]) => c > 1).map(([id]) => id)
              )

              if (oneToManySrcIds.size === 0) {
                // No one-to-many groups — render normally
                return visibleFMs.map((fm) => (
                  <FieldMappingRow
                    key={fm.id}
                    fm={fm}
                    allTMFMs={tm.fieldMappings}
                    onSelect={() => onSelectFM(fm)}
                    onApprove={() => onApproveFM(fm.id)}
                    onReject={() => onRejectFM(fm.id)}
                    onDelete={() => onDeleteFM(fm.id)}
                  />
                ))
              }

              // Render with one-to-many groups wrapped in purple containers
              const rendered = new Set<string>()
              return visibleFMs.map((fm) => {
                if (rendered.has(fm.id)) return null
                rendered.add(fm.id)

                if (!fm.is_contributing && oneToManySrcIds.has(fm.source_field_id)) {
                  const groupRows = visibleFMs.filter(
                    (f) => f.source_field_id === fm.source_field_id && !f.is_contributing
                  )
                  groupRows.forEach((r) => rendered.add(r.id))
                  const srcName = fm.sourceField?.name ?? '?'
                  return (
                    <div key={`otm-${fm.source_field_id}`} className="border-l-2 border-purple-200 my-1">
                      <div className="text-xs text-purple-600 font-medium px-5 py-1 bg-purple-50/50">
                        Split: {srcName} → {groupRows.length} target fields
                      </div>
                      {groupRows.map((row) => (
                        <FieldMappingRow
                          key={row.id}
                          fm={row}
                          allTMFMs={tm.fieldMappings}
                          onSelect={() => onSelectFM(row)}
                          onApprove={() => onApproveFM(row.id)}
                          onReject={() => onRejectFM(row.id)}
                          onDelete={() => onDeleteFM(row.id)}
                        />
                      ))}
                    </div>
                  )
                }

                return (
                  <FieldMappingRow
                    key={fm.id}
                    fm={fm}
                    allTMFMs={tm.fieldMappings}
                    onSelect={() => onSelectFM(fm)}
                    onApprove={() => onApproveFM(fm.id)}
                    onReject={() => onRejectFM(fm.id)}
                    onDelete={() => onDeleteFM(fm.id)}
                  />
                )
              })
            })()
          )}

          {/* Inline unmapped target fields */}
          {showInlineUnmapped && unmappedTgtFields.length > 0 && (
            <div className="border-t border-dashed border-gray-200 mt-2 pt-2">
              <div className="px-5 py-1.5 text-xs font-medium text-gray-400 uppercase tracking-wide">
                Unmapped Target Fields ({unmappedTgtFields.length})
              </div>
              {unmappedTgtFields.map((field) => {
                const isApproved = approvedUnmappedIds.has(field.id)
                return (
                  <div key={field.id}>
                    <div className={`flex items-center px-5 py-2 hover:bg-gray-50 transition-colors ${isApproved ? 'opacity-50' : 'text-gray-400'}`}>
                      <div className="w-[36%] flex items-center gap-2">
                        <span className="text-xs italic text-gray-300">No source field</span>
                      </div>
                      <div className="w-[28%] text-center">
                        <span className="text-xs text-gray-300">—</span>
                      </div>
                      <div className="w-[36%] flex items-center gap-2 min-w-0">
                        <span className={`w-2 h-2 rounded-full flex-shrink-0 ${isApproved ? 'bg-green-500' : field.is_nullable !== false ? 'bg-gray-300' : 'bg-amber-400'}`} />
                        <span className="text-sm text-gray-500 truncate">{field.name}</span>
                        <span className="text-xs text-gray-400 flex-shrink-0">{field.data_type}</span>
                        {field.is_nullable === false && !isApproved && (
                          <span className="text-[10px] font-medium text-amber-600 bg-amber-50 px-1.5 py-0.5 rounded flex-shrink-0">NOT NULL</span>
                        )}
                        {isApproved && (
                          <span className="text-[10px] font-medium text-green-600 bg-green-50 px-1.5 py-0.5 rounded flex-shrink-0">Approved</span>
                        )}
                      </div>
                      <div className="w-28 flex items-center justify-end gap-1 flex-shrink-0">
                        {isApproved ? (
                          <button
                            onClick={() => setApprovedUnmappedIds((prev) => { const next = new Set(prev); next.delete(field.id); return next })}
                            className="text-xs text-gray-400 hover:text-gray-600 font-medium px-2 py-1 rounded hover:bg-gray-100 transition-colors"
                          >
                            Undo
                          </button>
                        ) : (
                          <>
                            <button
                              onClick={() => setApprovedUnmappedIds((prev) => new Set([...prev, field.id]))}
                              title="Approve as intentionally unmapped"
                              className="p-1 rounded text-gray-300 hover:text-green-600 hover:bg-green-50 transition-colors"
                            >
                              <Check className="w-3.5 h-3.5" />
                            </button>
                            <button
                              onClick={() => { setAddAfterUnmappedId(field.id); onShowAddRow(); }}
                              className="text-xs text-blue-600 hover:text-blue-800 font-medium px-2 py-1 rounded hover:bg-blue-50 transition-colors"
                            >
                              + Map
                            </button>
                          </>
                        )}
                      </div>
                    </div>
                    {showAddRow && addAfterUnmappedId === field.id && (
                      <InlineAddFieldRow
                        tm={tm}
                        allFieldsByTable={allFieldsByTable}
                        onAdded={(fm) => { setAddAfterUnmappedId(null); onFieldAdded(fm); }}
                        onCancel={() => { setAddAfterUnmappedId(null); onHideAddRow(); }}
                      />
                    )}
                  </div>
                )
              })}
            </div>
          )}

          {/* Inline unmapped source fields */}
          {showInlineUnmapped && unmappedSrcFields.length > 0 && (
            <div className="border-t border-dashed border-gray-200 mt-1 pt-2">
              <div className="px-5 py-1.5 text-xs font-medium text-gray-400 uppercase tracking-wide">
                Unmapped Source Fields ({unmappedSrcFields.length})
              </div>
              {unmappedSrcFields.map((field) => {
                const isApproved = approvedUnmappedIds.has(field.id)
                return (
                  <div key={field.id}>
                    <div className={`flex items-center px-5 py-2 transition-colors ${isApproved ? 'opacity-50' : 'text-gray-400'}`}>
                      <div className="w-[36%] flex items-center gap-2 min-w-0">
                        <span className={`w-2 h-2 rounded-full flex-shrink-0 ${isApproved ? 'bg-green-500' : 'bg-gray-300'}`} />
                        <span className="text-sm text-gray-500 truncate">{field.name}</span>
                        <span className="text-xs text-gray-400 flex-shrink-0">{field.data_type}</span>
                      </div>
                      <div className="w-[28%] text-center">
                        <span className="text-xs text-gray-300">—</span>
                      </div>
                      <div className="w-[36%] flex items-center gap-2">
                        {isApproved ? (
                          <span className="text-[10px] font-medium text-green-600 bg-green-50 px-1.5 py-0.5 rounded">Approved</span>
                        ) : (
                          <span className="text-xs italic text-gray-300">Not migrated</span>
                        )}
                      </div>
                      <div className="w-28 flex items-center justify-end gap-1 flex-shrink-0">
                        {isApproved ? (
                          <button
                            onClick={() => setApprovedUnmappedIds((prev) => { const next = new Set(prev); next.delete(field.id); return next })}
                            className="text-xs text-gray-400 hover:text-gray-600 font-medium px-2 py-1 rounded hover:bg-gray-100 transition-colors"
                          >
                            Undo
                          </button>
                        ) : (
                          <>
                            <button
                              onClick={() => setApprovedUnmappedIds((prev) => new Set([...prev, field.id]))}
                              title="Approve as intentionally unmapped"
                              className="p-1 rounded text-gray-300 hover:text-green-600 hover:bg-green-50 transition-colors"
                            >
                              <Check className="w-3.5 h-3.5" />
                            </button>
                            <button
                              onClick={() => { setAddAfterUnmappedId(field.id); onShowAddRow(); }}
                              className="text-xs text-blue-600 hover:text-blue-800 font-medium px-2 py-1 rounded hover:bg-blue-50 transition-colors"
                            >
                              + Map
                            </button>
                          </>
                        )}
                      </div>
                    </div>
                    {showAddRow && addAfterUnmappedId === field.id && (
                      <InlineAddFieldRow
                        tm={tm}
                        allFieldsByTable={allFieldsByTable}
                        onAdded={(fm) => { setAddAfterUnmappedId(null); onFieldAdded(fm); }}
                        onCancel={() => { setAddAfterUnmappedId(null); onHideAddRow(); }}
                      />
                    )}
                  </div>
                )
              })}
            </div>
          )}

          {/* Inline add field row — only at bottom when triggered from "Add Field Mapping" button (not from unmapped rows) */}
          {showAddRow && !addAfterUnmappedId && (
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
                onClick={() => { setAddAfterUnmappedId(null); onShowAddRow(); }}
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

  // Compute contributing FMs from the parent table mapping
  const allParentFMs = parentTM?.fieldMappings ?? []
  const contributingFMs = !fm.is_contributing
    ? allParentFMs.filter(
        (f) => f.target_field_id === fm.target_field_id && f.id !== fm.id && f.is_contributing && f.status !== 'rejected'
      )
    : []
  const isManyToOne = contributingFMs.length > 0
  // Primary FM for this target field (when viewing a contributing row)
  const primaryFM = fm.is_contributing
    ? allParentFMs.find((f) => f.target_field_id === fm.target_field_id && !f.is_contributing)
    : null

  return (
    <div className="w-76 flex-shrink-0 bg-white border border-gray-200 rounded-xl overflow-hidden flex flex-col h-fit sticky top-4" style={{ width: '296px' }}>
      <div className="flex items-center justify-between px-5 py-4 border-b border-gray-100">
        <h3 className="font-semibold text-gray-900 text-sm">Mapping Details</h3>
        <button onClick={onClose} className="text-gray-400 hover:text-gray-600"><X className="w-4 h-4" /></button>
      </div>

      <div className="px-5 py-4 space-y-4 overflow-y-auto max-h-[70vh]">
        {/* Contributing row — show info directing to primary */}
        {fm.is_contributing && (
          <div className="p-3 bg-blue-50 border border-blue-100 rounded-lg text-sm text-blue-700 leading-relaxed">
            <p className="font-medium mb-1">Contributing Field</p>
            <p className="text-xs text-blue-600">
              This field contributes to a many-to-one mapping. The transformation SQL is managed on the primary mapping
              {primaryFM ? <> for <strong>{primaryFM.sourceField?.name ?? '?'} → {fm.targetField?.name ?? '?'}</strong></> : null}.
            </p>
          </div>
        )}

        {/* Source → Target display */}
        {isManyToOne ? (
          <div>
            <div className="flex items-center gap-2 mb-2">
              <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide">Source Fields</p>
              <span className="text-xs font-medium px-2 py-0.5 rounded-full bg-blue-100 text-blue-700">
                Many-to-One
              </span>
            </div>
            <div className="space-y-2">
              {/* Primary source */}
              <div className="flex items-start gap-2">
                <span className="w-2 h-2 rounded-full bg-green-500 flex-shrink-0 mt-1.5" />
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-medium text-gray-900 truncate">{fm.sourceField?.name ?? '—'}</p>
                  <p className="text-xs text-gray-400">
                    {fm.sourceField?.data_type}
                    <span className="text-gray-300"> · </span>
                    primary
                    {fm.sourceFieldNullPercentage > 0 && (
                      <span className="ml-1">· null: {fm.sourceFieldNullPercentage.toFixed(0)}%</span>
                    )}
                  </p>
                  {fm.sourceFieldSamples.length > 0 && (
                    <p className="text-xs text-gray-400 mt-0.5 truncate">
                      e.g. {fm.sourceFieldSamples.slice(0, 3).map(v => `"${v}"`).join(', ')}
                    </p>
                  )}
                </div>
              </div>
              {/* Contributing sources */}
              {contributingFMs.map((cf) => (
                <div key={cf.id} className="flex items-start gap-2">
                  <span className="w-2 h-2 rounded-full bg-blue-400 flex-shrink-0 mt-1.5" />
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-medium text-gray-700 truncate">{cf.sourceField?.name ?? '—'}</p>
                    <p className="text-xs text-gray-400">
                      {cf.sourceField?.data_type}
                      <span className="text-gray-300"> · </span>
                      contributing
                      {cf.sourceFieldNullPercentage > 0 && (
                        <span className="ml-1">· null: {cf.sourceFieldNullPercentage.toFixed(0)}%</span>
                      )}
                    </p>
                    {cf.sourceFieldSamples.length > 0 && (
                      <p className="text-xs text-gray-400 mt-0.5 truncate">
                        e.g. {cf.sourceFieldSamples.slice(0, 3).map(v => `"${v}"`).join(', ')}
                      </p>
                    )}
                  </div>
                </div>
              ))}
            </div>
            <div className="flex items-center gap-2 mt-3 pt-3 border-t border-gray-100">
              <ArrowRight className="w-4 h-4 text-gray-400 flex-shrink-0" />
              <div className="min-w-0 flex-1">
                <p className="text-xs text-gray-500 mb-0.5">Target Field</p>
                <p className="font-semibold text-gray-900 text-sm truncate">{fm.targetField?.name ?? '—'}</p>
                <p className="text-xs text-gray-400">{fm.targetField?.data_type}</p>
              </div>
            </div>
            {/* Combination hint from ai_reasoning */}
            {fm.ai_reasoning?.includes('[Combination:') && (
              <div className="mt-2 p-2 bg-blue-50 rounded text-xs text-blue-700">
                <span className="font-medium">Hint: </span>
                {fm.ai_reasoning.match(/\[Combination: (.*?)\]/)?.[1]}
              </div>
            )}
          </div>
        ) : (
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
        )}

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

  const [activeFilter, setActiveFilter] = useState<FilterTab>('all')
  const [expandedIds, setExpandedIds] = useState<Set<string>>(new Set())
  const [selectedFM, setSelectedFM] = useState<RichFieldMapping | null>(null)
  const [showAddModal, setShowAddModal] = useState(false)
  const [showGenerateModal, setShowGenerateModal] = useState(false)
  const [addRowForTMId, setAddRowForTMId] = useState<string | null>(null)
  const [deleteTMTarget, setDeleteTMTarget] = useState<RichTableMapping | null>(null)
  const [regenerateConfirmTarget, setRegenerateConfirmTarget] = useState<RichTableMapping | null>(null)
  const [regeneratingTMId, setRegeneratingTMId] = useState<string | null>(null)
  const [suggestingTMId, setSuggestingTMId] = useState<string | null>(null)
  const [approvingHC, setApprovingHC] = useState(false)
  const [hcConfirmCount, setHcConfirmCount] = useState<number | null>(null)

  // Tab counts
  const allFMs = useMemo(() => tableMappings.flatMap((tm) => tm.fieldMappings), [tableMappings])
  // Needs review: primary rows only (contributing rows are reviewed via their primary)
  const needsReviewCount = useMemo(
    () => allFMs.filter((fm) => !fm.is_contributing && fm.status === 'needs_review').length,
    [allFMs]
  )
  // Approved tab: primary field mappings with status === 'approved'
  const approvedFMCount = useMemo(
    () => allFMs.filter((fm) => !fm.is_contributing && fm.status === 'approved').length,
    [allFMs]
  )
  // Unmapped tab: unique source fields with no active (non-rejected) mapping
  const unmappedCount = useMemo(() => {
    const sourceTableIds = new Set(tableMappings.map((tm) => tm.source_table_id))
    const srcFieldCount = Object.entries(allFieldsByTable)
      .filter(([tid]) => sourceTableIds.has(tid))
      .reduce((sum, [, fields]) => sum + fields.length, 0)
    const coveredIds = new Set(
      allFMs.filter((fm) => fm.status !== 'rejected').map((fm) => fm.source_field_id)
    )
    return Math.max(0, srcFieldCount - coveredIds.size)
  }, [tableMappings, allFieldsByTable, allFMs])

  // Many-to-one count: primary rows that have at least one contributing row
  const manyToOneCount = useMemo(() => {
    return allFMs.filter((fm) => {
      if (fm.is_contributing) return false
      return allFMs.some(
        (f) => f.target_field_id === fm.target_field_id && f.id !== fm.id && f.is_contributing && f.status !== 'rejected'
      )
    }).length
  }, [allFMs])

  // One-to-many count: source fields that appear in 2+ non-contributing non-rejected primary rows
  const oneToManyCount = useMemo(() => {
    const sourceCounts = new Map<string, number>()
    for (const fm of allFMs.filter((f) => !f.is_contributing && f.status !== 'rejected')) {
      sourceCounts.set(fm.source_field_id, (sourceCounts.get(fm.source_field_id) ?? 0) + 1)
    }
    return [...sourceCounts.values()].filter((c) => c > 1).reduce((sum, c) => sum + c, 0)
  }, [allFMs])

  // High-confidence count for bulk approve button
  const hcFMCount = useMemo(() => allFMs.filter((fm) => fm.status === 'needs_review' && (fm.confidence ?? 0) >= 85).length, [allFMs])

  const filteredMappings = useMemo(() => {
    switch (activeFilter) {
      case 'needs_review':
        return tableMappings.filter(
          (tm) => tm.status === 'needs_review' || tm.fieldMappings.some((fm) => !fm.is_contributing && fm.status === 'needs_review')
        )
      case 'approved':
        return tableMappings
          .map((tm) => ({
            ...tm,
            fieldMappings: tm.fieldMappings.filter((fm) => !fm.is_contributing && fm.status === 'approved'),
          }))
          .filter((tm) => tm.fieldMappings.length > 0)
      case 'all':
        return tableMappings
      case 'unmapped':
        return tableMappings
      case 'many_to_one':
        return tableMappings
          .map((tm) => {
            const filtered = tm.fieldMappings.filter((fm) => {
              // Include primary rows that have contributing rows, plus their contributing rows
              if (fm.is_contributing) {
                return tm.fieldMappings.some(
                  (f) => f.target_field_id === fm.target_field_id && !f.is_contributing && f.id !== fm.id && f.status !== 'rejected'
                )
              }
              return tm.fieldMappings.some(
                (f) => f.target_field_id === fm.target_field_id && f.id !== fm.id && f.is_contributing && f.status !== 'rejected'
              )
            })
            return { ...tm, fieldMappings: filtered }
          })
          .filter((tm) => tm.fieldMappings.length > 0)
      case 'one_to_many':
        return tableMappings
          .map((tm) => {
            const filtered = tm.fieldMappings.filter((fm) => {
              if (fm.is_contributing) return false
              const sameSourceCount = tm.fieldMappings.filter(
                (f) => f.source_field_id === fm.source_field_id && !f.is_contributing && f.status !== 'rejected'
              ).length
              return sameSourceCount > 1
            })
            return { ...tm, fieldMappings: filtered }
          })
          .filter((tm) => tm.fieldMappings.length > 0)
      default:
        return []
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
      // Sync unmapped lists: approving a field removes it from the coverage gap
      else refreshData()
    })
  }

  function handleReject(fmId: string) {
    const fm = allFMs.find((f) => f.id === fmId)
    const newStatus = fm?.status === 'rejected' ? 'needs_review' : 'rejected'
    updateFM(fmId, { status: newStatus })
    startTransition(async () => {
      const r = await updateFieldMappingStatus(fmId, newStatus)
      if (!r.success) updateFM(fmId, { status: fm?.status ?? 'needs_review' })
      // Sync unmapped lists: rejecting a mapping may expose a coverage gap
      else refreshData()
    })
  }

  function handleDeleteFM(fmId: string) {
    setTableMappings((prev) => prev.map((tm) => ({ ...tm, fieldMappings: tm.fieldMappings.filter((fm) => fm.id !== fmId) })))
    if (selectedFM?.id === fmId) setSelectedFM(null)
    startTransition(async () => {
      await deleteFieldMapping(fmId)
      // Sync unmapped lists: deleting a mapping may expose a coverage gap
      refreshData()
    })
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
    startTransition(async () => {
      const r = await editFieldMapping(fmId, { ...updates, confidence: null, ai_reasoning: patch.ai_reasoning ?? undefined })
      // Sync unmapped lists: editing source_field_id changes which fields are covered
      if (r.success) refreshData()
    })
  }

  function handleApproveAll(tmId: string) {
    setTableMappings((prev) => prev.map((tm) => tm.id !== tmId ? tm : { ...tm, status: 'approved', fieldMappings: tm.fieldMappings.map((fm) => ({ ...fm, status: 'approved' as const })) }))
    startTransition(async () => {
      await approveAllFieldMappings(tmId)
      refreshData()
    })
  }

  function handleRejectAll(tmId: string) {
    setTableMappings((prev) => prev.map((tm) => tm.id !== tmId ? tm : { ...tm, fieldMappings: tm.fieldMappings.map((fm) => ({ ...fm, status: 'rejected' as const })) }))
    startTransition(async () => {
      await rejectAllFieldMappings(tmId)
      // Sync unmapped lists: rejecting all may expose multiple coverage gaps
      refreshData()
    })
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

  async function handleRegenerate(tmId: string) {
    setRegenerateConfirmTarget(null)
    setRegeneratingTMId(tmId)
    const result = await regenerateFieldMappings(tmId)
    setRegeneratingTMId(null)
    if (result.success) refreshData()
  }

  // Tables not yet in any existing mapping — used for "Generate More" modal
  const mappedSourceIds = useMemo(() => new Set(tableMappings.map((tm) => tm.source_table_id)), [tableMappings])
  const mappedTargetIds = useMemo(() => new Set(tableMappings.map((tm) => tm.target_table_id)), [tableMappings])
  const unmappedSourceTablesForModal = useMemo(
    () => (data?.allSourceTables ?? []).filter((t) => !mappedSourceIds.has(t.id)),
    [data?.allSourceTables, mappedSourceIds]
  )
  const unmappedTargetTablesForModal = useMemo(
    () => (data?.allTargetTables ?? []).filter((t) => !mappedTargetIds.has(t.id)),
    [data?.allTargetTables, mappedTargetIds]
  )

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
    return (
      <div className="px-6 py-8 max-w-2xl mx-auto">
        <div className="text-center mb-8">
          <div className="w-16 h-16 rounded-full bg-indigo-50 flex items-center justify-center mx-auto mb-4">
            <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" className="text-indigo-400">
              <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71" />
              <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71" />
            </svg>
          </div>
          <h3 className="text-lg font-semibold text-gray-900 mb-2">Generate Your Mappings</h3>
          <p className="text-sm text-gray-500 max-w-xs mx-auto">
            Select source and target tables below, then click Generate Mappings. AI will analyze your schemas and suggest field-level mappings with confidence scores.
          </p>
        </div>
        <GenerateMappingsPanel
          projectId={projectId}
          sourceTables={data?.allSourceTables ?? []}
          targetTables={data?.allTargetTables ?? []}
          onDone={() => refreshData()}
        />
      </div>
    )
  }

  return (
    <div className="px-6 py-6 space-y-5">
      {/* Progress bar */}
      <MappingProgress
        tableMappings={tableMappings}
        allFieldsByTable={allFieldsByTable}
        onShowUncovered={() => setActiveFilter('unmapped')}
      />

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
            { key: 'all', label: 'All', count: tableMappings.length, cc: 'bg-gray-200 text-gray-600' },
            { key: 'needs_review', label: 'Needs Review', count: needsReviewCount, cc: 'bg-amber-100 text-amber-700' },
            { key: 'approved', label: 'Approved', count: approvedFMCount, cc: 'bg-green-100 text-green-700' },
            { key: 'unmapped', label: 'Unmapped', count: unmappedCount, cc: 'bg-gray-200 text-gray-600' },
            ...(manyToOneCount > 0 ? [{ key: 'many_to_one' as const, label: 'Many→One', count: manyToOneCount, cc: 'bg-blue-100 text-blue-700' }] : []),
            ...(oneToManyCount > 0 ? [{ key: 'one_to_many' as const, label: 'One→Many', count: oneToManyCount, cc: 'bg-purple-100 text-purple-700' }] : []),
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
          {filteredMappings.length === 0 ? (
            <div className="text-center py-12 text-sm text-gray-400 border border-dashed border-gray-200 rounded-xl">
              {activeFilter === 'needs_review' ? 'All mappings have been reviewed.' : activeFilter === 'approved' ? 'No approved mappings yet.' : activeFilter === 'many_to_one' ? 'No many-to-one mappings found.' : activeFilter === 'one_to_many' ? 'No one-to-many mappings found.' : 'No mappings found.'}
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
                regeneratingThis={regeneratingTMId === tm.id}
                onRegenerate={() => setRegenerateConfirmTarget(tm)}
                showContributingRows={activeFilter === 'many_to_one'}
                showInlineUnmapped={activeFilter === 'all' || activeFilter === 'unmapped'}
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
        <div className="flex items-center gap-3">
          <button onClick={() => setShowAddModal(true)} className="flex items-center gap-2 text-sm font-medium text-gray-600 hover:text-indigo-700 transition-colors">
            <Plus className="w-4 h-4" />
            Add New Mapping
          </button>
          {unmappedSourceTablesForModal.length > 0 && unmappedTargetTablesForModal.length > 0 && (
            <button
              onClick={() => setShowGenerateModal(true)}
              className="flex items-center gap-1.5 text-sm font-medium text-indigo-600 hover:text-indigo-800 transition-colors"
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <polyline points="23 4 23 10 17 10" /><polyline points="1 20 1 14 7 14" />
                <path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15" />
              </svg>
              Generate More Mappings
            </button>
          )}
        </div>
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

      {showGenerateModal && (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4">
          <div className="bg-white rounded-xl shadow-xl w-full max-w-2xl max-h-[90vh] overflow-y-auto">
            <div className="flex items-center justify-between px-6 py-4 border-b border-gray-100">
              <div>
                <h2 className="font-semibold text-gray-900">Generate More Mappings</h2>
                <p className="text-xs text-gray-500 mt-0.5">Only unmapped tables are shown. Existing mappings will be preserved.</p>
              </div>
              <button onClick={() => setShowGenerateModal(false)} className="text-gray-400 hover:text-gray-600">
                <X className="w-5 h-5" />
              </button>
            </div>
            <div className="px-6 py-5">
              <GenerateMappingsPanel
                projectId={projectId}
                sourceTables={unmappedSourceTablesForModal}
                targetTables={unmappedTargetTablesForModal}
                onDone={({ generated }) => {
                  setShowGenerateModal(false)
                  if (generated > 0) refreshData()
                }}
                onCancel={() => setShowGenerateModal(false)}
              />
            </div>
          </div>
        </div>
      )}

      {deleteTMTarget && (
        <DeleteConfirmDialog
          message={`Remove ${deleteTMTarget.sourceTable?.name ?? '?'} → ${deleteTMTarget.targetTable?.name ?? '?'} and all ${deleteTMTarget.fieldMappings.length} field mapping${deleteTMTarget.fieldMappings.length !== 1 ? 's' : ''}?`}
          onConfirm={confirmDeleteTM}
          onCancel={() => setDeleteTMTarget(null)}
        />
      )}

      {regenerateConfirmTarget && (
        <RegenerateConfirmDialog
          sourceTableName={regenerateConfirmTarget.sourceTable?.name ?? '?'}
          targetTableName={regenerateConfirmTarget.targetTable?.name ?? '?'}
          fieldCount={regenerateConfirmTarget.fieldMappings.length}
          onConfirm={() => handleRegenerate(regenerateConfirmTarget.id)}
          onCancel={() => setRegenerateConfirmTarget(null)}
        />
      )}
    </div>
  )
}
