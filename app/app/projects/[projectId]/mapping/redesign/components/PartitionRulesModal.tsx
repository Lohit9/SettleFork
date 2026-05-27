'use client'

/**
 * PartitionRulesModal — form-in-dialog for creating + editing a partition.
 * Mirrors AddFieldModal.tsx (data-overview/AddFieldModal.tsx) shape:
 *   - Inline overlay (fixed inset-0, z-50)
 *   - Plain useState for in-flight flag (not useTransition — see
 *     AddFieldModal.tsx:80-85 for the rationale)
 *   - synchronous mutex via savingRef against double-fire (INF-79 pattern)
 *   - Error banner above footer
 *   - Disabled state on saving
 *
 * Form fields (5):
 *   1. Partition label — text input; required; unique per target_table
 *      (server-enforced; client shows inline duplicate on submit failure)
 *   2. Source table — select dropdown; required; populated from
 *      `sourceTables` prop
 *   3. Row filter (SQL) — plain <textarea>; optional; "Test filter" button
 *      calls `testFilterSql` server action and renders verbose result
 *      inline (per Q7 pilot decision)
 *   4. Identity field — select dropdown; required when any sibling has
 *      identity_field_id set (sibling-consistency contract); populated from
 *      `targetFields` filtered to the partition's target table
 *   5. Dedup priority — number input; optional; integer ≥ 0
 *
 * MODES:
 *   - Create (editing=null): all fields empty; submit calls createPartition
 *   - Edit (editing=PartitionInfo): pre-filled; submit calls
 *     updatePartitionFilter (if filter changed) and updatePartitionMetadata
 *     (if any non-filter field changed)
 *
 * Delete is NOT shipped in this modal — design doc Q9 defers the delete
 * flow to PR Ω.3.2.1 follow-up (AlertDialog with staged-row cascade
 * confirmation). The [⚙] icon on each tab opens this modal; the modal
 * has Save / Cancel, not Delete.
 */

import { useMemo, useRef, useState } from 'react'
import { z } from 'zod'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import {
  createPartition,
  updatePartitionFilter,
  updatePartitionMetadata,
  testFilterSql,
} from '@/lib/actions/partitions'
import type { PartitionInfo } from '@/lib/types/mappings-for-redesign'

// ─── Tunable bounds — match server-side schemas in lib/actions/partitions.ts ──

const PARTITION_LABEL_MAX_LENGTH = 64
const FILTER_SQL_MAX_LENGTH = 8000

// Sentinel for the "(none)" option in the identity-field Select.
//
// `@radix-ui/react-select@^2` throws at render whenever a `Select.Item`
// has `value=""` — the empty string is reserved by Radix to signal
// "clear selection / show placeholder" at the root level, and using it
// on an item is a violation the library rejects synchronously. We need
// a real "(none)" choice in the dropdown (identity_field_id is
// nullable), so this sentinel stands in for null at the Radix
// boundary. Map to/from null at the three boundaries that touch it:
//   • <Select value=…> — render `IDENTITY_FIELD_NONE` when the state is null
//   • <SelectItem value=…> — the (none) item is hard-coded to the sentinel
//   • onValueChange — convert the sentinel back to null before setState
const IDENTITY_FIELD_NONE = '__none__'

// ─── Client-side Zod schemas ──────────────────────────────────────────────
//
// Server-side schemas are authoritative (see lib/actions/partitions.ts).
// These mirror them for client-side fail-fast; the server schema catches
// anything the client misses + handles concurrent-write conflicts.

const formSchema = z.object({
  label: z
    .string()
    .trim()
    .min(2, 'Partition label must be at least 2 characters')
    .max(PARTITION_LABEL_MAX_LENGTH, `Label must be ${PARTITION_LABEL_MAX_LENGTH} characters or less`),
  sourceTableId: z.string().uuid('Pick a source table'),
  filterSql: z
    .string()
    .trim()
    .max(FILTER_SQL_MAX_LENGTH, `Filter SQL must be ${FILTER_SQL_MAX_LENGTH} characters or less`)
    .nullable(),
  identityFieldId: z.string().uuid().nullable(),
  dedupPriority: z.number().int().min(0).nullable(),
})

