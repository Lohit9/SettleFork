'use client'

/**
 * AddFieldModal — schema-overview "+" affordance for creating a new field
 * on a target table. Mirrors FieldEditModal's inline-modal markup at
 * SchemaOverview.tsx; share-by-convention (we deliberately do NOT
 * extract a common shell — the two forms drift quickly and a thin shared
 * helper would obscure the per-mode handlers).
 */

import { useMemo, useRef, useState } from 'react'
import { Plus } from '@/components/icons'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { createField } from '@/lib/actions/fields'
import type { Field } from '@/lib/types/database'
import { RoleTooltip } from '@/components/app/RoleTooltip'

// Same canonical type list FieldEditModal uses. Deliberate duplication —
// see SchemaOverview.tsx:18-32; lifting to a shared module isn't worth it
// for ~14 lines of static data.
const COMMON_TYPES = [
  'VARCHAR(255)',
  'VARCHAR(80)',
  'VARCHAR(40)',
  'VARCHAR(18)',
  'CHAR(10)',
  'INT',
  'BIGINT',
  'DECIMAL(18,2)',
  'BOOLEAN',
  'DATE',
  'TIMESTAMP',
  'TEXT',
  'UUID',
]

const DEFAULT_DATA_TYPE = COMMON_TYPES[0] // 'VARCHAR(255)'

interface AddFieldModalProps {
  tableId: string
  tableName: string
  /** Existing field names on this table — for case-sensitive client-side
   *  duplicate detection (Q7 locked: server is authoritative; this is UX
   *  bail-early). Pass `table.fields.map(f => f.name)`. */
  existingFieldNames: string[]
  /** PK options for the FK reference dropdown in `TABLE.FIELD` form.
   *  Same shape SchemaPanel.buildFkOptions returns for FieldEditModal. */
  fkOptions: string[]
  /** Defense-in-depth: server enforces editor role, but the parent
   *  already gates the "+" affordance on `canEdit`. Wrapping the Add
   *  button hardens the modal against stale role state in long sessions. */
  canEdit: boolean
  onClose: () => void
  /** Called with the full new Field row on success. Parent splices into
   *  per-table local state — no router.refresh() needed (Q5 locked). */
  onAdded: (field: Field) => void
}

