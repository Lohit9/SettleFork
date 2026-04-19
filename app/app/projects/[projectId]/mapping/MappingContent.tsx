'use client'

import { useState, useMemo, useTransition, useCallback, useEffect, useRef } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import {
  TableFieldFilter,
  type FilterTable,
  type TableFieldSelection,
} from '@/components/app/TableFieldFilter'
import { Check, CheckCircle, Pencil, X, ChevronDown, ChevronRight, ArrowRight, Plus } from '@/components/icons'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { PageHeader } from '@/components/app/PageHeader'
import { type ProjectInfo } from '@/components/app/ProjectInfoPopover'
import {
  updateFieldMappingStatus,
  editFieldMapping,
  addManualFieldMapping,
  addManualTableMapping,
  deleteFieldMapping,
  deleteTableMapping,
  approveAllFieldMappings,
  rejectAllFieldMappings,
  suggestRemainingMappings,
  regenerateFieldMappings,
  generateMappings,
  mapUnmappedField,
  getMappings,
  checkFieldMappingHasTransform,
  handleTargetFieldConflict,
} from '@/lib/actions/mappings'
import { checkPKSourceChangeImpact } from '@/lib/actions/fk-cascade'
import { TransformResetWarning } from '@/components/app/TransformResetWarning'
import type {
  MappingsResult,
  RichTableMapping,
  RichFieldMapping,
  UnmappedField,
  SimpleField,
  FieldAcknowledgmentRow,
} from '@/lib/actions/mappings'
import { acknowledgeField, removeAcknowledgment } from '@/lib/actions/field-acknowledgments'
import { useProjectRole } from '@/lib/hooks/useProjectRole'
import { RoleTooltip } from '@/components/app/RoleTooltip'
import { FieldPicker, type PickerField } from '@/components/app/FieldPicker'
import { FixDrawer } from '@/components/ui/fix-drawer'

// ─── Props ────────────────────────────────────────────────────────────────────

interface Props {
  projectId: string
  projectName: string
  initialData: MappingsResult | null
  projectInfo?: ProjectInfo
}

type StatusFilter = 'all' | 'needs_review' | 'approved' | 'unmapped'

// ─── Confidence helpers ───────────────────────────────────────────────────────

function cBg(c: number | null) {
  if (c === null) return 'bg-settle-slate-100 text-settle-slate-500'
  return 'bg-settle-slate-100 text-settle-slate-600'
}
function cDot(c: number | null) {
  if (c === null) return 'bg-settle-slate-200'
  return 'bg-settle-slate-300'
}
function cBar(c: number | null) {
  if (c === null) return 'bg-gray-300'
  if (c >= 75) return 'bg-green-500'
  if (c >= 50) return 'bg-amber-500'
  return 'bg-red-500'
}
function cText(c: number | null) {
  if (c === null) return 'text-settle-slate-400'
  return 'text-settle-slate-500'
}

// ─── Small shared components ──────────────────────────────────────────────────

function ConfidenceBadge({ confidence }: { confidence: number | null }) {
  if (confidence === null) return null
  return <span className={`px-2 py-0.5 text-xs font-semibold rounded-full ${cBg(confidence)}`}>{confidence}%</span>
}

function StatusBadge({ status }: { status: RichTableMapping['status'] }) {
  if (status === 'approved') {
    return (
      <div className="flex items-center gap-1.5">
        <span className="w-1.5 h-1.5 rounded-full bg-green-500 flex-shrink-0" />
        <span className="text-xs text-settle-slate-500">Approved</span>
      </div>
    )
  }
  if (status === 'needs_review') {
    return (
      <div className="flex items-center gap-1.5">
        <span className="w-1.5 h-1.5 rounded-full bg-amber-400 flex-shrink-0" />
        <span className="text-xs text-settle-slate-500">Needs Review</span>
      </div>
    )
  }
  if (status === 'rejected') {
    return (
      <div className="flex items-center gap-1.5">
        <span className="w-1.5 h-1.5 rounded-full bg-settle-slate-300 flex-shrink-0" />
        <span className="text-xs text-settle-slate-400">Rejected</span>
      </div>
    )
  }
  return null
}

// Trash icon inline
function TrashIcon({ className = '' }: { className?: string }) {
  return (
    <svg className={`w-4 h-4 ${className}`} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
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
}: {
  title: string
  tables: { id: string; name: string; datasetName: string }[]
  selected: Set<string>
  onToggle: (id: string) => void
}) {
  const allSelected = tables.length > 0 && tables.every((t) => selected.has(t.id))
  const noneSelected = tables.every((t) => !selected.has(t.id))

  function toggleAll() {
    if (allSelected) tables.forEach((t) => onToggle(t.id))
    else tables.filter((t) => !selected.has(t.id)).forEach((t) => onToggle(t.id))
  }

  return (
    <div className="border border-gray-200 rounded-lg flex flex-col">
      <div className="flex items-center justify-between px-3 py-2.5 border-b border-gray-100">
        <h4 className="text-sm font-medium text-gray-900">{title}</h4>
        <button
          onClick={toggleAll}
          className="text-xs text-gray-500 hover:text-gray-700 transition-colors"
        >
          {allSelected ? 'Deselect all' : 'Select all'}
        </button>
      </div>
      {tables.length === 0 ? (
        <p className="text-xs text-gray-400 px-3 py-3">No tables available.</p>
      ) : (
        <div className="divide-y divide-gray-100 overflow-y-auto max-h-56">
          {tables.map((t) => (
            <label key={t.id} className="flex items-center gap-3 px-3 py-2.5 hover:bg-gray-50 transition-colors cursor-pointer">
              <input
                type="checkbox"
                checked={selected.has(t.id)}
                onChange={() => onToggle(t.id)}
                className="rounded border-gray-300 text-primary focus:ring-primary/20 cursor-pointer"
              />
              <span className="text-sm text-gray-900">{t.name}</span>
              {t.datasetName && (
                <span className="text-xs text-gray-400 truncate">{t.datasetName}</span>
              )}
            </label>
          ))}
        </div>
      )}
      <p className="text-xs text-gray-400 px-3 py-2 border-t border-gray-100">
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
  canEdit = true,
}: {
  projectId: string
  sourceTables: { id: string; name: string; datasetName: string }[]
  targetTables: { id: string; name: string; datasetName: string }[]
  onDone: (result: { generated: number; skipped: number; message?: string }) => void
  onCancel?: () => void
  canEdit?: boolean
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
        <div className="absolute inset-0 bg-white/95 flex items-center justify-center z-10 rounded-lg">
          <div className="text-center px-4">
            <div className="w-10 h-10 border-4 border-blue-600 border-t-transparent rounded-full animate-spin mx-auto mb-3" />
            <p className="font-semibold text-gray-900 text-sm">Generating AI-powered mappings…</p>
            <p className="text-xs text-gray-500 mt-1">Analyzing schemas and sample data. This may take 15–30 seconds.</p>
          </div>
        </div>
      )}

      <div className="grid grid-cols-2 gap-5 mb-5">
        <TableSelector
          title="Source tables"
          tables={sourceTables}
          selected={selectedSrc}
          onToggle={toggleSrc}
        />
        <TableSelector
          title="Target tables"
          tables={targetTables}
          selected={selectedTgt}
          onToggle={toggleTgt}
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
          <button onClick={onCancel} className="px-4 py-2 text-sm font-medium text-gray-700 bg-white border border-gray-300 rounded-lg hover:bg-gray-50 transition-colors">
            Cancel
          </button>
        ) : <div />}
        <RoleTooltip allowed={canEdit} requiredRole="Editor">
          <button
            onClick={handleGenerate}
            disabled={!canGenerate || generating || !canEdit}
            className="px-5 py-2.5 text-sm font-medium text-white bg-primary rounded-lg hover:bg-primary/90 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
          >
            {generating ? 'Generating…' : 'Generate Mappings'}
          </button>
        </RoleTooltip>
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
              Any approved mappings, generated transforms, and staged data will be cleared.
            </p>
          </div>
        </div>
        <div className="flex gap-3">
          <button onClick={onCancel} className="flex-1 px-4 py-2.5 text-sm font-medium text-gray-700 bg-white border border-gray-300 rounded-lg hover:bg-gray-50 transition-colors">Cancel</button>
          <button onClick={onConfirm} className="flex-1 px-4 py-2.5 text-sm font-medium text-gray-700 bg-white border border-gray-300 rounded-lg hover:bg-gray-50 transition-colors">Regenerate</button>
        </div>
      </div>
    </div>
  )
}


// ─── Mapping Stat Pills ──────────────────────────────────────────────────────