// ─── Props ────────────────────────────────────────────────────────────────

interface SourceTableChoice {
  id: string
  name: string
  datasetName: string
}

interface TargetFieldChoice {
  id: string
  name: string
}

interface PartitionRulesModalProps {
  /** Project id — required for testFilterSql + createPartition. */
  projectId: string
  /** Target table id this partition belongs to. */
  targetTableId: string
  /** Target table display name (modal header). */
  targetTableName: string
  /** Source tables available in the project (Select dropdown options). */
  sourceTables: SourceTableChoice[]
  /** Target fields under `targetTableId` — populates the identity-field
   *  dropdown. Identity field must belong to the target table per the
   *  partition-binding model. */
  identityFieldOptions: TargetFieldChoice[]
  /** Existing partitions for this target table — used for:
   *  - Label-uniqueness inline check (client-side fail-fast)
   *  - Identity-field consistency check (sibling-match contract) */
  siblings: PartitionInfo[]
  /** When set, modal opens in EDIT mode with pre-filled fields. */
  editing: PartitionInfo | null
  /** Open / close. Parent owns state. */
  open: boolean
  onClose: () => void
  /** Success callback. Parent calls router.refresh() or splices the new
   *  partition into local state. The callback receives an UPDATED-or-
   *  CREATED PartitionInfo if known; for create mode we can't fabricate
   *  one without re-fetching, so the callback is fire-and-forget. */
  onSaved: () => void
  /** PR Ω.3.2.1 — fired when the user clicks "Delete partition" in
   *  edit mode. Parent owns mounting `PartitionDeleteConfirmDialog`
   *  (and the deletePartition action that follows). This callback
   *  does NOT close the modal — the parent decides whether to keep
   *  the modal mounted while the confirm dialog is up (per the
   *  "modal stays open while dialog is open" contract from §4 PRMD4).
   *  Optional; when omitted (legacy fixtures / storybook / create-mode
   *  callers), the Delete affordance is hidden entirely. */
  onDelete?: () => void
}

// ─── Component ─────────────────────────────────────────────────────────────