export default function AddFieldModal({
  tableId,
  tableName,
  existingFieldNames,
  fkOptions,
  canEdit,
  onClose,
  onAdded,
}: AddFieldModalProps) {
  const [name, setName] = useState('')
  const [dataType, setDataType] = useState(DEFAULT_DATA_TYPE)
  const [isNullable, setIsNullable] = useState(true)
  const [isPK, setIsPK] = useState(false)
  const [isFK, setIsFK] = useState(false)
  const [fkRef, setFkRef] = useState('')
  // Plain useState for the in-flight flag rather than useTransition: React
  // 18.3's useTransition doesn't reliably keep isPending=true across `await`
  // boundaries, which makes the "Adding…" mid-flight UX unreliable in tests
  // and (latently) in production. The existing FieldEditModal uses
  // useTransition with the same shape — that's a known weakness, out of
  // scope to fix here.
  const [saving, setSaving] = useState(false)
  // INF-79: synchronous mutex against double-fire on rapid double-click.
  // The `saving` state controls the visual; the ref is the gate that the
  // second click hits before React commits the disabled-attribute update.
  const savingRef = useRef(false)
  const [error, setError] = useState<string | null>(null)

  // Inline duplicate-name flag — case-sensitive (Q7 locked: Postgres TEXT
  // is case-sensitive by default; the server's name_collision check uses
  // the same comparison).
  const trimmedName = name.trim()
  const isDuplicate = useMemo(
    () => trimmedName.length > 0 && existingFieldNames.includes(trimmedName),
    [trimmedName, existingFieldNames]
  )

  const fkReferenceToPersist = isFK ? fkRef.trim() || null : null
  const canSubmit = canEdit && trimmedName.length > 0 && !isDuplicate && !saving

  async function handleSave() {
    if (savingRef.current || !canSubmit) return
    savingRef.current = true
    setError(null)
    setSaving(true)
    try {
      const result = await createField({
        tableId,
        name: trimmedName,
        dataType: dataType.trim(),
        isNullable,
        isPrimaryKey: isPK,
        isForeignKey: isFK,
        fkReference: fkReferenceToPersist,
      })
      if (!result.success) {
        // FieldErrorCode → user-facing message map. `name_collision` could
        // land inline under the Field Name input (we already show that for
        // the client-side dup-check) but lands in the bottom alert here for
        // simplicity; the message is identical.
        switch (result.errorCode) {
          case 'name_collision':
            setError(`A field named "${trimmedName}" already exists on this table.`)
            return
          case 'forbidden':
            setError("You don't have permission to add fields to this table.")
            return
          case 'not_authenticated':
            setError("You're signed out. Please refresh and sign in again.")
            return
          case 'table_not_found':
            setError('Parent table not found. Refresh the page.')
            return
          case 'name_required':
            setError('Field name is required.')
            return
          case 'invalid_data_type':
            setError('Data type is invalid.')
            return
          case 'maintenance_mode':
            // createField doesn't currently emit maintenance_mode (only
            // deleteField does), but the union includes it — handle
            // defensively rather than fall through to db_error.
            setError('Field creation is paused for scheduled maintenance.')
            return
          case 'field_not_found':
          case 'db_error':
          default:
            setError(result.error || 'Save failed')
            return
        }
      }
      onAdded(result.data)
      onClose()
    } finally {
      setSaving(false)
      savingRef.current = false
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget && !saving) onClose()
      }}
    >
      <div className="bg-white rounded-xl shadow-xl w-full max-w-md p-6">
        <div className="flex items-center gap-2 mb-4">
          <Plus className="w-4 h-4 text-gray-500" aria-hidden />
          <h3 className="text-base font-semibold text-gray-900">
            Add field to <span className="text-gray-700">{tableName}</span>
          </h3>
        </div>

        <div className="space-y-4">
          {/* Field Name */}
          <div>
            <label className="block text-xs font-medium text-gray-700 mb-1" htmlFor="add-field-name">
              Field Name
            </label>
            <input
              id="add-field-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              disabled={saving}
              autoFocus
              className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 disabled:bg-gray-50 disabled:text-gray-500"
            />
            {isDuplicate && (
              <p className="mt-1 text-xs text-red-600">
                A field named &ldquo;{trimmedName}&rdquo; already exists on this table.
              </p>
            )}
          </div>

          {/* Data Type — Select + custom input pair (mirrors FieldEditModal) */}
          <div>
            <label className="block text-xs font-medium text-gray-700 mb-1">Data Type</label>
            <div className="flex gap-2">
              <Select
                value={COMMON_TYPES.includes(dataType) ? dataType : '__custom'}
                onValueChange={(val) => {
                  if (val !== '__custom') setDataType(val)
                }}
                disabled={saving}
              >
                <SelectTrigger className="flex-1 h-9 text-sm">
                  <SelectValue placeholder="Select type…" />
                </SelectTrigger>
                <SelectContent>
                  {COMMON_TYPES.map((t) => (
                    <SelectItem key={t} value={t}>
                      {t}
                    </SelectItem>
                  ))}
                  {!COMMON_TYPES.includes(dataType) && (
                    <SelectItem value="__custom">{dataType}</SelectItem>
                  )}
                </SelectContent>
              </Select>
              <input
                value={dataType}
                onChange={(e) => setDataType(e.target.value)}
                placeholder="Custom type"
                disabled={saving}
                className="flex-1 border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 disabled:bg-gray-50 disabled:text-gray-500"
              />
            </div>
          </div>

          {/* Nullable / PK / FK — mutual exclusion mirrors FieldEditModal:159-195 */}
          <div className="flex gap-6">
            <label className="flex items-center gap-2 text-sm text-gray-700 cursor-pointer">
              <input
                type="checkbox"
                checked={isNullable}
                onChange={(e) => setIsNullable(e.target.checked)}
                disabled={saving}
                className="w-4 h-4 rounded border-gray-300 text-blue-600 focus:ring-blue-500"
              />
              Nullable
            </label>
            <label className="flex items-center gap-2 text-sm text-gray-700 cursor-pointer">
              <input
                type="checkbox"
                checked={isPK}
                onChange={(e) => {
                  const next = e.target.checked
                  setIsPK(next)
                  if (next) {
                    setIsFK(false)
                    setFkRef('')
                  }
                }}
                disabled={saving}
                className="w-4 h-4 rounded border-gray-300 text-blue-600 focus:ring-blue-500"
              />
              Primary Key
            </label>
            <label className="flex items-center gap-2 text-sm text-gray-700 cursor-pointer">
              <input
                type="checkbox"
                checked={isFK}
                onChange={(e) => {
                  const next = e.target.checked
                  setIsFK(next)
                  if (next) {
                    setIsPK(false)
                  } else {
                    setFkRef('')
                  }
                }}
                disabled={saving}
                className="w-4 h-4 rounded border-gray-300 text-blue-600 focus:ring-blue-500"
              />
              Foreign Key
            </label>
          </div>

          {/* FK reference — only when FK; identical structure to FieldEditModal */}
          {isFK && (
            <div>
              <label className="block text-xs font-medium text-gray-700 mb-1">References</label>
              <div className="flex gap-2">
                <Select
                  value={fkOptions.includes(fkRef) ? fkRef : '__custom'}
                  onValueChange={(val) => {
                    if (val !== '__custom') setFkRef(val)
                  }}
                  disabled={saving}
                >
                  <SelectTrigger className="flex-1 h-9 text-sm">
                    <SelectValue
                      placeholder={
                        fkOptions.length > 0 ? 'Select target…' : 'No PKs in this dataset'
                      }
                    />
                  </SelectTrigger>
                  <SelectContent>
                    {fkOptions.map((opt) => (
                      <SelectItem key={opt} value={opt}>
                        {opt}
                      </SelectItem>
                    ))}
                    {fkRef && !fkOptions.includes(fkRef) && (
                      <SelectItem value="__custom">{fkRef}</SelectItem>
                    )}
                  </SelectContent>
                </Select>
                <input
                  value={fkRef}
                  onChange={(e) => setFkRef(e.target.value)}
                  placeholder="TableName.field_name"
                  disabled={saving}
                  className="flex-1 border border-gray-300 rounded-lg px-3 py-2 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-blue-500 disabled:bg-gray-50 disabled:text-gray-500"
                />
              </div>
              {!fkRef.trim() && (
                <p className="mt-1.5 text-[11px] text-amber-600">
                  Specify the referenced table and field for validation to work.
                </p>
              )}
            </div>
          )}
        </div>

        {error && (
          <p role="alert" className="mt-3 text-xs text-red-600">
            {error}
          </p>
        )}

        <div className="mt-6 flex justify-end gap-3">
          <button
            onClick={onClose}
            disabled={saving}
            className="px-4 py-2 text-sm text-gray-700 border border-gray-300 rounded-lg hover:bg-gray-50 disabled:opacity-50"
          >
            Cancel
          </button>
          <RoleTooltip allowed={canEdit} tooltipKey="editor">
            <button
              onClick={handleSave}
              disabled={!canSubmit}
              className="px-4 py-2 text-sm text-white bg-primary rounded-lg hover:bg-primary/90 disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {saving ? 'Adding…' : 'Add'}
            </button>
          </RoleTooltip>
        </div>
      </div>
    </div>
  )
}