function MappingStatPills({
  total,
  approved,
  needsReview,
  sourceDatasetName,
  targetDatasetName,
}: {
  total: number
  approved: number
  needsReview: number
  sourceDatasetName?: string
  targetDatasetName?: string
}) {
  return (
    <div className="flex items-center px-5 py-2 bg-white flex-shrink-0">
      {(sourceDatasetName || targetDatasetName) && (
        <div className="flex items-center gap-2 mr-4 pr-4 border-r border-gray-100">
          <span className="text-xs text-settle-slate-500 font-medium">{sourceDatasetName}</span>
          <span className="text-settle-slate-300 text-xs">→</span>
          <span className="text-xs text-settle-slate-500 font-medium">{targetDatasetName}</span>
        </div>
      )}
      <div className="flex items-center gap-3 text-sm text-settle-slate-600">
        <span>
          Total{' '}
          <span className="font-semibold text-settle-slate-900">{total}</span>
        </span>
        <span className="text-settle-slate-300">·</span>
        <span className="flex items-center gap-1.5">
          <span className="w-1.5 h-1.5 rounded-full bg-green-500" />
          Approved{' '}
          <span className="font-semibold text-settle-slate-900">{approved}</span>
        </span>
        <span className="text-settle-slate-300">·</span>
        <span className="flex items-center gap-1.5">
          <span className="w-1.5 h-1.5 rounded-full bg-amber-400" />
          Needs Review{' '}
          <span className="font-semibold text-settle-slate-900">{needsReview}</span>
        </span>
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
          <button onClick={onCancel} className="flex-1 px-4 py-2.5 text-sm font-medium text-gray-700 bg-white border border-gray-300 rounded-lg hover:bg-gray-50 transition-colors">Cancel</button>
          <button onClick={onConfirm} className="flex-1 px-4 py-2.5 text-sm font-medium text-white bg-red-600 rounded-lg hover:bg-red-700 transition-colors">Remove</button>
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
      const suggestResult = await suggestRemainingMappings(result.data!.id)
      setGeneratingFields(false)
      if (!suggestResult.success) {
        setError(
          suggestResult.error ??
            'Field suggestion failed. The table mapping was added — open the card and use “Suggest remaining”.'
        )
        onAdded()
        return
      }

      onAdded()
      onClose()
    })
  }

  return (
    <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4">
      <div className="bg-white rounded-xl shadow-xl w-full max-w-md">
        <div className="flex items-center justify-between px-6 py-4 border-b border-gray-100">
          <h2 className="text-lg font-semibold text-gray-900">Add New Table Mapping</h2>
          <button onClick={onClose} disabled={pending} className="text-gray-400 hover:text-gray-600 disabled:opacity-40"><X className="w-5 h-5" /></button>
        </div>
        <div className="px-6 py-5 space-y-4">
          <div>
            <label className="block text-xs font-medium text-gray-600 mb-1.5">Source Table</label>
            <Select value={sourceTableId} onValueChange={(val) => setSourceTableId(val)} disabled={pending}>
              <SelectTrigger className="h-9 text-sm w-full">
                <SelectValue placeholder="Select source table…" />
              </SelectTrigger>
              <SelectContent>
                {allSourceTables.map((t) => (
                  <SelectItem key={t.id} value={t.id}>{t.datasetName}.{t.name}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div>
            <label className="block text-xs font-medium text-gray-600 mb-1.5">Target Table</label>
            <Select value={targetTableId} onValueChange={(val) => setTargetTableId(val)} disabled={pending}>
              <SelectTrigger className="h-9 text-sm w-full">
                <SelectValue placeholder="Select target table…" />
              </SelectTrigger>
              <SelectContent>
                {allTargetTables.map((t) => (
                  <SelectItem key={t.id} value={t.id}>{t.datasetName}.{t.name}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          {generatingFields && (
            <div className="flex items-center gap-2.5 px-3 py-2.5 bg-blue-50 border border-blue-100 rounded-lg text-xs text-blue-700">
              <span className="w-3.5 h-3.5 border-2 border-blue-500 border-t-transparent rounded-full animate-spin flex-shrink-0" />
              Generating field mappings with AI… this may take 15–30 seconds.
            </div>
          )}
          {error && <p className="text-xs text-red-600">{error}</p>}
        </div>
        <div className="flex gap-3 px-6 py-4 border-t border-gray-100">
          <button onClick={onClose} disabled={pending} className="flex-1 px-4 py-2 text-sm font-medium text-gray-700 bg-white border border-gray-300 rounded-lg hover:bg-gray-50 transition-colors disabled:opacity-40">Cancel</button>
          <button onClick={handleAdd} disabled={!sourceTableId || !targetTableId || pending} className="flex-1 px-4 py-2 text-sm font-medium text-white bg-primary rounded-lg hover:bg-primary/90 transition-colors disabled:opacity-40">
            {pending ? (generatingFields ? 'Generating fields…' : 'Adding…') : 'Add Mapping'}
          </button>
        </div>
      </div>
    </div>
  )
}

// ─── Inline Add Field Row ─────────────────────────────────────────────────────

const SUPPRESS_MULTI_TARGET_KEY = 'settle_suppress_multi_target_warning'
const SUPPRESS_MULTI_TARGET_KEY_LEGACY = 'mine_suppress_multi_target_warning'

type MappingType = 'one_to_one' | 'many_to_one' | 'one_to_many'

function InlineAddFieldRow({
  tm,
  allFieldsByTable,
  onAdded,
  onCancel,
  onSync,
  initialSourceFieldId,
  initialTargetFieldId,
}: {
  tm: RichTableMapping
  allFieldsByTable: Record<string, SimpleField[]>
  onAdded: (newFM: RichFieldMapping) => void
  onCancel: () => void
  /** Resync from server after a partial failure (e.g. primary row saved but contributing adds failed). */
  onSync?: () => void
  initialSourceFieldId?: string
  initialTargetFieldId?: string
}) {
  const [srcFieldId, setSrcFieldId] = useState(initialSourceFieldId ?? '')
  const [tgtFieldId, setTgtFieldId] = useState(initialTargetFieldId ?? '')
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
    setSuppressMTW(
      localStorage.getItem(SUPPRESS_MULTI_TARGET_KEY) === 'true' ||
      localStorage.getItem(SUPPRESS_MULTI_TARGET_KEY_LEGACY) === 'true'
    )
  }, [])

  // ALL source fields are available — multi-target is now allowed with a warning
  const allSrcFields = allFieldsByTable[tm.source_table_id] ?? []
  const allTgtFields = allFieldsByTable[tm.target_table_id] ?? []

  // Fields with at least one active (non-rejected) mapping — used for visual indicators
  const activelymappedSrcIds = new Set(
    tm.fieldMappings.filter((fm) => fm.status !== 'rejected' && fm.source_field_id).map((fm) => fm.source_field_id as string)
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
        transformation: null,
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
        const cr = await addManualFieldMapping(tm.id, cfId, tgtFieldId, true)
        if (!cr.success) {
          setError(cr.error ?? 'Failed to add contributing field')
          onSync?.()
          return
        }
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
        transformation: null,
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
        const tr = await addManualFieldMapping(tm.id, srcFieldId, tfId, false)
        if (!tr.success) {
          setError(tr.error ?? 'Failed to add additional target mapping')
          onSync?.()
          return
        }
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
        transformation: null,
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
                <h3 className="text-lg font-semibold text-gray-900">Multiple Target Mappings</h3>
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
                className="rounded border-gray-300 text-blue-600 focus:ring-blue-500"
              />
              Don&apos;t show this warning again
            </label>
            <div className="flex justify-end gap-3">
              <button onClick={cancelDialog} className="px-4 py-2 text-sm font-medium text-gray-700 bg-white border border-gray-300 rounded-lg hover:bg-gray-50 transition-colors">
                Cancel
              </button>
              <button
                onClick={confirmMultiTarget}
                className="px-4 py-2 text-sm font-medium text-gray-700 bg-white border border-gray-300 rounded-lg hover:bg-gray-50 transition-colors"
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
                <h3 className="text-lg font-semibold text-gray-900">Multiple Source Fields → One Target</h3>
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
              <button onClick={cancelDialog} className="px-4 py-2 text-sm font-medium text-gray-700 bg-white border border-gray-300 rounded-lg hover:bg-gray-50 transition-colors">
                Cancel
              </button>
              <button
                onClick={confirmMultiSource}
                className="px-4 py-2 text-sm font-medium text-white bg-primary hover:bg-primary/90 transition-colors rounded-lg"
              >
                Add Contributing Mapping
              </button>
            </div>
          </div>
        </div>
      )}

      <div className="px-5 py-3 bg-blue-50/40 border-t border-blue-100 space-y-2.5">
        {/* Mapping type selector */}
        <div className="flex items-center gap-2">
          <span className="text-xs text-gray-500 flex-shrink-0">Type:</span>
          <div className="flex rounded-lg border border-gray-100 overflow-hidden text-[11px]">
            {([
              { key: 'one_to_one', label: '1 → 1', activeClass: 'bg-gray-800 text-white' },
              { key: 'many_to_one', label: 'Many → 1', activeClass: 'bg-primary text-white' },
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
        <Select value={srcFieldId} onValueChange={(val) => setSrcFieldId(val)}>
          <SelectTrigger className="flex-1 h-8 text-xs">
            <SelectValue placeholder={mappingType === 'many_to_one' ? 'Primary source field…' : 'Source field…'} />
          </SelectTrigger>
          <SelectContent>
            {allSrcFields.map((f) => (
              <SelectItem key={f.id} value={f.id}>
                {f.name} — {f.data_type}{activelymappedSrcIds.has(f.id) ? ' (mapped)' : ''}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <ArrowRight className="w-3 h-3 text-gray-400 flex-shrink-0" />
        <Select value={tgtFieldId} onValueChange={(val) => setTgtFieldId(val)}>
          <SelectTrigger className="flex-1 h-8 text-xs">
            <SelectValue placeholder={mappingType === 'one_to_many' ? 'Primary target field…' : 'Target field…'} />
          </SelectTrigger>
          <SelectContent>
            {allTgtFields.map((f) => (
              <SelectItem key={f.id} value={f.id}>
                {f.name} — {f.data_type}{mappedTgtIds.has(f.id) ? ' ✓' : ''}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <button
          onClick={handleAdd}
          disabled={!srcFieldId || !tgtFieldId || pending}
          className="px-3 py-1.5 text-xs font-medium text-white bg-primary rounded-lg hover:bg-primary/90 transition-colors disabled:opacity-40 flex-shrink-0"
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
                <Select
                  value={cfId}
                  onValueChange={(val) => {
                    const updated = [...contributingFieldIds]
                    updated[idx] = val
                    setContributingFieldIds(updated)
                  }}
                >
                  <SelectTrigger className="flex-1 h-7 text-xs border-blue-200">
                    <SelectValue placeholder="Select contributing field…" />
                  </SelectTrigger>
                  <SelectContent>
                    {allSrcFields
                      .filter((f) => f.id !== srcFieldId && !contributingFieldIds.filter((_, i) => i !== idx).includes(f.id))
                      .map((f) => <SelectItem key={f.id} value={f.id}>{f.name} — {f.data_type}</SelectItem>)
                    }
                  </SelectContent>
                </Select>
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
                <Select
                  value={tfId}
                  onValueChange={(val) => {
                    const updated = [...additionalTargetIds]
                    updated[idx] = val
                    setAdditionalTargetIds(updated)
                  }}
                >
                  <SelectTrigger className="flex-1 h-7 text-xs border-purple-200">
                    <SelectValue placeholder="Select target field…" />
                  </SelectTrigger>
                  <SelectContent>
                    {allTgtFields
                      .filter((f) => f.id !== tgtFieldId && !additionalTargetIds.filter((_, i) => i !== idx).includes(f.id))
                      .map((f) => <SelectItem key={f.id} value={f.id}>{f.name} — {f.data_type}</SelectItem>)
                    }
                  </SelectContent>
                </Select>
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

// ─── Source Field Chip ────────────────────────────────────────────────────────

/**
 * One equal-peer chip for a source field inside a many-to-one mapping. Every
 * contributor to a target column is rendered as one of these — including the
 * row physically marked `is_contributing = false` (the DB's "primary" is an
 * implementation detail, not a user-facing concept). The × button removes
 * just that peer's field_mappings row; if the removed row happened to be the
 * primary, the server and the optimistic patch both promote the first
 * remaining contributor so the mapping survives unbroken.
 */
function SourceFieldChip({
  name,
  onRemove,
  disabled = false,
  title,
}: {
  name: string
  onRemove?: () => void
  disabled?: boolean
  title?: string
}) {
  return (
    <span
      className="inline-flex items-center gap-1 flex-shrink-0 text-xs font-mono px-1.5 py-0.5 rounded-md border border-gray-200 bg-white text-settle-slate-800"
      title={title ?? name}
    >
      <span className="truncate max-w-[110px]">{name}</span>
      {onRemove && !disabled && (
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation()
            onRemove()
          }}
          title={`Remove ${name} from this mapping`}
          className="flex items-center justify-center w-3.5 h-3.5 rounded text-settle-slate-300 hover:text-red-500 hover:bg-red-50 transition-colors"
        >
          <X className="w-3 h-3" />
        </button>
      )}
    </span>
  )
}

// ─── Field Mapping Row ────────────────────────────────────────────────────────

// RoleTooltip is imported from @/components/app/RoleTooltip

function FieldMappingRow({
  fm, allTMFMs, onSelect, onApprove, onReject, onDelete, onDeleteFM, canEdit = true, isSelected = false,
  onEditTarget, targetTableFields, targetTableName,
}: {
  fm: RichFieldMapping
  allTMFMs: RichFieldMapping[]
  onSelect: () => void
  onApprove: () => void
  onReject: () => void
  onDelete: () => void
  /** Deletes a specific peer field_mapping (used by per-chip × buttons on
   *  many-to-one rows). Distinct from `onDelete` which is bound to this row. */
  onDeleteFM?: (fmId: string) => void
  canEdit?: boolean
  isSelected?: boolean
  onEditTarget?: (fieldId: string) => void
  targetTableFields?: PickerField[]
  targetTableName?: string
}) {
  const [isEditingTarget, setIsEditingTarget] = useState(false)
  const targetCellRef = useRef<HTMLDivElement>(null)
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
  const oneToManyCount = !fm.is_contributing && fm.source_field_id
    ? allTMFMs.filter(
        (f) => f.source_field_id === fm.source_field_id && !f.is_contributing && f.status !== 'rejected'
  ).length
    : 0
  const isOneToMany = oneToManyCount > 1

  // Value assignment rows — no source field, purple accent
  const isValueAssignment = fm.source_field_id === null
  if (isValueAssignment) {
  return (
    <div
        className={`flex items-center px-5 py-3 cursor-pointer transition-colors ${isSelected ? 'bg-blue-50 border-l-[3px] border-l-blue-600' : `hover:bg-gray-50 border-l-2 border-l-purple-400 ${isApproved ? 'bg-purple-50/40' : ''}`}`}
        onClick={onSelect}
      >
        <div className="w-[36%] flex items-center gap-2 min-w-0">
          <span className="text-purple-500 text-xs font-mono flex-shrink-0">ƒ</span>
          <span className="text-xs text-purple-600 font-medium">Value Assignment</span>
        </div>
        <div className="w-[28%] flex items-center justify-center gap-1">
          <span className="text-xs text-gray-400">—</span>
          <ArrowRight className="w-3 h-3 text-gray-300" />
        </div>
        <div className="w-[36%] flex items-center justify-between gap-2 min-w-0">
          <div className="flex items-center gap-1.5 min-w-0 flex-1">
            <span className="w-2 h-2 rounded-full flex-shrink-0 bg-purple-400" />
            <span className="text-sm font-medium text-gray-900 truncate">{fm.targetField?.name ?? '—'}</span>
          </div>
          <div className="flex items-center gap-0.5 flex-shrink-0">
            <button onClick={(e) => { e.stopPropagation(); if (canEdit) onDelete(); }} disabled={!canEdit} className="p-1 rounded transition-colors text-gray-300 hover:text-red-500 hover:bg-red-50 disabled:opacity-40 disabled:cursor-not-allowed" title="Remove value assignment">
              <X className="w-3.5 h-3.5" />
            </button>
          </div>
        </div>
      </div>
    )
  }

  // Contributing rows render as subordinate — indented, no action buttons
  if (fm.is_contributing) {
    return (
      <div
        className={`flex items-center px-5 py-2 cursor-pointer transition-colors ${isSelected ? 'bg-blue-100/60 border-l-[3px] border-l-blue-600' : isRejected ? 'bg-red-50/20' : 'bg-blue-50/20 hover:bg-blue-50/40'}`}
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
      className={`grid grid-cols-[1fr_80px_1fr] items-center px-4 py-0 min-h-[40px] cursor-pointer transition-colors group ${isSelected ? 'bg-blue-50 border-l-2 border-settle-blue-500' : 'hover:bg-settle-slate-50'} ${fm.status === 'rejected' ? 'opacity-50' : ''}`}
      onClick={onSelect}
    >
      <div className="flex items-center gap-2 min-w-0 pr-2">
        <span
          className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${
            fm.status === 'approved'
              ? 'bg-green-500'
              : fm.status === 'needs_review'
              ? 'bg-amber-400'
              : 'bg-settle-slate-300'
          }`}
        />
        {isManyToOne ? (
          // All peers (primary + contributors) render as equal chips. Each
          // chip can be removed independently via its own × button: deleting
          // the primary chip is handled by the server + executeDeleteFM's
          // optimistic patch, which promote the first remaining contributor
          // so the mapping stays intact instead of briefly flickering away.
          // If only one chip remains after a removal the row naturally falls
          // back to the 1:1 render path on the next `refreshData()` tick.
          <div className="flex flex-wrap items-center gap-1 min-w-0 flex-1">
            {[fm, ...contributingFMs].map((peer) => (
              <SourceFieldChip
                key={peer.id}
                name={peer.sourceField?.name ?? '?'}
                onRemove={
                  canEdit && onDeleteFM
                    ? () => onDeleteFM(peer.id)
                    : undefined
                }
                title={`${peer.sourceField?.name ?? '?'} — one of ${contributingFMs.length + 1} source fields combining into ${fm.targetField?.name ?? 'target'}`}
              />
            ))}
          </div>
        ) : (
          <>
            <span className="text-xs text-settle-slate-900 font-mono truncate">
              {fm.sourceField?.name ?? <span className="text-settle-slate-400 italic">unmapped</span>}
            </span>
            {isOneToMany && (
              <span
                title={`One-to-many: ${fm.sourceField?.name} maps to ${oneToManyCount} target fields`}
                className="flex-shrink-0 text-[10px] font-medium px-1.5 py-0.5 rounded-full bg-gray-100 text-gray-500 border border-gray-100"
              >
                1→{oneToManyCount}
              </span>
            )}
          </>
        )}
      </div>

      <div className="flex items-center justify-center">
        {fm.confidence != null ? (
          <span className={`text-xs ${
            fm.confidence >= 90
              ? 'text-green-600'
              : fm.confidence >= 75
              ? 'text-amber-600'
              : 'text-settle-slate-400'
          }`}>
            {Math.round(fm.confidence)}%
          </span>
        ) : (
          <span className="text-xs text-settle-slate-300">—</span>
        )}
      </div>

      <div className="flex items-center justify-between gap-2 min-w-0 pl-2">
        <div className="flex items-center gap-2 min-w-0 flex-1">
          <span
            className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${
              fm.status === 'approved'
                ? 'bg-green-500'
                : fm.status === 'needs_review'
                ? 'bg-amber-400'
                : 'bg-settle-slate-300'
            }`}
          />
          {onEditTarget && targetTableFields ? (
            <div className="relative flex-1 min-w-0" ref={targetCellRef}>
              <button
                onClick={(e) => {
                  e.stopPropagation()
                  e.preventDefault()
                  setIsEditingTarget((v) => !v)
                }}
                className={`text-xs font-mono truncate text-left w-full flex items-center gap-1 transition-colors group/edit ${
                  isEditingTarget
                    ? 'text-settle-blue-600'
                    : 'text-settle-slate-900 hover:text-settle-blue-600'
                }`}
                title="Click to change target field"
              >
                <span className="truncate">
                  {fm.targetField?.name ?? (
                    <span className="text-settle-slate-400 italic font-sans">no target</span>
                  )}
                </span>
                <svg
                  className={`w-3 h-3 flex-shrink-0 transition-opacity ${
                    isEditingTarget
                      ? 'opacity-100 text-settle-blue-600'
                      : 'opacity-0 group-hover/edit:opacity-60 text-settle-slate-400'
                  }`}
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" />
                  <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z" />
                </svg>
              </button>
              {isEditingTarget && (
                <FieldPicker
                  tableName={targetTableName ?? ''}
                  fields={targetTableFields}
                  selectedFieldId={fm.target_field_id}
                  onSelect={(field) => {
                    onEditTarget(field.id)
                    setIsEditingTarget(false)
                  }}
                  onClose={() => setIsEditingTarget(false)}
                  anchorRef={targetCellRef as React.RefObject<HTMLElement>}
                />
              )}
            </div>
          ) : (
            <span className="text-xs font-mono truncate text-settle-slate-900 flex-1 min-w-0">
              {fm.targetField?.name ?? (
                <span className="text-settle-slate-400 italic font-sans">no target</span>
              )}
            </span>
          )}
          {isManyToOne && (
            <span
              title={`${fm.targetField?.name} receives from ${contributingFMs.length + 1} source fields combined`}
              className="flex-shrink-0 text-[10px] font-medium px-1.5 py-0.5 rounded-full bg-gray-100 text-gray-500 border border-gray-100"
            >
              many→1
            </span>
          )}
        </div>

        <div className="flex items-center gap-1 flex-shrink-0 opacity-0 group-hover:opacity-100 transition-opacity" onClick={(e) => e.stopPropagation()}>
          {canEdit && fm.status !== 'approved' && (
            <button
              onClick={(e) => { e.stopPropagation(); onApprove() }}
              title="Approve mapping"
              className="w-6 h-6 flex items-center justify-center rounded text-green-600 hover:bg-green-50 transition-colors"
            >
              <Check className="w-3.5 h-3.5" />
            </button>
          )}
          {canEdit && (
            <button
              onClick={(e) => { e.stopPropagation(); onReject() }}
              title={fm.status === 'rejected' ? 'Un-reject mapping' : 'Remove mapping'}
              className="w-6 h-6 flex items-center justify-center rounded text-settle-slate-400 hover:text-red-500 hover:bg-red-50 transition-colors"
            >
              <X className="w-3.5 h-3.5" />
            </button>
          )}
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
  onMappingsSync,
  allFieldsByTable,
  suggestingThis,
  onSuggestRemaining,
  regeneratingThis,
  onRegenerate,
  showContributingRows,
  showInlineUnmapped,
  hideMappedRows,
  filterVisibleStatus,
  acknowledgments,
  onAcknowledge,
  onRemoveAcknowledgment,
  canEdit = true,
  selectedFMId = null,
  tableNameById,
  onEditFieldTarget,
  onError,
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
  onMappingsSync?: () => void
  allFieldsByTable: Record<string, SimpleField[]>
  suggestingThis: boolean
  onSuggestRemaining: () => void
  regeneratingThis: boolean
  onRegenerate: () => void
  showContributingRows: boolean
  showInlineUnmapped: boolean
  hideMappedRows?: boolean
  filterVisibleStatus?: string
  acknowledgments: FieldAcknowledgmentRow[]
  onAcknowledge: (fieldId: string, side: 'source' | 'target') => void
  onRemoveAcknowledgment: (fieldId: string) => void
  canEdit?: boolean
  selectedFMId?: string | null
  tableNameById: Map<string, string>
  onEditFieldTarget: (fmId: string, newTargetFieldId: string) => void
  onError?: (message: string) => void
}) {
  const router = useRouter()
  const srcDs = tm.sourceTable?.dataset
  const tgtDs = tm.targetTable?.dataset
  const activeSrcIds = new Set(tm.fieldMappings.filter((fm) => fm.status !== 'rejected').map((fm) => fm.source_field_id).filter(Boolean))
  const activeTgtIds = new Set(tm.fieldMappings.filter((fm) => fm.status !== 'rejected' && !fm.is_contributing).map((fm) => fm.target_field_id))
  const mappedSrcIds = new Set(tm.fieldMappings.map((fm) => fm.source_field_id).filter(Boolean))
  const mappedTgtIds = new Set(tm.fieldMappings.map((fm) => fm.target_field_id))
  const allSrcFields = allFieldsByTable[tm.source_table_id] ?? []
  const allTgtFields = allFieldsByTable[tm.target_table_id] ?? []
  const availSrc = allSrcFields.filter((f) => !mappedSrcIds.has(f.id))
  const availTgt = allTgtFields.filter((f) => !mappedTgtIds.has(f.id))
  const hasUnmapped = availSrc.length > 0 && availTgt.length > 0
  const unmappedTgtFields = allTgtFields.filter((f) => !activeTgtIds.has(f.id))
  const unmappedSrcFields = allSrcFields.filter((f) => !activeSrcIds.has(f.id))

  // Track which unmapped field's "+ Map" was clicked — drives the inline
  // FieldPicker dropdown for the common 1→1 quick-mapping case. Advanced
  // cases (many-to-one, one-to-many, value assignments) still flow through
  // the full InlineAddFieldRow at the bottom of the card.
  const [mapPickerFieldId, setMapPickerFieldId] = useState<string | null>(null)
  const mapPickerRef = useRef<HTMLButtonElement | null>(null)
  const acknowledgedIds = useMemo(() => new Set(acknowledgments.map((a) => a.field_id)), [acknowledgments])

  // Quick-map helper: persists a 1→1 mapping via addManualFieldMapping and
  // synthesises the RichFieldMapping for the optimistic patch (same shape
  // InlineAddFieldRow builds at the one_to_one path).
  async function quickMap(sourceFieldId: string, targetFieldId: string) {
    const sf = allSrcFields.find((f) => f.id === sourceFieldId)
    const tf = allTgtFields.find((f) => f.id === targetFieldId)
    try {
      const result = await addManualFieldMapping(tm.id, sourceFieldId, targetFieldId, false)
      if (!result.success || !result.data) {
        onError?.(result.error ?? 'Failed to create mapping')
        return
      }
      const newFM: RichFieldMapping = {
        id: result.data.id,
        table_mapping_id: tm.id,
        source_field_id: sourceFieldId,
        target_field_id: targetFieldId,
        confidence: 100,
        status: 'approved',
        ai_reasoning: 'Manually mapped by user',
        similar_fields_considered: null,
        type_compatibility: null,
        is_contributing: result.data.is_contributing,
        created_at: new Date().toISOString(),
        sourceField: sf ? { id: sf.id, name: sf.name, data_type: sf.data_type, inferred_type: null } : null,
        targetField: tf ? { id: tf.id, name: tf.name, data_type: tf.data_type, inferred_type: null } : null,
        sourceFieldSamples: [],
        targetFieldSamples: [],
        sourceFieldNullPercentage: 0,
        transformation: null,
      }
      onFieldAdded(newFM)
    } catch {
      onError?.('Failed to create mapping')
    }
  }

  return (
    <div className="border border-gray-200 rounded-lg overflow-hidden bg-white">
      {/* Header */}
      <div className="group flex items-center px-5 py-4 hover:bg-gray-50 transition-colors">
        <div className="flex items-center gap-2 flex-1 cursor-pointer min-w-0" onClick={onToggle}>
          <div className="flex-1 min-w-0">
            <p className="font-semibold text-gray-900 truncate">{tm.sourceTable?.name ?? '—'}</p>
            <p className="text-xs text-gray-500 mt-0.5">
              {hideMappedRows
                ? `${unmappedTgtFields.length + unmappedSrcFields.length} unmapped`
                : filterVisibleStatus
                  ? `${tm.fieldMappings.filter((fm) => !fm.is_contributing && fm.status === filterVisibleStatus).length} to review · ${unmappedTgtFields.length + unmappedSrcFields.length} unmapped`
                  : `${allSrcFields.length} field${allSrcFields.length !== 1 ? 's' : ''}`}
            </p>
          </div>
          <div className="flex items-center px-3 flex-shrink-0">
            <div className="w-6 border-t-2 border-dashed border-blue-200" />
            <ArrowRight className="w-4 h-4 text-blue-400 -ml-1" />
          </div>
          <div className="flex-1 min-w-0 text-right">
            <p className="font-semibold text-gray-900 truncate">{tm.targetTable?.name ?? '—'}</p>
            <div className="flex items-center justify-end gap-3 mt-0.5">
              <span className="text-xs text-gray-500">
                {allTgtFields.length} field{allTgtFields.length !== 1 ? 's' : ''}
              </span>
              <StatusBadge status={tm.status} />
            </div>
          </div>
          <div className="ml-3 flex-shrink-0">
            {expanded ? <ChevronDown className="w-4 h-4 text-gray-400" /> : <ChevronRight className="w-4 h-4 text-gray-400" />}
          </div>
        </div>

        {/* Table-level actions */}
        <div className={`flex items-center gap-2 ml-3 ${expanded ? '' : 'opacity-0 group-hover:opacity-100 transition-opacity duration-150'}`} onClick={(e) => e.stopPropagation()}>
          <RoleTooltip allowed={canEdit} requiredRole="Editor">
            <button
              onClick={canEdit ? onApproveAll : undefined}
              disabled={!canEdit}
              title="Approve all field mappings"
              className="text-xs font-medium text-gray-600 hover:text-gray-900 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
            >
              Approve All
            </button>
          </RoleTooltip>
          <div className="w-px h-3.5 bg-gray-200 flex-shrink-0" />
          <RoleTooltip allowed={canEdit} requiredRole="Editor">
            <button
              onClick={canEdit ? onRegenerate : undefined}
              disabled={regeneratingThis || !canEdit}
              title="Regenerate field mappings with AI"
              className="flex items-center gap-1 text-xs font-medium text-gray-600 hover:text-gray-900 transition-colors disabled:opacity-50"
            >
              {regeneratingThis ? (
                <>
                  <span className="w-2.5 h-2.5 border-2 border-gray-400 border-t-transparent rounded-full animate-spin" />
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
          </RoleTooltip>
          <div className="w-px h-3.5 bg-gray-200 flex-shrink-0" />
          <RoleTooltip allowed={canEdit} requiredRole="Editor">
            <button
              onClick={canEdit ? onDeleteTM : undefined}
              disabled={!canEdit}
              title="Delete this table mapping"
              className="p-1.5 text-gray-400 hover:text-gray-600 rounded transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
            >
            <TrashIcon />
          </button>
          </RoleTooltip>
        </div>
      </div>

      {/* Expanded field list */}
      {expanded && (
        <div className="border-t border-gray-100">
          {/* Column headers + mapped field rows (hidden when hideMappedRows) */}
          {!hideMappedRows && !(filterVisibleStatus && tm.fieldMappings.every((fm) => fm.status !== filterVisibleStatus)) && (
          <div className="grid grid-cols-[1fr_80px_1fr] items-center px-4 py-2 bg-settle-slate-50 border-b border-settle-slate-100">
            <div className="text-xs font-medium text-gray-500">Source Field</div>
            <div className="text-xs font-medium text-gray-500 text-center overflow-hidden">Conf.</div>
            <div className="text-xs font-medium text-gray-500">Target Field</div>
          </div>
          )}

          {!hideMappedRows && tm.fieldMappings.length === 0 ? (
            <div className="px-5 py-4 text-sm text-gray-400 text-center">No field mappings yet.</div>
          ) : !hideMappedRows ? (
            (() => {
              // Contributors are always rendered inside the primary row as
              // peer chips (see SourceFieldChip). Surfacing them as separate
              // indented rows in addition would duplicate the information,
              // so we unconditionally filter them out of the row list. The
              // `showContributingRows` prop is kept on the signature for
              // backward compatibility with call sites but no longer drives
              // display here.
              void showContributingRows
              let visibleFMs = tm.fieldMappings.filter((fm) => !fm.is_contributing && fm.status !== 'rejected')
              if (filterVisibleStatus) {
                visibleFMs = visibleFMs.filter((fm) => fm.status === filterVisibleStatus)
              }

              // Detect one-to-many groups: source fields with multiple non-contributing non-rejected primary rows
              const srcPrimaryCounts = new Map<string, number>()
              for (const row of visibleFMs) {
                if (row.is_contributing || row.status === 'rejected' || !row.source_field_id) continue
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
                onDeleteFM={onDeleteFM}
                canEdit={canEdit}
                isSelected={selectedFMId === fm.id}
                onEditTarget={(fieldId) => onEditFieldTarget(fm.id, fieldId)}
                targetTableFields={allFieldsByTable[tm.target_table_id] ?? []}
                targetTableName={tableNameById.get(tm.target_table_id) ?? ''}
              />
            ))
              }

              // Render with one-to-many groups wrapped in purple containers
              const rendered = new Set<string>()
              return visibleFMs.map((fm) => {
                if (rendered.has(fm.id)) return null
                rendered.add(fm.id)

                if (!fm.is_contributing && fm.source_field_id && oneToManySrcIds.has(fm.source_field_id)) {
                  const groupRows = visibleFMs.filter(
                    (f) => f.source_field_id === fm.source_field_id && !f.is_contributing
                  )
                  groupRows.forEach((r) => rendered.add(r.id))
                  const srcName = fm.sourceField?.name ?? '?'
                  return (
                    <div key={`otm-${fm.source_field_id}`} className="border-l-2 border-gray-100 my-1">
                      <div className="text-xs text-settle-slate-400 font-medium px-5 py-1">
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
                          onDeleteFM={onDeleteFM}
                          canEdit={canEdit}
                          isSelected={selectedFMId === row.id}
                          onEditTarget={(fieldId) => onEditFieldTarget(row.id, fieldId)}
                          targetTableFields={allFieldsByTable[tm.target_table_id] ?? []}
                          targetTableName={tableNameById.get(tm.target_table_id) ?? ''}
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
                    onDeleteFM={onDeleteFM}
                    canEdit={canEdit}
                    isSelected={selectedFMId === fm.id}
                    onEditTarget={(fieldId) => onEditFieldTarget(fm.id, fieldId)}
                    targetTableFields={allFieldsByTable[tm.target_table_id] ?? []}
                    targetTableName={tableNameById.get(tm.target_table_id) ?? ''}
                  />
                )
              })
            })()
          ) : null}

          {/* Inline unmapped target fields */}
          {showInlineUnmapped && unmappedTgtFields.length > 0 && (
            <div className="border-t border-gray-100">
              {unmappedTgtFields.map((field) => {
                const ack = acknowledgments.find((a) => a.field_id === field.id)
                return (
                  <div key={field.id}>
                    <div className="group grid grid-cols-[1fr_80px_1fr] items-center px-4 py-0 min-h-[40px] transition-colors hover:bg-settle-slate-50">
                      <div className="flex items-center gap-2 min-w-0 pr-2">
                        <span className="w-1.5 h-1.5 rounded-full flex-shrink-0 bg-settle-slate-300" />
                        <span className="text-xs text-settle-slate-400 font-mono italic">—</span>
                      </div>
                      <div className="flex items-center justify-center">
                        <span className="text-xs text-settle-slate-300">—</span>
                      </div>
                      <div className="flex items-center justify-between gap-2 min-w-0 pl-2">
                        <div className="flex items-center gap-2 min-w-0 flex-1">
                          <span className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${ack ? 'bg-green-500' : 'bg-amber-400'}`} />
                          <span className="text-xs font-mono truncate text-settle-slate-900">{field.name}</span>
                          <UnmappedTargetIndicator field={field} />
                        </div>
                        {canEdit && (
                          <div className="flex items-center gap-0.5 flex-shrink-0 opacity-0 group-hover:opacity-100 transition-opacity" onClick={(e) => e.stopPropagation()}>
                            <button
                              ref={mapPickerFieldId === field.id ? mapPickerRef : undefined}
                              onClick={(e) => {
                                e.stopPropagation()
                                setMapPickerFieldId((prev) => prev === field.id ? null : field.id)
                              }}
                              className="text-xs text-gray-500 hover:text-gray-700 font-medium transition-colors whitespace-nowrap"
                            >
                              + Map
                            </button>
                            {mapPickerFieldId === field.id && (
                              <FieldPicker
                                tableName={tm.sourceTable?.name ?? 'Source'}
                                fields={unmappedSrcFields.map((f) => ({
                                  id: f.id,
                                  name: f.name,
                                  data_type: f.data_type,
                                  is_nullable: f.is_nullable,
                                }))}
                                selectedFieldId={null}
                                onSelect={(srcField) => {
                                  setMapPickerFieldId(null)
                                  void quickMap(srcField.id, field.id)
                                }}
                                onClose={() => setMapPickerFieldId(null)}
                                anchorRef={mapPickerRef as React.RefObject<HTMLElement>}
                              />
                            )}
                            {ack ? (
                              <button
                                onClick={() => onRemoveAcknowledgment(field.id)}
                                title="Remove acknowledgment"
                                className="p-1 rounded transition-colors text-gray-400 hover:text-gray-600"
                              >
                                <X className="w-3.5 h-3.5" />
                              </button>
                            ) : (
                              <button
                                onClick={() => onAcknowledge(field.id, 'target')}
                                title="Acknowledge"
                                className="p-1 rounded transition-colors text-gray-400 hover:text-gray-600"
                              >
                                <Check className="w-3.5 h-3.5" />
                              </button>
                            )}
                          </div>
                        )}
                      </div>
                    </div>
                  </div>
                )
              })}
            </div>
          )}

          {/* Inline unmapped source fields */}
          {showInlineUnmapped && unmappedSrcFields.length > 0 && (
            <div className="border-t border-gray-100">
              {unmappedSrcFields.map((field) => {
                const ack = acknowledgments.find((a) => a.field_id === field.id)
                return (
                  <div key={field.id}>
                    <div className="group grid grid-cols-[1fr_80px_1fr] items-center px-4 py-0 min-h-[40px] transition-colors hover:bg-settle-slate-50">
                      <div className="flex items-center gap-2 min-w-0 pr-2">
                        <span className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${ack ? 'bg-green-500' : 'bg-amber-400'}`} />
                        <span className="text-xs font-mono truncate text-settle-slate-900">{field.name}</span>
                      </div>
                      <div className="flex items-center justify-center">
                        <span className="text-xs text-settle-slate-300">—</span>
                      </div>
                      <div className="flex items-center justify-between gap-2 min-w-0 pl-2">
                        <div className="flex items-center gap-2 min-w-0 flex-1">
                          <span className="w-1.5 h-1.5 rounded-full flex-shrink-0 bg-settle-slate-300" />
                          <span className="text-xs text-settle-slate-400 font-mono italic">—</span>
                        </div>
                        {canEdit && (
                          <div className="flex items-center gap-0.5 flex-shrink-0 opacity-0 group-hover:opacity-100 transition-opacity" onClick={(e) => e.stopPropagation()}>
                            <button
                              ref={mapPickerFieldId === field.id ? mapPickerRef : undefined}
                              onClick={(e) => {
                                e.stopPropagation()
                                setMapPickerFieldId((prev) => prev === field.id ? null : field.id)
                              }}
                              className="text-xs text-gray-500 hover:text-gray-700 font-medium transition-colors whitespace-nowrap"
                            >
                              + Map
                            </button>
                            {mapPickerFieldId === field.id && (
                              <FieldPicker
                                tableName={tm.targetTable?.name ?? 'Target'}
                                fields={unmappedTgtFields.map((f) => ({
                                  id: f.id,
                                  name: f.name,
                                  data_type: f.data_type,
                                  is_nullable: f.is_nullable,
                                }))}
                                selectedFieldId={null}
                                onSelect={(tgtField) => {
                                  setMapPickerFieldId(null)
                                  void quickMap(field.id, tgtField.id)
                                }}
                                onClose={() => setMapPickerFieldId(null)}
                                anchorRef={mapPickerRef as React.RefObject<HTMLElement>}
                              />
                            )}
                            {ack ? (
                              <button
                                onClick={() => onRemoveAcknowledgment(field.id)}
                                title="Remove acknowledgment"
                                className="p-1 rounded transition-colors text-gray-400 hover:text-gray-600"
                              >
                                <X className="w-3.5 h-3.5" />
                              </button>
                            ) : (
                              <button
                                onClick={() => onAcknowledge(field.id, 'source')}
                                title="Acknowledge"
                                className="p-1 rounded transition-colors text-gray-400 hover:text-gray-600"
                              >
                                <Check className="w-3.5 h-3.5" />
                              </button>
                            )}
                          </div>
                        )}
                      </div>
                    </div>
                  </div>
                )
              })}
            </div>
          )}

          {/* Inline add field row — rendered at bottom when "Add Field
              Mapping" is clicked. Used for advanced mapping types
              (many-to-one, one-to-many). The common 1→1 quick-map flow on
              unmapped rows goes through the FieldPicker instead. */}
          {showAddRow && (
            <InlineAddFieldRow
              tm={tm}
              allFieldsByTable={allFieldsByTable}
              onAdded={onFieldAdded}
              onCancel={onHideAddRow}
              onSync={onMappingsSync}
            />
          )}

          {/* Bottom action bar */}
          <div className="flex items-center gap-3 px-5 py-3 border-t border-gray-100 bg-gray-50/50">
            {!showAddRow && (
              <RoleTooltip allowed={canEdit} requiredRole="Editor">
                <button
                  onClick={canEdit ? onShowAddRow : undefined}
                  disabled={!canEdit}
                  className="flex items-center gap-1.5 text-xs font-medium text-blue-600 hover:text-blue-800 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
                >
                  <Plus className="w-3.5 h-3.5" />
                  Add Field Mapping
                </button>
              </RoleTooltip>
            )}
            {hasUnmapped && (
              <RoleTooltip allowed={canEdit} requiredRole="Editor">
                <button
                  onClick={canEdit ? onSuggestRemaining : undefined}
                  disabled={suggestingThis || !canEdit}
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
              </RoleTooltip>
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
  peerFMs,
  isOpen,
  onClose,
  onApprove,
  onReject,
  onChangeSource,
  onChangeTarget,
  onRemove,
  onRemovePeer,
  onAddContributor,
  projectId,
  tableMappingId,
  allFieldsByTable,
  canEdit,
  aiReasoningOpen,
  onToggleReasoning,
  rejectConfirmOpen,
  onRequestReject,
  onCloseRejectConfirm,
  onRemap,
  sourceTableFields,
  sourceTableName,
  targetTableFields,
  targetTableName,
}: {
  fm: RichFieldMapping | null
  /** All non-rejected field_mappings on the same TM that share this mapping's
   *  target field. For a 1:1 mapping this is just `[fm]`; for a many-to-one
   *  it includes the primary and every contributor. */
  peerFMs: RichFieldMapping[]
  isOpen: boolean
  onClose: () => void
  onApprove: () => void
  onReject: () => void
  onChangeSource: (fieldId: string) => void
  onChangeTarget: (fieldId: string) => void
  onRemove: () => void
  /** Deletes a single peer (one of the contributors or the primary) without
   *  touching the other peers — used by the per-row × buttons in the
   *  Source-fields section of a many-to-one mapping. */
  onRemovePeer: (fmId: string) => void
  /** Adds a new contributor to the current target, creating a new
   *  field_mappings row with is_contributing = true. */
  onAddContributor: (sourceFieldId: string) => void
  projectId: string
  tableMappingId: string
  allFieldsByTable: Record<string, SimpleField[]>
  canEdit: boolean
  aiReasoningOpen: boolean
  onToggleReasoning: () => void
  rejectConfirmOpen: boolean
  onRequestReject: () => void
  onCloseRejectConfirm: () => void
  onRemap: () => void
  sourceTableFields: PickerField[]
  sourceTableName: string
  targetTableFields: PickerField[]
  targetTableName: string
}) {
  const router = useRouter()
  const [isEditingSource, setIsEditingSource] = useState(false)
  const [isEditingTarget, setIsEditingTarget] = useState(false)
  const [isAddingContributor, setIsAddingContributor] = useState(false)
  const [activeTab, setActiveTab] = useState<'details' | 'transform' | 'actions'>('details')
  const sourceFieldRef = useRef<HTMLDivElement>(null)
  const targetFieldRef = useRef<HTMLDivElement>(null)
  const addContribRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    setIsEditingSource(false)
    setIsEditingTarget(false)
    setIsAddingContributor(false)
    setActiveTab('details')
  }, [fm?.id])

  if (!fm) return null

  // A many-to-one lives across multiple field_mappings rows sharing the
  // same target; if we see more than one peer on this target the panel
  // renders the equal-peer Source-fields section. Peers are presented in
  // insertion order so the list feels stable across edits.
  const isManyToOne = peerFMs.length > 1
  const peerSourceFieldIds = new Set(
    peerFMs.map((p) => p.source_field_id).filter((id): id is string => !!id)
  )
  // Candidates for "Add field" = any source field in this TM's source table
  // not already contributing to this target. Value-assignment peers (no
  // source_field_id) don't block anything.
  const availableContributorFields = sourceTableFields.filter(
    (f) => !peerSourceFieldIds.has(f.id)
  )

  return (
    <FixDrawer isOpen={isOpen} onClose={onClose}>

      {/* Header */}
      <div className="flex items-start justify-between px-5 pt-5 pb-3 border-b border-settle-slate-100 flex-shrink-0">
        <div className="flex-1 min-w-0 pr-3">
          <p className="text-xs text-settle-slate-400 mb-0.5">Field mapping</p>

          <div className="flex items-center gap-2 mb-2 flex-wrap">
            <div ref={sourceFieldRef} className="relative">
              {isManyToOne ? (
                // For a many-to-one, the "source" is a combination of many
                // fields; editing a single one via FieldPicker would be
                // ambiguous (which peer to replace?). We expose peer-level
                // edits via the Source-fields section below instead and
                // render the header name purely as a readout.
                <span
                  className="text-sm font-semibold font-mono text-settle-slate-900"
                  title={peerFMs.map((p) => p.sourceField?.name ?? '?').join(' + ')}
                >
                  {peerFMs
                    .map((p) => p.sourceField?.name ?? '?')
                    .join(' + ')}
                </span>
              ) : canEdit ? (
                <button
                  onClick={() => setIsEditingSource((v) => !v)}
                  className={`text-sm font-semibold font-mono truncate max-w-[140px] text-left transition-colors ${
                    isEditingSource
                      ? 'text-settle-blue-600'
                      : 'text-settle-slate-900 hover:text-settle-blue-600 hover:underline'
                  }`}
                  title="Click to change source field"
                >
                  {fm.sourceField?.name ?? (
                    <span className="italic font-sans text-settle-slate-400">unmapped</span>
                  )}
                </button>
              ) : (
                <span className="text-sm font-semibold font-mono text-settle-slate-900">
                  {fm.sourceField?.name ?? '—'}
                </span>
              )}
              {!isManyToOne && isEditingSource && (
                <FieldPicker
                  tableName={sourceTableName}
                  fields={sourceTableFields}
                  selectedFieldId={fm.source_field_id}
                  onSelect={(field) => {
                    onChangeSource(field.id)
                    setIsEditingSource(false)
                  }}
                  onClose={() => setIsEditingSource(false)}
                  anchorRef={sourceFieldRef as React.RefObject<HTMLElement>}
                />
              )}
            </div>

            <span className="text-settle-slate-300 flex-shrink-0 text-sm">→</span>

            <div ref={targetFieldRef} className="relative">
              {canEdit ? (
                <button
                  onClick={() => setIsEditingTarget((v) => !v)}
                  className={`text-sm font-semibold font-mono truncate max-w-[140px] text-left transition-colors ${
                    isEditingTarget
                      ? 'text-settle-blue-600'
                      : 'text-settle-slate-900 hover:text-settle-blue-600 hover:underline'
                  }`}
                  title="Click to change target field"
                >
                  {fm.targetField?.name ?? '—'}
                </button>
              ) : (
                <span className="text-sm font-semibold font-mono text-settle-slate-900">
                  {fm.targetField?.name ?? '—'}
                </span>
              )}
              {isEditingTarget && (
                <FieldPicker
                  tableName={targetTableName}
                  fields={targetTableFields}
                  selectedFieldId={fm.target_field_id}
                  onSelect={(field) => {
                    onChangeTarget(field.id)
                    setIsEditingTarget(false)
                  }}
                  onClose={() => setIsEditingTarget(false)}
                  anchorRef={targetFieldRef as React.RefObject<HTMLElement>}
                />
              )}
            </div>

            {isManyToOne && (
              <span
                title={`${peerFMs.length} source fields combine into ${fm.targetField?.name}`}
                className="flex-shrink-0 text-[10px] font-medium px-1.5 py-0.5 rounded-full bg-gray-100 text-gray-500 border border-gray-100"
              >
                many→1
              </span>
            )}
          </div>

          <div className="flex items-center gap-1.5">
            <span
              className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${
                fm.status === 'approved'
                  ? 'bg-green-500'
                  : fm.status === 'needs_review'
                  ? 'bg-amber-400'
                  : 'bg-settle-slate-300'
              }`}
            />
            <span className="text-xs text-settle-slate-500">
              {fm.confidence != null
                ? `${Math.round(fm.confidence)}% confidence`
                : 'No confidence score'}
              {fm.sourceField?.data_type ? ` · ${fm.sourceField.data_type}` : ''}
              {fm.targetField?.data_type ? ` → ${fm.targetField.data_type}` : ''}
            </span>
          </div>
        </div>

        <button
          onClick={onClose}
          className="text-settle-slate-400 hover:text-settle-slate-600 transition-colors flex-shrink-0"
          aria-label="Close"
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M18 6 6 18M6 6l12 12" />
          </svg>
        </button>
      </div>

      {/* Tab bar */}
      <div className="flex border-b border-settle-slate-100 px-5 flex-shrink-0">
        {(['details', 'transform', 'actions'] as const).map((tab) => (
          <button
            key={tab}
            onClick={() => setActiveTab(tab)}
            className={`py-2.5 px-1 mr-5 text-xs font-medium border-b-2 -mb-px transition-colors ${
              activeTab === tab
                ? 'border-settle-blue-500 text-settle-slate-900'
                : 'border-transparent text-settle-slate-400 hover:text-settle-slate-600'
            }`}
          >
            {tab === 'details' ? 'Details' : tab === 'transform' ? 'Transform' : 'Actions'}
          </button>
        ))}
      </div>

      {/* Tab content */}
      <div className="flex-1 overflow-y-auto px-5 py-4">

        {activeTab === 'details' && (
          <div className="space-y-5">

            {isManyToOne && (
              // Equal-peer Source-fields section for many-to-one. Each peer
              // renders with its own × so contributors can be trimmed
              // independently — the last remaining peer cannot be removed
              // from here (that would orphan the target; use Actions →
              // Remove Mapping instead). "Add field" spawns a FieldPicker
              // scoped to source fields not already contributing.
              <div>
                <div className="flex items-center justify-between mb-2">
                  <p className="text-xs font-medium text-gray-500">Source fields</p>
                  <span className="text-[10px] text-settle-slate-400">
                    {peerFMs.length} combine → {fm.targetField?.name ?? 'target'}
                  </span>
                </div>
                <div className="space-y-1.5">
                  {peerFMs.map((peer) => (
                    <div
                      key={peer.id}
                      className="flex items-center justify-between gap-2 px-2.5 py-1.5 rounded-md border border-gray-100 bg-settle-slate-50/60"
                    >
                      <div className="flex items-center gap-2 min-w-0">
                        <span className="text-xs font-mono text-settle-slate-900 truncate">
                          {peer.sourceField?.name ?? '—'}
                        </span>
                        {peer.sourceField?.data_type && (
                          <span className="text-[10px] text-settle-slate-400 flex-shrink-0">
                            {peer.sourceField.data_type}
                          </span>
                        )}
                      </div>
                      {canEdit && peerFMs.length > 1 && (
                        <button
                          type="button"
                          onClick={() => onRemovePeer(peer.id)}
                          title={`Remove ${peer.sourceField?.name ?? 'this field'} from this mapping`}
                          className="flex-shrink-0 w-5 h-5 flex items-center justify-center rounded text-settle-slate-400 hover:text-red-500 hover:bg-red-50 transition-colors"
                        >
                          <X className="w-3 h-3" />
                        </button>
                      )}
                    </div>
                  ))}
                </div>
                {canEdit && availableContributorFields.length > 0 && (
                  <div ref={addContribRef} className="relative mt-2">
                    <button
                      type="button"
                      onClick={() => setIsAddingContributor((v) => !v)}
                      className="text-xs font-medium text-settle-blue-500 hover:text-settle-blue-700 transition-colors"
                    >
                      {isAddingContributor ? 'Cancel' : '+ Add field'}
                    </button>
                    {isAddingContributor && (
                      <FieldPicker
                        tableName={sourceTableName}
                        fields={availableContributorFields}
                        selectedFieldId={null}
                        onSelect={(field) => {
                          onAddContributor(field.id)
                          setIsAddingContributor(false)
                        }}
                        onClose={() => setIsAddingContributor(false)}
                        anchorRef={addContribRef as React.RefObject<HTMLElement>}
                      />
                    )}
                  </div>
                )}
                {canEdit && availableContributorFields.length === 0 && (
                  <p className="mt-2 text-[11px] text-settle-slate-400">
                    All source fields are already contributing to this target.
                  </p>
                )}
              </div>
            )}

            <div>
              <p className="text-xs font-medium text-gray-500 mb-2">Confidence</p>
              <div className="h-1 bg-settle-slate-100 rounded-full overflow-hidden mb-1.5">
                <div
                  className={`h-full rounded-full ${
                    (fm.confidence ?? 0) >= 90
                      ? 'bg-green-500'
                      : (fm.confidence ?? 0) >= 75
                      ? 'bg-amber-400'
                      : 'bg-settle-slate-300'
                  }`}
                  style={{ width: `${Math.round(fm.confidence ?? 0)}%` }}
                />
              </div>
              <div className="flex items-center justify-between">
                <span className={`text-xs font-medium ${
                  (fm.confidence ?? 0) >= 90
                    ? 'text-green-600'
                    : (fm.confidence ?? 0) >= 75
                    ? 'text-amber-600'
                    : 'text-settle-slate-500'
                }`}>
                  {fm.confidence != null ? `${Math.round(fm.confidence)}%` : '—'}
                </span>
                <span className="text-[10px] text-settle-blue-500 bg-blue-50 border border-blue-100 rounded px-1.5 py-0.5">
                  ✦ AI-Generated
                </span>
              </div>
            </div>

            {fm.ai_reasoning && (
              <div>
                <button
                  onClick={onToggleReasoning}
                  className="flex items-center justify-between w-full text-left py-2 border-t border-settle-slate-100"
                >
                  <span className="text-xs font-medium text-gray-500">AI Reasoning</span>
                  <ChevronRight
                    className={`w-3.5 h-3.5 text-settle-slate-400 transition-transform ${aiReasoningOpen ? 'rotate-90' : ''}`}
                  />
                </button>
                {aiReasoningOpen && (
                  <p className="text-xs text-settle-slate-600 leading-relaxed mt-1.5">{fm.ai_reasoning}</p>
                )}
              </div>
            )}

            {fm.similar_fields_considered && fm.similar_fields_considered.length > 0 && (
              <div>
                <p className="text-xs font-medium text-gray-500 mb-2">Similar Fields Considered</p>
                <div className="flex flex-wrap gap-1.5">
                  {fm.similar_fields_considered.map((f) => (
                    <span key={f} className="text-[10px] text-settle-slate-600 bg-settle-slate-50 border border-gray-100 rounded px-2 py-0.5 font-mono">{f}</span>
                  ))}
                </div>
              </div>
            )}

            {fm.sourceFieldSamples && fm.sourceFieldSamples.length > 0 && (
              <div>
                <p className="text-xs font-medium text-gray-500 mb-2">Example Values</p>
                <div className="flex items-center gap-2 flex-wrap">
                  {fm.sourceFieldSamples.slice(0, 4).map((v, i, arr) => (
                    <span key={i} className="text-xs text-settle-slate-700">
                      {v}
                      {i < arr.length - 1 && <span className="text-settle-slate-300 ml-2">·</span>}
                    </span>
                  ))}
                </div>
              </div>
            )}

            {fm.type_compatibility && (
              <div>
                <p className="text-xs font-medium text-gray-500 mb-1.5">Type Compatibility</p>
                <p className="text-xs text-settle-slate-600">{fm.type_compatibility}</p>
              </div>
            )}
          </div>
        )}

        {activeTab === 'transform' && (
          <div className="space-y-3">
            {fm.transformation ? (
              <div className="border border-gray-100 rounded-lg p-4 space-y-3">
                <div className="flex items-center justify-between">
                  <span className="text-xs font-medium text-settle-slate-600">Transform</span>
                  <span
                    className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium ${
                      fm.transformation.status === 'applied'
                        ? 'bg-green-50 text-green-700'
                        : fm.transformation.status === 'tested'
                        ? 'bg-blue-50 text-blue-700'
                        : fm.transformation.status === 'saved'
                        ? 'bg-amber-50 text-amber-700'
                        : fm.transformation.status === 'stale'
                        ? 'bg-red-50 text-red-700'
                        : 'bg-gray-50 text-gray-600'
                    }`}
                  >
                    {fm.transformation.status.charAt(0).toUpperCase() + fm.transformation.status.slice(1)}
                  </span>
                </div>

                {fm.transformation.description && (
                  <p className="text-xs text-settle-slate-500">{fm.transformation.description}</p>
                )}

                {fm.transformation.generated_sql && (
                  <pre className="text-xs bg-gray-50 rounded p-2 overflow-x-auto max-h-32 text-settle-slate-600 font-mono whitespace-pre-wrap">
                    {fm.transformation.generated_sql.length > 300
                      ? fm.transformation.generated_sql.slice(0, 300) + '...'
                      : fm.transformation.generated_sql}
                  </pre>
                )}

                <button
                  onClick={() => router.push(`/app/projects/${projectId}/transform?fieldMappingId=${fm.id}`)}
                  className="text-xs font-medium text-settle-blue-500 hover:text-settle-blue-700 transition-colors"
                >
                  View in Transform →
                </button>
              </div>
            ) : (
              <div className="border border-gray-100 rounded-lg p-4">
                <p className="text-xs text-settle-slate-400 mb-3">No transform defined</p>
                <button
                  onClick={() => router.push(`/app/projects/${projectId}/transform?fieldMappingId=${fm.id}`)}
                  className="text-xs font-medium text-settle-blue-500 hover:text-settle-blue-700 transition-colors"
                >
                  Define Transform →
                </button>
              </div>
            )}
          </div>
        )}

        {activeTab === 'actions' && (
          <div className="space-y-3">

            {canEdit && fm.status !== 'approved' && (
              <button
                onClick={onApprove}
                className="w-full h-9 text-sm font-medium rounded-lg bg-settle-blue-500 text-white hover:bg-settle-blue-600 transition-colors"
              >
                ✓ Approve Mapping
              </button>
            )}
            {fm.status === 'approved' && (
              <div className="w-full h-9 flex items-center justify-center text-sm font-medium text-green-600 bg-green-50 rounded-lg border border-green-200">
                ✓ Approved
              </div>
            )}

            {canEdit && (
              <div>
                {fm.status !== 'rejected' ? (
                  <button
                    onClick={onRequestReject}
                    className="w-full h-9 text-sm font-medium rounded-lg border border-settle-slate-200 bg-white text-red-500 hover:bg-red-50 transition-colors"
                  >
                    Reject Mapping
                  </button>
                ) : (
                  <button
                    onClick={onReject}
                    className="w-full h-9 text-sm font-medium rounded-lg border border-settle-slate-200 bg-white text-settle-slate-600 hover:bg-settle-slate-50 transition-colors"
                  >
                    Un-reject
                  </button>
                )}

                {rejectConfirmOpen && (
                  <div className="mt-3 p-3 bg-settle-slate-50 border border-gray-100 rounded-lg">
                    <p className="text-xs text-settle-slate-700 mb-3 leading-relaxed">
                      <span className="font-medium">Unmap {fm.sourceField?.name} → {fm.targetField?.name}?</span>
                      <br />
                      Both fields will return to unmapped status.
                    </p>
                    <div className="flex gap-2">
                      <button
                        onClick={() => { onReject(); onCloseRejectConfirm() }}
                        className="flex-1 h-7 text-xs font-medium rounded-md bg-red-500 text-white hover:bg-red-600 transition-colors"
                      >
                        Unmap
                      </button>
                      <button
                        onClick={onRemap}
                        className="flex-1 h-7 text-xs font-medium rounded-md border border-settle-slate-200 bg-white text-settle-slate-700 hover:bg-settle-slate-50 transition-colors"
                      >
                        Remap Instead
                      </button>
                      <button
                        onClick={onCloseRejectConfirm}
                        className="h-7 px-3 text-xs text-settle-slate-400 hover:text-settle-slate-600 transition-colors"
                      >
                        Cancel
                      </button>
                    </div>
                  </div>
                )}
              </div>
            )}

            {canEdit && (
              <div className="pt-2 border-t border-settle-slate-100">
                <button
                  onClick={onRemove}
                  className="text-xs text-settle-slate-400 hover:text-red-500 transition-colors"
                >
                  Remove Mapping
                </button>
              </div>
            )}
          </div>
        )}
      </div>
    </FixDrawer>
  )
}

// ─── Unmapped target indicator ────────────────────────────────────────────────

/**
 * Visual cue rendered next to an unmapped *target* field name, classifying
 * why the user should (or shouldn't) care about the gap:
 *
 *  - `default_value` present         → muted "has default" pill. The column
 *                                      will auto-populate on INSERT, so
 *                                      leaving it unmapped is fine.
 *  - `is_nullable === false` & no    → amber "required" warning. The column
 *     default                          is NOT NULL with no default, so an
 *                                      INSERT without this mapping will fail.
 *  - Nullable, no default            → no indicator. Nullable unmapped
 *                                      columns are a silent allowed case.
 *
 * Renders nothing when the field is missing the metadata we'd need to
 * classify (e.g. older rows migrated in before migration 064). We deliberately
 * fail silent rather than guessing — a false "required" badge would be worse
 * than no badge.
 */
function UnmappedTargetIndicator(_: { field: Pick<SimpleField, 'default_value' | 'is_nullable'> }) {
  return null
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
          <span className="w-2 h-2 rounded-full bg-blue-400" />
          Unmapped Source Fields
          <span className="text-xs font-normal text-gray-400">({unmappedSource.length})</span>
        </h3>
        {unmappedSource.length === 0 ? (
          <p className="text-sm text-gray-400">All source fields are mapped.</p>
        ) : (
          <div className="space-y-2">
            {unmappedSource.map((f) => (
              <div key={f.id} className="px-3 py-2.5 bg-blue-50/60 border border-blue-100 rounded-lg">
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
                      className="text-xs font-medium text-blue-600 hover:text-blue-800 whitespace-nowrap"
                    >
                      Map to →
                    </button>
                  )}
                </div>
                {mappingFor === f.id && (
                  <div className="mt-2 flex gap-2">
                    <Select value={selectedTgtId} onValueChange={(val) => setSelectedTgtId(val)}>
                      <SelectTrigger className="flex-1 h-7 text-xs">
                        <SelectValue placeholder="Select target field…" />
                      </SelectTrigger>
                      <SelectContent>
                        {unmappedTarget.map((tf) => (
                          <SelectItem key={tf.id} value={tf.id}>{tf.table?.name}.{tf.name} ({tf.data_type})</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    <button
                      onClick={() => handleMap(f.id)}
                      disabled={!selectedTgtId || pending}
                      className="px-2.5 py-1 text-xs font-medium text-white bg-primary rounded hover:bg-primary/90 transition-colors disabled:opacity-40"
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
                <div className="flex items-center gap-2 min-w-0">
                  <p className="text-sm font-medium text-gray-800 truncate">{f.table?.name}.{f.name}</p>
                  <UnmappedTargetIndicator field={f} />
                </div>
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

type ToastState = { message: string; type: 'success' | 'error' }

export default function MappingContent({ projectId, projectName, initialData, projectInfo }: Props) {
  const router = useRouter()
  const { can: canRole } = useProjectRole(projectId)
  const canEdit = canRole('edit')
  const [, startTransition] = useTransition()

  const [data, setData] = useState<MappingsResult | null>(initialData)
  const [tableMappings, setTableMappings] = useState<RichTableMapping[]>(initialData?.tableMappings ?? [])
  const [unmappedSource, setUnmappedSource] = useState<UnmappedField[]>(initialData?.unmappedSourceFields ?? [])
  const [unmappedTarget, setUnmappedTarget] = useState<UnmappedField[]>(initialData?.unmappedTargetFields ?? [])
  const [acknowledgments, setAcknowledgments] = useState<FieldAcknowledgmentRow[]>(initialData?.acknowledgments ?? [])
  const allFieldsByTable = data?.allFieldsByTable ?? {}

  const searchParams = useSearchParams()

  // Helper: build TableFieldSelection from a Set of field IDs
  const buildTableSelectionFromFieldIds = useCallback(
    (
      fieldIds: Set<string>,
      tms: RichTableMapping[]
    ): TableFieldSelection => {
      const tableIds = new Set<string>()
      for (const tm of tms) {
        if (tm.fieldMappings.some((fm) => fieldIds.has(fm.id))) {
          tableIds.add(tm.id)
        }
      }
      return { selectedFieldIds: fieldIds, selectedTableIds: tableIds }
    },
    []
  )

  // Read initial filter state from URL params (only on mount)
  const initialTableSelection = useMemo((): TableFieldSelection => {
    const fields = searchParams.get('fields')
    if (!fields) {
      return { selectedFieldIds: null, selectedTableIds: new Set() }
    }
    const ids = new Set(fields.split(',').filter(Boolean))
    return buildTableSelectionFromFieldIds(ids, tableMappings)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const [statusFilter, setStatusFilter] = useState<StatusFilter>(
    (searchParams.get('status') as StatusFilter) ?? 'all'
  )
  const [tableFieldSelection, setTableFieldSelection] =
    useState<TableFieldSelection>(initialTableSelection)
  const [mappingTypeFilter, setMappingTypeFilter] = useState<
    'all' | 'one_to_one' | 'many_to_one' | 'one_to_many' | 'value_assignment'
  >((searchParams.get('type') as 'all' | 'one_to_one' | 'many_to_one' | 'one_to_many' | 'value_assignment') ?? 'all')
  const [fieldSearchQuery, setFieldSearchQuery] = useState(
    searchParams.get('q') ?? ''
  )
  const [aiReasoningOpen, setAiReasoningOpen] = useState(false)
  const [rejectConfirmOpen, setRejectConfirmOpen] = useState(false)
  const [expandedIds, setExpandedIds] = useState<Set<string>>(new Set())
  const [selectedFM, setSelectedFM] = useState<RichFieldMapping | null>(null)
  const [displayedFM, setDisplayedFM] = useState<RichFieldMapping | null>(null)
  const [isPanelVisible, setIsPanelVisible] = useState(false)
  const [showAddModal, setShowAddModal] = useState(false)
  const [showGenerateModal, setShowGenerateModal] = useState(false)
  const [addRowForTMId, setAddRowForTMId] = useState<string | null>(null)
  const [deleteTMTarget, setDeleteTMTarget] = useState<RichTableMapping | null>(null)
  const [regenerateConfirmTarget, setRegenerateConfirmTarget] = useState<RichTableMapping | null>(null)
  const [regeneratingTMId, setRegeneratingTMId] = useState<string | null>(null)

  // Transform-reset / conflict warning dialog — shown before re-map, delete, or regenerate
  const [resetWarning, setResetWarning] = useState<{
    open: boolean
    fieldMappingId: string
    fieldName: string
    hasTransform: boolean
    hasStagedData: boolean
    action: 'remap' | 'delete' | 'regenerate'
    affectedCount?: number
    hasValueAssignment?: boolean
    createsMultiSource?: boolean
    conflictDetails?: Array<{ sourceFieldName: string | null; isValueAssignment: boolean }>
    isPKSourceChange?: boolean
    fkDependentCount?: number
    fkDependentNames?: string[]
    pendingAction: () => void
  } | null>(null)
  const [suggestingTMId, setSuggestingTMId] = useState<string | null>(null)

  const [toast, setToast] = useState<ToastState | null>(null)
  const isInlineEditingRef = useRef(false)

  // Debounced refresh plumbing — rapid-fire ack/unack clicks used to spawn
  // one getMappings() per click, whose responses could arrive out of order
  // and flicker stale state back over fresh state. The timer coalesces a
  // click storm into one fetch 500ms after the last click; the version
  // counter guards against the tail case where an older in-flight fetch
  // resolves after a newer one was already applied.
  const refreshTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const refreshVersionRef = useRef(0)

  // Panel open/close animation: keep the DOM node alive for 200ms on close so the width transition plays out
  useEffect(() => {
    if (selectedFM) {
      if (isInlineEditingRef.current) {
        isInlineEditingRef.current = false
        return
      }
      setDisplayedFM(selectedFM)
      requestAnimationFrame(() => setIsPanelVisible(true))
    } else {
      setIsPanelVisible(false)
      const timer = setTimeout(() => setDisplayedFM(null), 200)
      return () => clearTimeout(timer)
    }
  }, [selectedFM])

  function showToast(message: string, type: ToastState['type']) {
    setToast({ message, type })
    setTimeout(() => setToast(null), 4000)
  }

  // Tab counts
  const allFMs = useMemo(() => tableMappings.flatMap((tm) => tm.fieldMappings), [tableMappings])
  const acknowledgedIds = useMemo(() => new Set(acknowledgments.map((a) => a.field_id)), [acknowledgments])

  // Header stats — one count per VISUAL review row the user sees:
  //   - Each primary (non-contributing, non-rejected) field_mapping is 1 row
  //     → many-to-one contributes 1 (primary only; contributors render inside
  //       the same row as chips), one-to-many contributes N (one primary per
  //       split target).
  //   - Each unmapped source or target field is 1 row.
  // Approved = approved primaries + acknowledged unmapped fields (both are
  // "reviewed"). Needs Review = everything else (including acknowledged
  // unmapped counted into Total but into Approved, so it subtracts out).
  const headerStats = useMemo(() => {
    const sourceTableIds = new Set(tableMappings.map((tm) => tm.source_table_id))
    const targetTableIds = new Set(tableMappings.map((tm) => tm.target_table_id))

    const primaryFMs = allFMs.filter((fm) => !fm.is_contributing && fm.status !== 'rejected')
    const approvedPrimaryFMs = primaryFMs.filter((fm) => fm.status === 'approved').length

    // Source ids covered by a primary OR a non-rejected contributing row.
    // Contributors are folded into the primary's visual row, so their source
    // field is "handled" and must not show up in Unmapped.
    const mappedSourceIds = new Set<string>(
      primaryFMs.filter((fm) => fm.source_field_id).map((fm) => fm.source_field_id as string)
    )
    for (const fm of allFMs) {
      if (fm.is_contributing && fm.status !== 'rejected' && fm.source_field_id) {
        mappedSourceIds.add(fm.source_field_id)
      }
    }
    const mappedTargetIds = new Set(primaryFMs.map((fm) => fm.target_field_id))

    let unmappedSourceCount = 0
    let unmappedTargetCount = 0
    let acknowledgedCount = 0

    for (const [tableId, fields] of Object.entries(allFieldsByTable)) {
      if (sourceTableIds.has(tableId)) {
        for (const field of fields) {
          if (!mappedSourceIds.has(field.id)) {
            if (acknowledgedIds.has(field.id)) acknowledgedCount++
            else unmappedSourceCount++
          }
        }
      }
      if (targetTableIds.has(tableId)) {
        for (const field of fields) {
          if (!mappedTargetIds.has(field.id)) {
            if (acknowledgedIds.has(field.id)) acknowledgedCount++
            else unmappedTargetCount++
          }
        }
      }
    }

    const total = primaryFMs.length + unmappedSourceCount + unmappedTargetCount + acknowledgedCount
    const approved = approvedPrimaryFMs + acknowledgedCount
    const needsReview = total - approved

    return { total, approved, needsReview }
  }, [tableMappings, allFieldsByTable, allFMs, acknowledgedIds])

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
    for (const fm of allFMs.filter((f) => !f.is_contributing && f.status !== 'rejected' && f.source_field_id)) {
      sourceCounts.set(fm.source_field_id!, (sourceCounts.get(fm.source_field_id!) ?? 0) + 1)
    }
    return [...sourceCounts.values()].filter((c) => c > 1).reduce((sum, c) => sum + c, 0)
  }, [allFMs])

  const oneToOneCount = useMemo(() => {
    // Source field IDs that appear in 2+ primary non-rejected
    // mappings (these are one-to-many sources — exclude them)
    const multiSourceIds = new Set<string>()
    const sourceCounts = new Map<string, number>()
    for (const fm of allFMs.filter(
      (f) =>
        !f.is_contributing &&
        f.status !== 'rejected' &&
        f.source_field_id
    )) {
      const count =
        (sourceCounts.get(fm.source_field_id!) ?? 0) + 1
      sourceCounts.set(fm.source_field_id!, count)
      if (count > 1) multiSourceIds.add(fm.source_field_id!)
    }

    // Target field IDs that have contributing rows
    // (these are many-to-one targets — exclude them)
    const manyToOneTargetIds = new Set<string>(
      allFMs
        .filter(
          (f) => f.is_contributing && f.status !== 'rejected'
        )
        .map((f) => f.target_field_id)
    )

    return allFMs.filter(
      (fm) =>
        !fm.is_contributing &&
        fm.status !== 'rejected' &&
        fm.source_field_id !== null &&
        !multiSourceIds.has(fm.source_field_id!) &&
        !manyToOneTargetIds.has(fm.target_field_id)
    ).length
  }, [allFMs])

  const valueAssignmentCount = useMemo(
    () => allFMs.filter((fm) => fm.source_field_id === null && fm.status !== 'rejected').length,
    [allFMs]
  )

  // Sync filter state to URL (uses replace — does not add history entry)
  const syncFiltersToUrl = useCallback(
    (
      tableSelection: TableFieldSelection,
      status: StatusFilter,
      type: typeof mappingTypeFilter,
      search: string
    ) => {
      const params = new URLSearchParams()
      if (
        tableSelection.selectedFieldIds &&
        tableSelection.selectedFieldIds.size > 0
      ) {
        params.set(
          'fields',
          [...tableSelection.selectedFieldIds].join(',')
        )
      }
      if (status !== 'all') params.set('status', status)
      if (type !== 'all') params.set('type', type)
      if (search.trim()) params.set('q', search)
      const qs = params.toString()
      router.replace(
        `/app/projects/${projectId}/mapping${qs ? `?${qs}` : ''}`
      )
    },
    [router, projectId]
  )

  const handleTableSelectionChange = useCallback(
    (next: TableFieldSelection) => {
      setTableFieldSelection(next)
      syncFiltersToUrl(next, statusFilter, mappingTypeFilter, fieldSearchQuery)
    },
    [statusFilter, mappingTypeFilter, fieldSearchQuery, syncFiltersToUrl]
  )

  const handleStatusChange = useCallback(
    (next: StatusFilter) => {
      setStatusFilter(next)
      syncFiltersToUrl(tableFieldSelection, next, mappingTypeFilter, fieldSearchQuery)
    },
    [tableFieldSelection, mappingTypeFilter, fieldSearchQuery, syncFiltersToUrl]
  )

  const handleTypeChange = useCallback(
    (next: typeof mappingTypeFilter) => {
      setMappingTypeFilter(next)
      syncFiltersToUrl(tableFieldSelection, statusFilter, next, fieldSearchQuery)
    },
    [tableFieldSelection, statusFilter, fieldSearchQuery, syncFiltersToUrl]
  )

  const handleSearchChange = useCallback(
    (next: string) => {
      setFieldSearchQuery(next)
      syncFiltersToUrl(tableFieldSelection, statusFilter, mappingTypeFilter, next)
    },
    [tableFieldSelection, statusFilter, mappingTypeFilter, syncFiltersToUrl]
  )

  // Shape tableMappings into FilterTable[] for TableFieldFilter
  const filterTables = useMemo(
    (): FilterTable[] =>
      tableMappings.map((tm) => ({
        id: tm.id,
        label: `${tm.sourceTable?.name ?? '?'} → ${tm.targetTable?.name ?? '?'}`,
        fields: tm.fieldMappings
          .filter((fm) => !fm.is_contributing)
          .map((fm) => ({
            id: fm.id,
            label: `${fm.sourceField?.name ?? 'unmapped'} → ${fm.targetField?.name ?? '?'}`,
          })),
      })),
    [tableMappings]
  )

  const hasActiveFilters = useMemo(
    () =>
      (tableFieldSelection.selectedFieldIds !== null &&
        tableFieldSelection.selectedFieldIds.size > 0) ||
      statusFilter !== 'all' ||
      mappingTypeFilter !== 'all' ||
      fieldSearchQuery.trim() !== '',
    [tableFieldSelection, statusFilter, mappingTypeFilter, fieldSearchQuery]
  )

  const resetFilters = useCallback(() => {
    const empty: TableFieldSelection = {
      selectedFieldIds: null,
      selectedTableIds: new Set(),
    }
    setTableFieldSelection(empty)
    setStatusFilter('all')
    setMappingTypeFilter('all')
    setFieldSearchQuery('')
    router.replace(`/app/projects/${projectId}/mapping`)
  }, [router, projectId])

  const filteredMappings = useMemo(() => {
    let result = tableMappings

    // ── Table / field multi-selection filter
    if (
      tableFieldSelection.selectedFieldIds !== null &&
      tableFieldSelection.selectedFieldIds.size > 0
    ) {
      result = result
        .map((tm) => ({
          ...tm,
          fieldMappings: tm.fieldMappings.filter((fm) =>
            tableFieldSelection.selectedFieldIds!.has(fm.id)
          ),
        }))
        .filter(
          (tm) =>
            tm.fieldMappings.length > 0 ||
            // Keep table visible if any of its fields are selected
            // even if all are filtered out by other conditions
            tableFieldSelection.selectedTableIds.has(tm.id)
        )
    }

    // ── Status filter
    switch (statusFilter) {
      case 'needs_review': {
        const activeSrcIds = new Set(allFMs.filter((fm) => fm.status !== 'rejected' && fm.source_field_id).map((fm) => fm.source_field_id as string))
        const activeTgtIds = new Set(allFMs.filter((fm) => fm.status !== 'rejected' && fm.source_field_id !== null).map((fm) => fm.target_field_id))
        result = result.filter((tm) => {
          const hasNeedsReview = tm.fieldMappings.some((fm) => !fm.is_contributing && fm.status === 'needs_review')
          if (hasNeedsReview) return true
          const srcFields = allFieldsByTable[tm.source_table_id] ?? []
          const tgtFields = allFieldsByTable[tm.target_table_id] ?? []
          const hasUnackedSrc = srcFields.some((f) => !activeSrcIds.has(f.id) && !acknowledgedIds.has(f.id))
          const hasUnackedTgt = tgtFields.some((f) => !activeTgtIds.has(f.id) && !acknowledgedIds.has(f.id))
          return hasUnackedSrc || hasUnackedTgt
        })
        break
      }
      case 'approved':
        result = result
          .map((tm) => ({
            ...tm,
            fieldMappings: tm.fieldMappings.filter((fm) => !fm.is_contributing && fm.status === 'approved'),
          }))
          .filter((tm) => tm.fieldMappings.length > 0)
        break
      case 'unmapped': {
        result = result.filter((tm) => {
          const activeSrcIds = new Set(tm.fieldMappings.filter((fm) => fm.status !== 'rejected' && fm.source_field_id).map((fm) => fm.source_field_id as string))
          const activeTgtIds = new Set(tm.fieldMappings.filter((fm) => fm.status !== 'rejected' && fm.source_field_id !== null).map((fm) => fm.target_field_id))
          const allSrc = allFieldsByTable[tm.source_table_id] ?? []
          const allTgt = allFieldsByTable[tm.target_table_id] ?? []
          return allSrc.some((f) => !activeSrcIds.has(f.id)) || allTgt.some((f) => !activeTgtIds.has(f.id))
        })
        break
      }
      default:
        break
    }

    // ── Mapping type filter
    switch (mappingTypeFilter) {
      case 'one_to_one': {
        const sourceCounts = new Map<string, number>()
        for (const fm of allFMs.filter(
          (f) =>
            !f.is_contributing &&
            f.status !== 'rejected' &&
            f.source_field_id
        )) {
          sourceCounts.set(
            fm.source_field_id!,
            (sourceCounts.get(fm.source_field_id!) ?? 0) + 1
          )
        }
        const multiSourceIds = new Set(
          [...sourceCounts.entries()]
            .filter(([, c]) => c > 1)
            .map(([id]) => id)
        )
        const manyToOneTargetIds = new Set<string>(
          allFMs
            .filter(
              (f) => f.is_contributing && f.status !== 'rejected'
            )
            .map((f) => f.target_field_id)
        )
        result = result
          .map((tm) => ({
            ...tm,
            fieldMappings: tm.fieldMappings.filter(
              (fm) =>
                !fm.is_contributing &&
                fm.status !== 'rejected' &&
                fm.source_field_id !== null &&
                !multiSourceIds.has(fm.source_field_id!) &&
                !manyToOneTargetIds.has(fm.target_field_id)
            ),
          }))
          .filter((tm) => tm.fieldMappings.length > 0)
        break
      }
      case 'many_to_one':
        result = result
          .map((tm) => {
            const filtered = tm.fieldMappings.filter((fm) => {
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
        break
      case 'one_to_many': {
        const srcCounts = new Map<string, number>()
        for (const fm of allFMs.filter((f) => !f.is_contributing && f.status !== 'rejected' && f.source_field_id)) {
          srcCounts.set(fm.source_field_id!, (srcCounts.get(fm.source_field_id!) ?? 0) + 1)
        }
        const multiSrcIds = new Set(
          [...srcCounts.entries()].filter(([, c]) => c > 1).map(([id]) => id)
        )
        result = result
          .map((tm) => ({
            ...tm,
            fieldMappings: tm.fieldMappings.filter(
              (fm) => fm.source_field_id && multiSrcIds.has(fm.source_field_id)
            ),
          }))
          .filter((tm) => tm.fieldMappings.length > 0)
        break
      }
      case 'value_assignment':
        result = result
          .map((tm) => ({
            ...tm,
            fieldMappings: tm.fieldMappings.filter(
              (fm) => fm.source_field_id === null && fm.status !== 'rejected'
            ),
          }))
          .filter((tm) => tm.fieldMappings.length > 0)
        break
      default:
        break
    }

    // ── Text search
    if (fieldSearchQuery.trim()) {
      const q = fieldSearchQuery.toLowerCase().trim()
      result = result.filter((tm) =>
        tm.sourceTable?.name.toLowerCase().includes(q) ||
        tm.targetTable?.name.toLowerCase().includes(q) ||
        tm.fieldMappings.some(
          (fm) =>
            fm.sourceField?.name.toLowerCase().includes(q) ||
            fm.targetField?.name.toLowerCase().includes(q)
        )
      )
    }

    return result
  }, [tableMappings, tableFieldSelection, statusFilter, mappingTypeFilter, fieldSearchQuery, allFMs, allFieldsByTable, acknowledgedIds])

  const sourceDatasetName = tableMappings[0]?.sourceTable?.dataset?.name ?? ''
  const targetDatasetName = tableMappings[0]?.targetTable?.dataset?.name ?? ''

  const tableNameById = useMemo(() => {
    const map = new Map<string, string>()
    for (const t of data?.allSourceTables ?? []) map.set(t.id, t.name)
    for (const t of data?.allTargetTables ?? []) map.set(t.id, t.name)
    return map
  }, [data?.allSourceTables, data?.allTargetTables])

  const displayedTM = useMemo(
    () => tableMappings.find((tm) => tm.id === displayedFM?.table_mapping_id) ?? null,
    [tableMappings, displayedFM?.table_mapping_id]
  )

  // Peers are every non-rejected field_mapping on this TM that shares the
  // selected mapping's target_field_id. For a 1:1 mapping this collapses
  // to `[displayedFM]`; for a many-to-one it yields the primary + every
  // contributor, which is what the Source-fields section of the detail
  // panel (and its per-peer × / Add-field controls) operates over.
  const displayedPeerFMs = useMemo<RichFieldMapping[]>(() => {
    if (!displayedFM || !displayedTM) return displayedFM ? [displayedFM] : []
    return displayedTM.fieldMappings.filter(
      (f) =>
        f.target_field_id === displayedFM.target_field_id &&
        f.status !== 'rejected'
    )
  }, [displayedFM, displayedTM])

  const refreshData = useCallback(() => {
    startTransition(async () => {
      const fresh = await getMappings(projectId)
      if (fresh) {
        setData(fresh)
        setTableMappings(fresh.tableMappings)
        setUnmappedSource(fresh.unmappedSourceFields)
        setUnmappedTarget(fresh.unmappedTargetFields)
        setAcknowledgments(fresh.acknowledgments)
      }
    })
  }, [projectId])

  // Debounced + version-guarded variant for click-storm paths (ack / unack).
  // Each call resets the 500ms timer; only the trailing call actually hits
  // the server, and its response is only applied if no newer refresh has
  // been requested in the meantime. Other one-shot callers (approve, delete,
  // regenerate, modals) stay on the immediate `refreshData`.
  const debouncedRefresh = useCallback(() => {
    if (refreshTimerRef.current) clearTimeout(refreshTimerRef.current)
    refreshTimerRef.current = setTimeout(() => {
      const version = ++refreshVersionRef.current
      startTransition(async () => {
        const fresh = await getMappings(projectId)
        if (fresh && refreshVersionRef.current === version) {
          setData(fresh)
          setTableMappings(fresh.tableMappings)
          setUnmappedSource(fresh.unmappedSourceFields)
          setUnmappedTarget(fresh.unmappedTargetFields)
          setAcknowledgments(fresh.acknowledgments)
        }
      })
    }, 500)
  }, [projectId])

  // Clear any pending debounced refresh on unmount so the timeout doesn't
  // fire against a dead component and trigger a setState-on-unmounted warning.
  useEffect(() => {
    return () => {
      if (refreshTimerRef.current) clearTimeout(refreshTimerRef.current)
    }
  }, [])

  // Optimistic ack handlers — mirror the handleApprove / executeDeleteFM
  // pattern elsewhere in this file. The field-level status dot reads
  // directly from `acknowledgments`, so patching local state here turns
  // the dot green on the same frame as the click; refreshData() then
  // reconciles with the server-computed TM.status and coverage counts.
  const handleAcknowledge = useCallback(
    (fieldId: string, side: 'source' | 'target') => {
      const optimisticAck: FieldAcknowledgmentRow = {
        id: `optimistic-${fieldId}`,
        project_id: projectId,
        field_id: fieldId,
        side,
        reason: 'acknowledged',
        notes: null,
        acknowledged_at: new Date().toISOString(),
      }
      setAcknowledgments((prev) =>
        prev.some((a) => a.field_id === fieldId) ? prev : [...prev, optimisticAck]
      )

      startTransition(async () => {
        try {
          await acknowledgeField(projectId, fieldId, side, 'acknowledged')
          debouncedRefresh()
        } catch {
          setAcknowledgments((prev) => prev.filter((a) => a.field_id !== fieldId))
          setToast({ message: 'Could not acknowledge field', type: 'error' })
          setTimeout(() => setToast(null), 4000)
        }
      })
    },
    [projectId, debouncedRefresh]
  )

  const handleRemoveAcknowledgment = useCallback(
    (fieldId: string) => {
      const previous = acknowledgments
      setAcknowledgments((prev) => prev.filter((a) => a.field_id !== fieldId))

      startTransition(async () => {
        try {
          await removeAcknowledgment(projectId, fieldId)
          debouncedRefresh()
        } catch {
          setAcknowledgments(previous)
          setToast({ message: 'Could not remove acknowledgment', type: 'error' })
          setTimeout(() => setToast(null), 4000)
        }
      })
    },
    [projectId, debouncedRefresh, acknowledgments]
  )

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
      if (!r.success) {
        updateFM(fmId, { status: 'needs_review' })
        showToast(r.error ?? 'Could not approve mapping', 'error')
      }
      // Sync unmapped lists: approving a field removes it from the coverage gap
      else refreshData()
    })
  }

  function handleReject(fmId: string) {
    const fm = allFMs.find((f) => f.id === fmId)

    // Legacy path: a row already persisted as 'rejected' (pre-fix data) gets
    // un-rejected back to needs_review. New UI never produces rejected rows.
    if (fm?.status === 'rejected') {
      updateFM(fmId, { status: 'needs_review' })
      startTransition(async () => {
        const r = await updateFieldMappingStatus(fmId, 'needs_review')
        if (!r.success) {
          updateFM(fmId, { status: 'rejected' })
          showToast(r.error ?? 'Could not update mapping status', 'error')
        } else refreshData()
      })
      return
    }

    // New behavior: rejecting = deleting. No ghost rows. The row is removed
    // from the DB; freed source/target fields re-surface in the unmapped
    // sections via refreshData(). handleDeleteFM handles the transform-reset
    // warning if the mapping has staged data behind it.
    handleDeleteFM(fmId)
  }

  // Execute the delete immediately — called once the user has confirmed any warnings.
  function executeDeleteFM(fmId: string) {
    // Optimistic patch that mirrors deleteFieldMapping's server-side logic:
    // if we're removing the primary of a many-to-one group, the first
    // remaining non-rejected contributor is promoted in place by flipping
    // its is_contributing flag off. Without this promotion the row would
    // flicker out of the list (the render filter hides contributor-only
    // rows) until refreshData() completes — visually confusing when the
    // user is just trimming one peer out of a group.
    setTableMappings((prev) =>
      prev.map((tm) => {
        const deleted = tm.fieldMappings.find((fm) => fm.id === fmId)
        const remaining = tm.fieldMappings.filter((fm) => fm.id !== fmId)
        if (deleted && !deleted.is_contributing) {
          const promoteIdx = remaining.findIndex(
            (fm) =>
              fm.target_field_id === deleted.target_field_id &&
              fm.is_contributing &&
              fm.status !== 'rejected'
          )
          if (promoteIdx !== -1) {
            remaining[promoteIdx] = { ...remaining[promoteIdx], is_contributing: false }
          }
        }
        return { ...tm, fieldMappings: remaining }
      })
    )
    if (selectedFM?.id === fmId) setSelectedFM(null)
    startTransition(async () => {
      const r = await deleteFieldMapping(fmId)
      if (!r.success) {
        showToast(r.error ?? 'Could not delete field mapping', 'error')
      } else if (r.transformReset) {
        const stagedMsg = r.stagedRowsReverted && r.stagedRowsReverted > 0
          ? ` ${r.stagedRowsReverted} staged rows reverted.`
          : ''
        showToast(`Mapping deleted. Transform cleared.${stagedMsg}`, 'success')
      }
      refreshData()
    })
  }

  // Check for an existing transform before deleting. If one is found, show the
  // warning dialog so the user understands their staged data will be removed too.
  async function handleDeleteFM(fmId: string) {
    const check = await checkFieldMappingHasTransform(fmId)
    if (check.hasTransform) {
      const fm = allFMs.find((f) => f.id === fmId)
      const fieldLabel = fm?.sourceField?.name && fm?.targetField?.name
        ? `${fm.sourceField.name} → ${fm.targetField.name}`
        : fm?.targetField?.name ?? 'this field'
      setResetWarning({
        open: true,
        fieldMappingId: fmId,
        fieldName: fieldLabel,
        hasTransform: true,
        hasStagedData: check.hasStaged,
        action: 'delete',
        pendingAction: () => executeDeleteFM(fmId),
      })
      return
    }
    // No transform — delete immediately, no extra confirmation needed
    executeDeleteFM(fmId)
  }

  // Apply the edit optimistically and persist it — called once the user has confirmed warnings.
  function executeEditFM(fmId: string, updates: { source_field_id?: string; target_field_id?: string }) {
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
      if (!r.success) {
        showToast(r.error ?? 'Could not update field mapping', 'error')
      } else {
        const messages: string[] = ['Mapping updated.']
        if (r.valueAssignmentReplaced) messages.push('Value assignment replaced.')
        if (r.transformReset) messages.push('Transform reset.')
        if (r.fkDependentsReset && r.fkDependentsReset > 0) messages.push(`${r.fkDependentsReset} FK dependent transform(s) also reset.`)
        if (r.stagedRowsReverted && r.stagedRowsReverted > 0) messages.push(`${r.stagedRowsReverted} staged rows reverted.`)
        if (messages.length > 1) showToast(messages.join(' '), 'success')
      }
      refreshData()
      isInlineEditingRef.current = false
    })
  }

  function handleInlineEditTarget(fmId: string, newTargetFieldId: string) {
    isInlineEditingRef.current = true
    setSelectedFM(null)
    setIsPanelVisible(false)
    handleEditFM(fmId, { target_field_id: newTargetFieldId })
  }

  // Check for transforms and target-field conflicts before applying a source/target change.
  // Shows a warning dialog if anything would be reset or replaced; otherwise proceeds directly.
  async function handleEditFM(fmId: string, updates: { source_field_id?: string; target_field_id?: string }) {
    if (updates.target_field_id || updates.source_field_id) {
      const transformCheck = await checkFieldMappingHasTransform(fmId)

      // If target is changing, also look for conflicts on the new target
      let conflictInfo: Awaited<ReturnType<typeof handleTargetFieldConflict>> | null = null
      if (updates.target_field_id) {
        const fm = allFMs.find((f) => f.id === fmId)
        const tmId = fm?.table_mapping_id
        if (tmId) {
          const conflict = await handleTargetFieldConflict(tmId, updates.target_field_id, fmId)
          if (conflict.hasConflict) conflictInfo = conflict
        }
      }

      // If source is changing, check whether this is a PK field with FK dependents
      let pkImpact: Awaited<ReturnType<typeof checkPKSourceChangeImpact>> | null = null
      if (updates.source_field_id) {
        pkImpact = await checkPKSourceChangeImpact(fmId)
      }

      const hasValueAssignment = conflictInfo?.existingMappings.some((m) => m.isValueAssignment) ?? false
      const createsMultiSource = conflictInfo?.existingMappings.some((m) => !m.isValueAssignment) ?? false
      const conflictHasTransform = conflictInfo?.existingMappings.some((m) => m.hasTransform) ?? false
      const hasFKImpact = (pkImpact?.fkDependentCount ?? 0) > 0

      const needsWarning = transformCheck.hasTransform || conflictHasTransform || hasValueAssignment || hasFKImpact

      if (needsWarning) {
        const fm = allFMs.find((f) => f.id === fmId)
        const fieldLabel = fm?.sourceField?.name && fm?.targetField?.name
          ? `${fm.sourceField.name} → ${fm.targetField.name}`
          : fm?.targetField?.name ?? 'this field'
        setResetWarning({
          open: true,
          fieldMappingId: fmId,
          fieldName: fieldLabel,
          hasTransform: transformCheck.hasTransform,
          hasStagedData: transformCheck.hasStaged,
          action: 'remap',
          hasValueAssignment,
          createsMultiSource,
          conflictDetails: conflictInfo?.existingMappings ?? [],
          isPKSourceChange: pkImpact?.isPK && !!updates.source_field_id,
          fkDependentCount: pkImpact?.fkDependentCount ?? 0,
          fkDependentNames: pkImpact?.dependentNames ?? [],
          pendingAction: () => executeEditFM(fmId, updates),
        })
        return
      }
    }
    // No transform, no conflicts — proceed directly
    executeEditFM(fmId, updates)
  }

  function handleApproveAll(tmId: string) {
    setTableMappings((prev) => prev.map((tm) => tm.id !== tmId ? tm : { ...tm, status: 'approved', fieldMappings: tm.fieldMappings.map((fm) => ({ ...fm, status: 'approved' as const })) }))
    startTransition(async () => {
      const r = await approveAllFieldMappings(tmId)
      if (!r.success) showToast(r.error ?? 'Could not approve all field mappings', 'error')
      refreshData()
    })
  }

  function handleRejectAll(tmId: string) {
    setTableMappings((prev) => prev.map((tm) => tm.id !== tmId ? tm : { ...tm, fieldMappings: tm.fieldMappings.map((fm) => ({ ...fm, status: 'rejected' as const })) }))
    startTransition(async () => {
      const r = await rejectAllFieldMappings(tmId)
      if (!r.success) showToast(r.error ?? 'Could not reject all field mappings', 'error')
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
    startTransition(async () => {
      const r = await deleteTableMapping(id)
      if (!r.success) showToast(r.error ?? 'Could not delete table mapping', 'error')
      refreshData()
    })
  }

  function handleFieldAdded(tmId: string, newFM: RichFieldMapping) {
    setTableMappings((prev) => prev.map((tm) => tm.id !== tmId ? tm : { ...tm, fieldMappings: [...tm.fieldMappings, newFM] }))
    // Refresh to update unmapped counts
    refreshData()
  }

  // Adds a contributor to an existing mapping (many-to-one). Because we're
  // only *growing* the source side of an already-approved target mapping
  // (target hasn't changed, at least one peer remains, nothing else shifts),
  // this operation intentionally does NOT push the table_mapping back into
  // "Needs Review" — the server's addManualFieldMapping never touches
  // table_mappings.status, and this optimistic patch keeps the table's
  // existing status as-is. Only actions that alter which target columns
  // are covered (new target, removed target, regenerate) should demote the
  // table.
  function handleAddContributor(
    tmId: string,
    sourceFieldId: string,
    targetFieldId: string
  ) {
    const srcField = (allFieldsByTable[
      tableMappings.find((tm) => tm.id === tmId)?.source_table_id ?? ''
    ] ?? []).find((f) => f.id === sourceFieldId)
    const tgtField = (allFieldsByTable[
      tableMappings.find((tm) => tm.id === tmId)?.target_table_id ?? ''
    ] ?? []).find((f) => f.id === targetFieldId)

    startTransition(async () => {
      const result = await addManualFieldMapping(tmId, sourceFieldId, targetFieldId, true)
      if (!result.success) {
        showToast(result.error ?? 'Could not add contributor', 'error')
        return
      }

      // Optimistic patch so the new chip appears in the row/panel before
      // the refetch completes. The authoritative record will arrive on
      // refreshData() below.
      const newFM: RichFieldMapping = {
        id: result.data!.id,
        table_mapping_id: tmId,
        source_field_id: sourceFieldId,
        target_field_id: targetFieldId,
        confidence: 100,
        status: 'approved',
        ai_reasoning: 'Contributing source — manually added from detail panel',
        similar_fields_considered: null,
        type_compatibility: null,
        is_contributing: true,
        created_at: new Date().toISOString(),
        sourceField: srcField
          ? { id: srcField.id, name: srcField.name, data_type: srcField.data_type, inferred_type: null }
          : null,
        targetField: tgtField
          ? { id: tgtField.id, name: tgtField.name, data_type: tgtField.data_type, inferred_type: null }
          : null,
        sourceFieldSamples: [],
        targetFieldSamples: [],
        sourceFieldNullPercentage: 0,
        transformation: null,
      }
      setTableMappings((prev) =>
        prev.map((tm) =>
          tm.id !== tmId ? tm : { ...tm, fieldMappings: [...tm.fieldMappings, newFM] }
        )
      )
      refreshData()
    })
  }

  async function handleSuggestRemaining(tmId: string) {
    setSuggestingTMId(tmId)
    const result = await suggestRemainingMappings(tmId)
    setSuggestingTMId(null)
    if (!result.success) {
      showToast(result.error ?? 'Could not suggest remaining mappings', 'error')
      return
    }
    if (result.newMappingsCount > 0) refreshData()
  }

  async function handleRegenerate(tmId: string) {
    setRegenerateConfirmTarget(null)
    setRegeneratingTMId(tmId)
    const result = await regenerateFieldMappings(tmId)
    setRegeneratingTMId(null)
    if (!result.success) {
      showToast(result.error ?? 'Could not regenerate field mappings', 'error')
      return
    }
    if (result.transformsReset && result.transformsReset > 0) {
      const stagedMsg = result.stagedRowsReverted && result.stagedRowsReverted > 0
        ? ` ${result.stagedRowsReverted} staged rows cleared.`
        : ''
      showToast(
        `Regenerated. ${result.transformsReset} transform${result.transformsReset !== 1 ? 's' : ''} reset.${stagedMsg}`,
        'success'
      )
    }
    refreshData()
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

  if (tableMappings.length === 0) {
    return (
      <div className="flex-1 bg-gray-50 flex flex-col min-h-0">
        {toast && (
          <div
            className={`fixed bottom-6 right-6 z-50 px-4 py-3 rounded-lg shadow-lg text-sm font-medium ${
              toast.type === 'success' ? 'bg-green-600 text-white' : 'bg-red-600 text-white'
            }`}
          >
            {toast.message}
          </div>
        )}
        <PageHeader projectName={projectName} title="Mapping" subtitle="Review and approve field mappings" projectInfo={projectInfo} />
        <div className="flex-1 overflow-auto">
        <div className="px-6 py-5 max-w-3xl mx-auto">
        <p className="text-sm text-gray-500 mb-5">
          Select source and target tables, then generate field-level mappings with AI.
        </p>
        <GenerateMappingsPanel
          projectId={projectId}
          sourceTables={data?.allSourceTables ?? []}
          targetTables={data?.allTargetTables ?? []}
          onDone={() => refreshData()}
          canEdit={canEdit}
        />
      </div>
      </div>
      </div>
    )
  }

  return (
    <div className="flex-1 bg-gray-50 flex flex-col min-h-0 overflow-hidden">
      {toast && (
        <div
          className={`fixed bottom-6 right-6 z-50 px-4 py-3 rounded-lg shadow-lg text-sm font-medium ${
            toast.type === 'success' ? 'bg-green-600 text-white' : 'bg-red-600 text-white'
          }`}
        >
          {toast.message}
        </div>
      )}
      <PageHeader projectName={projectName} title="Mapping" subtitle="Review and approve field mappings" projectInfo={projectInfo} />

      {/* Stat pills — flush toolbar */}
      <MappingStatPills
        total={headerStats.total}
        approved={headerStats.approved}
        needsReview={headerStats.needsReview}
        sourceDatasetName={sourceDatasetName}
        targetDatasetName={targetDatasetName}
      />

      {/* Filter bar — flush border-b strip */}
      <div className="bg-white border-b border-gray-100 px-5 py-2.5 flex-shrink-0">
        <div className="flex items-center gap-3 min-w-0">

            {/* Table + field filter */}
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
                value={statusFilter}
                onValueChange={(val) => handleStatusChange(val as StatusFilter)}
              >
                <SelectTrigger className="h-8 text-xs w-[130px]">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All</SelectItem>
                  <SelectItem value="needs_review">Needs Review</SelectItem>
                  <SelectItem value="approved">Approved</SelectItem>
                  <SelectItem value="unmapped">Unmapped</SelectItem>
                </SelectContent>
              </Select>
            </div>

            <div className="w-px h-4 bg-gray-100 flex-shrink-0" />

            {/* Mapping type filter */}
            <div className="flex items-center gap-2">
              <label className="text-xs font-medium text-settle-slate-500 whitespace-nowrap">Type</label>
              <Select
                value={mappingTypeFilter}
                onValueChange={(val) => handleTypeChange(val as typeof mappingTypeFilter)}
              >
                <SelectTrigger className="h-8 text-xs w-[150px]">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All Types</SelectItem>
                  {oneToOneCount > 0 && (
                    <SelectItem value="one_to_one">One→One ({oneToOneCount})</SelectItem>
                  )}
                  {manyToOneCount > 0 && (
                    <SelectItem value="many_to_one">Many→One ({manyToOneCount})</SelectItem>
                  )}
                  {oneToManyCount > 0 && (
                    <SelectItem value="one_to_many">One→Many ({oneToManyCount})</SelectItem>
                  )}
                  {valueAssignmentCount > 0 && (
                    <SelectItem value="value_assignment">Value Assignment</SelectItem>
                  )}
                </SelectContent>
              </Select>
            </div>

            <div className="w-px h-4 bg-gray-100 flex-shrink-0" />

            {/* Search */}
            <input
              type="text"
              placeholder="Search fields…"
              value={fieldSearchQuery}
              onChange={(e) => handleSearchChange(e.target.value)}
              className="h-8 text-xs border border-settle-slate-200 rounded-md px-3 w-44 focus:outline-none focus:ring-1 focus:ring-settle-blue-500 text-settle-slate-700 placeholder:text-settle-slate-400"
            />

            {/* Right: count + reset */}
            <div className="ml-auto flex items-center gap-3 flex-shrink-0">
              <span className="text-xs text-settle-slate-400 whitespace-nowrap">
                <span className="font-medium text-settle-slate-600">{filteredMappings.length}</span>
                {' '}
                {filteredMappings.length === 1 ? 'table' : 'tables'}
              </span>
              {hasActiveFilters && (
                <button
                  onClick={resetFilters}
                  className="text-xs text-blue-600 hover:text-blue-800 hover:underline whitespace-nowrap"
                >
                  Reset filters
                </button>
              )}
            </div>

          </div>
      </div>

      {/* Scrollable content */}
      <div className="flex-1 overflow-auto">
      <div className="px-5 py-4 space-y-3">
      <div className="flex items-start">
        <div className="flex-1 space-y-2 min-w-0">
          {filteredMappings.length === 0 ? (
            <div className="text-center py-12 text-sm text-gray-400 border border-dashed border-gray-100 rounded-lg">
              {statusFilter === 'needs_review' ? 'All mappings reviewed and all fields addressed.' : statusFilter === 'approved' ? 'No approved mappings yet.' : statusFilter === 'unmapped' ? 'All fields are mapped or acknowledged.' : mappingTypeFilter === 'many_to_one' ? 'No many-to-one mappings found.' : mappingTypeFilter === 'one_to_many' ? 'No one-to-many mappings found.' : mappingTypeFilter === 'value_assignment' ? 'No value assignments found.' : 'No mappings found.'}
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
                onMappingsSync={refreshData}
                allFieldsByTable={allFieldsByTable}
                suggestingThis={suggestingTMId === tm.id}
                onSuggestRemaining={() => handleSuggestRemaining(tm.id)}
                regeneratingThis={regeneratingTMId === tm.id}
                onRegenerate={() => setRegenerateConfirmTarget(tm)}
                showContributingRows={mappingTypeFilter === 'many_to_one'}
                showInlineUnmapped={statusFilter === 'all' || statusFilter === 'unmapped' || statusFilter === 'needs_review'}
                hideMappedRows={statusFilter === 'unmapped'}
                filterVisibleStatus={statusFilter === 'needs_review' ? 'needs_review' : undefined}
                acknowledgments={acknowledgments}
                onAcknowledge={handleAcknowledge}
                onRemoveAcknowledgment={handleRemoveAcknowledgment}
                canEdit={canEdit}
                selectedFMId={selectedFM?.id ?? null}
                tableNameById={tableNameById}
                onEditFieldTarget={handleInlineEditTarget}
                onError={(msg) => showToast(msg, 'error')}
              />
            ))
          )}
        </div>

      </div>

      <MappingDetailsPanel
        fm={displayedFM}
        peerFMs={displayedPeerFMs}
        isOpen={isPanelVisible}
        onClose={() => {
          setIsPanelVisible(false)
          setRejectConfirmOpen(false)
          setTimeout(() => setSelectedFM(null), 200)
        }}
        onApprove={() => {
          if (displayedFM) handleApprove(displayedFM.id)
        }}
        onReject={() => {
          if (displayedFM) handleReject(displayedFM.id)
        }}
        onChangeSource={(fieldId) => {
          if (displayedFM) handleEditFM(displayedFM.id, { source_field_id: fieldId })
        }}
        onChangeTarget={(fieldId) => {
          if (displayedFM) handleEditFM(displayedFM.id, { target_field_id: fieldId })
        }}
        onRemove={() => {
          if (displayedFM) handleDeleteFM(displayedFM.id)
        }}
        onRemovePeer={(fmId) => handleDeleteFM(fmId)}
        onAddContributor={(sourceFieldId) => {
          if (displayedFM && displayedTM) {
            handleAddContributor(displayedTM.id, sourceFieldId, displayedFM.target_field_id)
          }
        }}
        projectId={projectId}
        tableMappingId={displayedFM?.table_mapping_id ?? ''}
        allFieldsByTable={allFieldsByTable}
        canEdit={canEdit}
        aiReasoningOpen={aiReasoningOpen}
        onToggleReasoning={() => setAiReasoningOpen((v) => !v)}
        rejectConfirmOpen={rejectConfirmOpen}
        onRequestReject={() => setRejectConfirmOpen(true)}
        onCloseRejectConfirm={() => setRejectConfirmOpen(false)}
        onRemap={() => {
          setRejectConfirmOpen(false)
        }}
        sourceTableFields={allFieldsByTable[displayedTM?.source_table_id ?? ''] ?? []}
        sourceTableName={tableNameById.get(displayedTM?.source_table_id ?? '') ?? ''}
        targetTableFields={allFieldsByTable[displayedTM?.target_table_id ?? ''] ?? []}
        targetTableName={tableNameById.get(displayedTM?.target_table_id ?? '') ?? ''}
      />

      {/* Bottom bar */}
      <div className="flex items-center gap-3 pt-2 border-t border-gray-100">
        <div className="flex items-center gap-3">
          <RoleTooltip allowed={canEdit} requiredRole="Editor">
            <button onClick={canEdit ? () => setShowAddModal(true) : undefined} disabled={!canEdit} className="flex items-center gap-2 text-sm font-medium text-gray-600 hover:text-blue-700 transition-colors disabled:opacity-40 disabled:cursor-not-allowed">
              <Plus className="w-4 h-4" />
              Add New Mapping
            </button>
          </RoleTooltip>
          {unmappedSourceTablesForModal.length > 0 && unmappedTargetTablesForModal.length > 0 && (
            <RoleTooltip allowed={canEdit} requiredRole="Editor">
              <button
                onClick={canEdit ? () => setShowGenerateModal(true) : undefined}
                disabled={!canEdit}
                className="flex items-center gap-1.5 text-sm font-medium text-blue-600 hover:text-blue-800 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <polyline points="23 4 23 10 17 10" /><polyline points="1 20 1 14 7 14" />
                  <path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15" />
                </svg>
                Generate More Mappings
              </button>
            </RoleTooltip>
          )}
        </div>
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
                <h2 className="text-lg font-semibold text-gray-900">Generate More Mappings</h2>
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
                canEdit={canEdit}
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

      {resetWarning && (
        <TransformResetWarning
          open={resetWarning.open}
          onOpenChange={(open) => { if (!open) setResetWarning(null) }}
          onConfirm={() => {
            resetWarning.pendingAction()
            setResetWarning(null)
          }}
          action={resetWarning.action}
          fieldName={resetWarning.fieldName}
          hasTransform={resetWarning.hasTransform}
          hasStagedData={resetWarning.hasStagedData}
          affectedCount={resetWarning.affectedCount}
          hasValueAssignment={resetWarning.hasValueAssignment}
          createsMultiSource={resetWarning.createsMultiSource}
          conflictDetails={resetWarning.conflictDetails}
          isPKSourceChange={resetWarning.isPKSourceChange}
          fkDependentCount={resetWarning.fkDependentCount}
          fkDependentNames={resetWarning.fkDependentNames}
        />
      )}
    </div>
    </div>
    </div>
  )
}