export function PartitionRulesModal({
  projectId,
  targetTableId,
  targetTableName,
  sourceTables,
  identityFieldOptions,
  siblings,
  editing,
  open,
  onClose,
  onSaved,
  onDelete,
}: PartitionRulesModalProps) {
  const isEdit = editing !== null

  // ── Form state — seeded from `editing` when in edit mode ────────────────
  const [label, setLabel] = useState(editing?.label ?? '')
  const [sourceTableId, setSourceTableId] = useState(editing?.sourceTableId ?? '')
  const [filterSqlText, setFilterSqlText] = useState(editing?.filterSql ?? '')
  const [identityFieldId, setIdentityFieldId] = useState<string | null>(
    editing?.identityFieldId ?? null,
  )
  const [dedupPriorityText, setDedupPriorityText] = useState(
    editing?.dedupPriority != null ? String(editing.dedupPriority) : '',
  )

  // ── In-flight + result state ────────────────────────────────────────────
  const [saving, setSaving] = useState(false)
  const savingRef = useRef(false)
  const [error, setError] = useState<string | null>(null)

  // Test-filter affordance state. `null` = never tested in this session;
  // `{ ok: true }` = passed; `{ ok: false, message }` = failed with verbose
  // RPC error.
  const [testResult, setTestResult] = useState<{ ok: boolean; message?: string } | null>(null)
  const [testingFilter, setTestingFilter] = useState(false)

  // ── Inline validation ───────────────────────────────────────────────────
  const trimmedLabel = label.trim()

  // Label uniqueness: scope to sibling partitions of the same target_table,
  // excluding the partition being edited.
  const isDuplicateLabel = useMemo(() => {
    if (trimmedLabel.length === 0) return false
    return siblings.some(
      (s) => s.id !== editing?.id && s.label?.trim() === trimmedLabel,
    )
  }, [trimmedLabel, siblings, editing?.id])

  // Identity-field consistency: if any OTHER sibling has identity_field_id
  // set, this partition's identity_field_id must match. (Sibling-consistency
  // contract enforced server-side in createPartition / updatePartitionMetadata.)
  const requiredIdentityField = useMemo(() => {
    const siblingWithIdentity = siblings.find(
      (s) => s.id !== editing?.id && s.identityFieldId != null,
    )
    return siblingWithIdentity?.identityFieldId ?? null
  }, [siblings, editing?.id])

  const identityFieldMismatch =
    requiredIdentityField != null &&
    identityFieldId != null &&
    identityFieldId !== requiredIdentityField

  // ── Compute dedup priority as a parsed number for submit ────────────────
  const dedupPriorityValue: { ok: boolean; value: number | null } = useMemo(() => {
    const trimmed = dedupPriorityText.trim()
    if (trimmed.length === 0) return { ok: true, value: null }
    const parsed = Number(trimmed)
    if (!Number.isInteger(parsed) || parsed < 0) return { ok: false, value: null }
    return { ok: true, value: parsed }
  }, [dedupPriorityText])

  // ── Canonical filterSql value to send to the server: trim + nullify empty ──
  const filterSqlValue = useMemo(() => {
    const trimmed = filterSqlText.trim()
    return trimmed.length === 0 ? null : trimmed
  }, [filterSqlText])

  // Submit gate.
  const canSubmit =
    !saving &&
    !isDuplicateLabel &&
    !identityFieldMismatch &&
    dedupPriorityValue.ok &&
    formSchema.safeParse({
      label: trimmedLabel,
      sourceTableId,
      filterSql: filterSqlValue,
      identityFieldId,
      dedupPriority: dedupPriorityValue.value,
    }).success

  // ── Handlers ────────────────────────────────────────────────────────────

  async function handleTestFilter() {
    if (!filterSqlValue || !sourceTableId || testingFilter) return
    setTestingFilter(true)
    setTestResult(null)
    try {
      const result = await testFilterSql({
        projectId,
        sourceTableId,
        filterSql: filterSqlValue,
      })
      if (result.success) {
        setTestResult({ ok: true })
      } else {
        // Verbose error message preserved per Q7 pilot decision.
        setTestResult({ ok: false, message: result.error ?? 'Filter validation failed' })
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'Filter test failed'
      setTestResult({ ok: false, message: msg })
    } finally {
      setTestingFilter(false)
    }
  }

  async function handleSave() {
    if (savingRef.current || !canSubmit) return
    savingRef.current = true
    setError(null)
    setSaving(true)
    try {
      if (isEdit && editing) {
        // EDIT mode: split into filter-update + metadata-update calls
        // depending on which fields changed.
        const filterChanged = filterSqlValue !== (editing.filterSql ?? null)
        const labelChanged = trimmedLabel !== (editing.label ?? '')
        const identityChanged = identityFieldId !== (editing.identityFieldId ?? null)
        const priorityChanged = dedupPriorityValue.value !== (editing.dedupPriority ?? null)
        // Ordinal is not edited via this modal in Ω.3.2 (no UI affordance);
        // future-proofing only.

        if (filterChanged) {
          const r = await updatePartitionFilter({
            tableMappingId: editing.id,
            filterSql: filterSqlValue,
          })
          if (!r.success) {
            setError(r.error ?? 'Filter update failed')
            return
          }
        }

        if (labelChanged || identityChanged || priorityChanged) {
          const r = await updatePartitionMetadata({
            tableMappingId: editing.id,
            partitionLabel: labelChanged ? trimmedLabel : undefined,
            identityFieldId: identityChanged ? identityFieldId : undefined,
            dedupPriority: priorityChanged ? dedupPriorityValue.value : undefined,
          })
          if (!r.success) {
            setError(r.error ?? 'Partition metadata update failed')
            return
          }
        }

        onSaved()
        onClose()
        return
      }

      // CREATE mode.
      const r = await createPartition({
        projectId,
        sourceTableId,
        targetTableId,
        partitionLabel: trimmedLabel,
        filterSql: filterSqlValue,
        identityFieldId,
        dedupPriority: dedupPriorityValue.value,
      })
      if (!r.success) {
        setError(r.error ?? 'Partition creation failed')
        return
      }

      onSaved()
      onClose()
    } finally {
      setSaving(false)
      savingRef.current = false
    }
  }

  if (!open) return null

  return (
    <div
      data-testid="partition-rules-modal"
      role="dialog"
      aria-modal="true"
      aria-labelledby="partition-modal-title"
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget && !saving) onClose()
      }}
    >
      <div className="bg-white rounded-xl shadow-xl w-full max-w-lg p-6 max-h-[90vh] overflow-y-auto">
        <div className="flex items-center gap-2 mb-4">
          <h3 id="partition-modal-title" className="text-base font-semibold text-gray-900">
            {isEdit ? 'Edit partition' : 'Add partition to'}{' '}
            <span className="text-gray-700">{targetTableName}</span>
          </h3>
        </div>

        <div className="space-y-4">
          {/* Partition label */}
          <div>
            <label
              htmlFor="partition-label"
              className="block text-xs font-medium text-gray-700 mb-1"
            >
              Partition label
            </label>
            <input
              id="partition-label"
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              disabled={saving}
              autoFocus
              maxLength={PARTITION_LABEL_MAX_LENGTH}
              placeholder="e.g. Engineering items"
              className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 disabled:bg-gray-50 disabled:text-gray-500"
            />
            {isDuplicateLabel && (
              <p className="mt-1 text-xs text-red-600">
                A partition named &ldquo;{trimmedLabel}&rdquo; already exists for this target table.
              </p>
            )}
          </div>

          {/* Source table */}
          <div>
            <label className="block text-xs font-medium text-gray-700 mb-1">
              Source table
            </label>
            <Select
              value={sourceTableId}
              onValueChange={(val) => {
                setSourceTableId(val)
                // Source change invalidates a prior filter test (filter is
                // scoped to a specific source table's columns).
                setTestResult(null)
              }}
              disabled={saving || isEdit}
            >
              <SelectTrigger className="w-full h-9 text-sm">
                <SelectValue placeholder="Pick a source table…" />
              </SelectTrigger>
              <SelectContent>
                {sourceTables.map((t) => (
                  <SelectItem key={t.id} value={t.id}>
                    {t.name}
                    {t.datasetName ? (
                      <span className="ml-2 text-xs text-gray-500">({t.datasetName})</span>
                    ) : null}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {isEdit && (
              <p className="mt-1 text-xs text-gray-500">
                Source table cannot be changed after creation.
              </p>
            )}
          </div>

          {/* Row filter (SQL) */}
          <div>
            <label
              htmlFor="partition-filter-sql"
              className="block text-xs font-medium text-gray-700 mb-1"
            >
              Row filter (optional)
            </label>
            <textarea
              id="partition-filter-sql"
              value={filterSqlText}
              onChange={(e) => {
                setFilterSqlText(e.target.value)
                // Filter change invalidates a prior test.
                setTestResult(null)
              }}
              disabled={saving}
              rows={4}
              maxLength={FILTER_SQL_MAX_LENGTH}
              placeholder="Status = 'ACTIVE'"
              className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-blue-500 disabled:bg-gray-50 disabled:text-gray-500"
            />
            <div className="mt-1 flex items-center justify-between">
              <button
                type="button"
                onClick={handleTestFilter}
                disabled={
                  saving ||
                  testingFilter ||
                  !filterSqlValue ||
                  !sourceTableId
                }
                data-testid="partition-test-filter"
                className="inline-flex items-center rounded-md border border-gray-300 bg-white px-2.5 py-1 text-xs font-medium text-gray-700 hover:bg-gray-50 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {testingFilter ? 'Testing…' : 'Test filter'}
              </button>
              {testResult?.ok === true && (
                <span data-testid="partition-test-result-ok" className="text-xs text-green-700">
                  ✓ Filter is valid
                </span>
              )}
              {testResult?.ok === false && (
                <span
                  data-testid="partition-test-result-err"
                  className="text-xs text-red-600 max-w-[60%] text-right truncate"
                  title={testResult.message}
                >
                  ✗ {testResult.message}
                </span>
              )}
            </div>
          </div>

          {/* Identity field — future-compat for dedup engine */}
          <div>
            <label className="block text-xs font-medium text-gray-700 mb-1">
              Identity field (for future dedup engine)
            </label>
            <Select
              value={identityFieldId ?? IDENTITY_FIELD_NONE}
              onValueChange={(val) =>
                setIdentityFieldId(val === IDENTITY_FIELD_NONE ? null : val)
              }
              disabled={saving}
            >
              <SelectTrigger className="w-full h-9 text-sm">
                <SelectValue placeholder="(none)" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={IDENTITY_FIELD_NONE}>(none)</SelectItem>
                {identityFieldOptions.map((f) => (
                  <SelectItem key={f.id} value={f.id}>
                    {f.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {identityFieldMismatch && (
              <p className="mt-1 text-xs text-red-600">
                Identity field must match sibling partitions. Sibling uses{' '}
                {identityFieldOptions.find((f) => f.id === requiredIdentityField)?.name ??
                  requiredIdentityField}
                .
              </p>
            )}
          </div>

          {/* Dedup priority */}
          <div>
            <label
              htmlFor="partition-dedup-priority"
              className="block text-xs font-medium text-gray-700 mb-1"
            >
              Dedup priority (lower wins on conflict; optional)
            </label>
            <input
              id="partition-dedup-priority"
              type="number"
              min={0}
              step={1}
              value={dedupPriorityText}
              onChange={(e) => setDedupPriorityText(e.target.value)}
              disabled={saving}
              placeholder="0"
              className="w-32 border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 disabled:bg-gray-50 disabled:text-gray-500"
            />
            {!dedupPriorityValue.ok && (
              <p className="mt-1 text-xs text-red-600">
                Priority must be a non-negative integer.
              </p>
            )}
          </div>
        </div>

        {error && (
          <div
            role="alert"
            data-testid="partition-modal-error"
            className="mt-4 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700"
          >
            {error}
          </div>
        )}

        {/*
          Footer split: destructive "Delete partition" on the left,
          Cancel + Save cluster on the right. Visual separation matches
          the safety-first pattern used by GitHub / Linear / Notion —
          the destructive trigger is intentionally far from the primary
          confirm so a fast click can't land on it by accident. The
          left wrapper is ALWAYS rendered (empty in create mode) so the
          right cluster stays right-aligned via `justify-between`
          regardless of whether the Delete affordance is mounted.
        */}
        <div className="mt-6 flex items-center justify-between gap-2">
          <div>
            {isEdit && onDelete ? (
              <button
                type="button"
                onClick={onDelete}
                disabled={saving}
                data-testid="partition-modal-delete"
                className="inline-flex items-center rounded-md border border-red-300 bg-white px-3 py-1.5 text-sm font-medium text-red-600 hover:bg-red-50 disabled:cursor-not-allowed disabled:opacity-50"
              >
                Delete partition
              </button>
            ) : null}
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={onClose}
              disabled={saving}
              className="inline-flex items-center rounded-md border border-gray-300 bg-white px-3 py-1.5 text-sm font-medium text-gray-700 hover:bg-gray-50 disabled:cursor-not-allowed disabled:opacity-50"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={handleSave}
              disabled={!canSubmit}
              data-testid="partition-modal-submit"
              className="inline-flex items-center rounded-md bg-gray-900 px-3 py-1.5 text-sm font-medium text-white hover:bg-gray-800 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {saving ? (isEdit ? 'Saving…' : 'Adding…') : isEdit ? 'Save partition' : 'Add partition'}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
