'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { ChevronDown, ChevronRight, Upload, Check, Pencil } from '@/components/icons'
import { updateField } from '@/lib/actions/fields'
import type { DatasetSchemaData, FieldData } from '@/lib/actions/data-overview'

interface SchemaOverviewProps {
  projectId: string
  source: DatasetSchemaData[]
  target: DatasetSchemaData[]
}

type SelectedTables = Set<string>

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

// ─── Field Edit Modal ─────────────────────────────────────────────────────────

function FieldEditModal({
  field,
  onClose,
  onSave,
}: {
  field: FieldData
  onClose: () => void
  onSave: (updated: FieldData) => void
}) {
  const [name, setName] = useState(field.name)
  const [dataType, setDataType] = useState(field.data_type)
  const [isNullable, setIsNullable] = useState(field.is_nullable)
  const [isPK, setIsPK] = useState(field.is_primary_key)
  const [isFK, setIsFK] = useState(field.is_foreign_key)
  const [saving, startSaving] = useTransition()
  const [error, setError] = useState<string | null>(null)

  function handleSave() {
    setError(null)
    startSaving(async () => {
      try {
        await updateField(field.id, {
          name,
          data_type: dataType,
          is_nullable: isNullable,
          is_primary_key: isPK,
          is_foreign_key: isFK,
        })
        onSave({ ...field, name, data_type: dataType, is_nullable: isNullable, is_primary_key: isPK, is_foreign_key: isFK })
        onClose()
      } catch (e) {
        setError(e instanceof Error ? e.message : 'Save failed')
      }
    })
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
      <div className="bg-white rounded-xl shadow-xl w-full max-w-md p-6">
        <h3 className="text-base font-semibold text-gray-900 mb-4">Edit Field</h3>

        <div className="space-y-4">
          <div>
            <label className="block text-xs font-medium text-gray-700 mb-1">Field Name</label>
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500"
            />
          </div>

          <div>
            <label className="block text-xs font-medium text-gray-700 mb-1">Data Type</label>
            <div className="flex gap-2">
              <select
                value={COMMON_TYPES.includes(dataType) ? dataType : '__custom'}
                onChange={(e) => {
                  if (e.target.value !== '__custom') setDataType(e.target.value)
                }}
                className="flex-1 border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500"
              >
                {COMMON_TYPES.map((t) => (
                  <option key={t} value={t}>{t}</option>
                ))}
                {!COMMON_TYPES.includes(dataType) && (
                  <option value="__custom">{dataType}</option>
                )}
              </select>
              <input
                value={dataType}
                onChange={(e) => setDataType(e.target.value)}
                placeholder="Custom type"
                className="flex-1 border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500"
              />
            </div>
          </div>

          <div className="flex gap-6">
            <label className="flex items-center gap-2 text-sm text-gray-700 cursor-pointer">
              <input
                type="checkbox"
                checked={isNullable}
                onChange={(e) => setIsNullable(e.target.checked)}
                className="w-4 h-4 rounded border-gray-300 text-indigo-600 focus:ring-indigo-500"
              />
              Nullable
            </label>
            <label className="flex items-center gap-2 text-sm text-gray-700 cursor-pointer">
              <input
                type="checkbox"
                checked={isPK}
                onChange={(e) => {
                  setIsPK(e.target.checked)
                  if (e.target.checked) setIsFK(false)
                }}
                className="w-4 h-4 rounded border-gray-300 text-indigo-600 focus:ring-indigo-500"
              />
              Primary Key
            </label>
            <label className="flex items-center gap-2 text-sm text-gray-700 cursor-pointer">
              <input
                type="checkbox"
                checked={isFK}
                onChange={(e) => {
                  setIsFK(e.target.checked)
                  if (e.target.checked) setIsPK(false)
                }}
                className="w-4 h-4 rounded border-gray-300 text-indigo-600 focus:ring-indigo-500"
              />
              Foreign Key
            </label>
          </div>
        </div>

        {error && <p className="mt-3 text-xs text-red-600">{error}</p>}

        <div className="mt-6 flex justify-end gap-3">
          <button
            onClick={onClose}
            className="px-4 py-2 text-sm text-gray-700 border border-gray-300 rounded-lg hover:bg-gray-50"
          >
            Cancel
          </button>
          <button
            onClick={handleSave}
            disabled={saving || !name.trim()}
            className="px-4 py-2 text-sm text-white bg-indigo-600 rounded-lg hover:bg-indigo-700 disabled:opacity-50"
          >
            {saving ? 'Saving…' : 'Save'}
          </button>
        </div>
      </div>
    </div>
  )
}

// ─── Schema Panel ─────────────────────────────────────────────────────────────

function SchemaPanel({
  title,
  datasets,
  selectedTables,
  onToggleTable,
  onSelectAll,
  onDeselectAll,
  projectId,
}: {
  title: string
  datasets: DatasetSchemaData[]
  selectedTables: SelectedTables
  onToggleTable: (id: string) => void
  onSelectAll: (ids: string[]) => void
  onDeselectAll: (ids: string[]) => void
  projectId: string
}) {
  const allTableIds = datasets.flatMap((ds) => ds.tables.map((t) => t.id))
  const totalTables = allTableIds.length
  const selectedCount = allTableIds.filter((id) => selectedTables.has(id)).length

  // Expanded state per table
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  // Per-field local overrides (optimistic updates from edits)
  const [fieldOverrides, setFieldOverrides] = useState<Map<string, FieldData>>(new Map())
  const [editingField, setEditingField] = useState<FieldData | null>(null)

  function toggle(tableId: string) {
    setExpanded((prev) => {
      const next = new Set(prev)
      next.has(tableId) ? next.delete(tableId) : next.add(tableId)
      return next
    })
  }

  function handleFieldSaved(updated: FieldData) {
    setFieldOverrides((prev) => new Map(prev).set(updated.id, updated))
  }

  return (
    <div className="flex-1 min-w-0 border border-gray-200 rounded-xl bg-white overflow-hidden">
      {/* Panel header */}
      <div className="px-5 py-4 border-b border-gray-100 flex items-center justify-between">
        <div>
          <h2 className="text-sm font-semibold text-gray-900">{title}</h2>
          <p className="text-xs text-gray-500 mt-0.5">{selectedCount} of {totalTables} tables selected</p>
        </div>
        <div className="flex items-center gap-3">
          <button
            onClick={() => onSelectAll(allTableIds)}
            className="text-xs text-indigo-600 hover:text-indigo-800 font-medium"
          >
            Select All
          </button>
          <span className="text-gray-300">|</span>
          <button
            onClick={() => onDeselectAll(allTableIds)}
            className="text-xs text-indigo-600 hover:text-indigo-800 font-medium"
          >
            Deselect All
          </button>
          <a
            href={`/app/projects/${projectId}`}
            className="ml-2 flex items-center gap-1.5 text-xs text-gray-600 border border-gray-300 rounded-lg px-2.5 py-1.5 hover:bg-gray-50"
          >
            <Upload className="w-3.5 h-3.5" />
            Upload
          </a>
        </div>
      </div>

      {/* Tables grouped by dataset */}
      <div className="overflow-y-auto max-h-[60vh]">
        {totalTables === 0 ? (
          <div className="px-5 py-10 text-center">
            <p className="text-sm text-gray-500">No schemas uploaded yet.</p>
            <a href={`/app/projects/${projectId}`} className="text-xs text-indigo-600 hover:underline mt-1 inline-block">
              Go to Control Plane to upload CSV files
            </a>
          </div>
        ) : (
          datasets.map((ds) => (
            <div key={ds.id}>
              {/* Dataset label */}
              <div className="px-5 py-2 bg-gray-50 border-b border-gray-100">
                <span className="text-xs font-semibold text-gray-500 uppercase tracking-wider">{ds.name}</span>
              </div>

              {ds.tables.map((table) => {
                const isExpanded = expanded.has(table.id)
                const isSelected = selectedTables.has(table.id)
                return (
                  <div key={table.id} className="border-b border-gray-100 last:border-b-0">
                    {/* Table row */}
                    <div className="flex items-center gap-3 px-5 py-3 hover:bg-gray-50">
                      <input
                        type="checkbox"
                        checked={isSelected}
                        onChange={() => onToggleTable(table.id)}
                        className="w-4 h-4 rounded border-gray-300 text-indigo-600 focus:ring-indigo-500 cursor-pointer"
                      />
                      <button
                        onClick={() => toggle(table.id)}
                        className="flex items-center gap-2 flex-1 text-left"
                      >
                        {isExpanded ? (
                          <ChevronDown className="w-4 h-4 text-gray-400 flex-shrink-0" />
                        ) : (
                          <ChevronRight className="w-4 h-4 text-gray-400 flex-shrink-0" />
                        )}
                        <span className="text-sm font-medium text-gray-900">{table.name}</span>
                        <span className="ml-auto text-xs text-gray-500">{table.fields.length} fields</span>
                      </button>
                    </div>

                    {/* Expanded fields */}
                    {isExpanded && (
                      <div className="border-t border-gray-100 bg-gray-50/50">
                        <table className="w-full text-xs">
                          <thead>
                            <tr className="border-b border-gray-100">
                              <th className="text-left px-8 py-2 text-gray-500 font-medium">Field</th>
                              <th className="text-left px-3 py-2 text-gray-500 font-medium">Type</th>
                              <th className="text-center px-3 py-2 text-gray-500 font-medium">Nullable</th>
                              <th className="text-center px-3 py-2 text-gray-500 font-medium">Key</th>
                              <th className="w-6" />
                            </tr>
                          </thead>
                          <tbody>
                            {table.fields.map((rawField) => {
                              const f = fieldOverrides.get(rawField.id) ?? rawField
                              return (
                                <tr key={f.id} className="border-b border-gray-100 last:border-b-0 hover:bg-white group">
                                  <td className="px-8 py-2 text-gray-900 font-medium">{f.name}</td>
                                  <td className="px-3 py-2 text-gray-600 font-mono">{f.data_type}</td>
                                  <td className="px-3 py-2 text-center">
                                    {f.is_nullable ? (
                                      <Check className="w-3.5 h-3.5 text-gray-500 inline" />
                                    ) : (
                                      <span className="text-gray-300">—</span>
                                    )}
                                  </td>
                                  <td className="px-3 py-2 text-center">
                                    {f.is_primary_key ? (
                                      <span className="text-xs font-semibold text-indigo-600">PK</span>
                                    ) : f.is_foreign_key ? (
                                      <span className="text-xs font-semibold text-amber-600">FK</span>
                                    ) : (
                                      <span className="text-gray-300">—</span>
                                    )}
                                  </td>
                                  <td className="pr-3">
                                    <button
                                      onClick={() => setEditingField(f)}
                                      className="opacity-0 group-hover:opacity-100 transition-opacity p-1 rounded hover:bg-gray-200"
                                      title="Edit field"
                                    >
                                      <Pencil className="w-3 h-3 text-gray-400" />
                                    </button>
                                  </td>
                                </tr>
                              )
                            })}
                          </tbody>
                        </table>
                      </div>
                    )}
                  </div>
                )
              })}
            </div>
          ))
        )}
      </div>

      {editingField && (
        <FieldEditModal
          field={editingField}
          onClose={() => setEditingField(null)}
          onSave={(updated) => {
            handleFieldSaved(updated)
            setEditingField(null)
          }}
        />
      )}
    </div>
  )
}

// ─── Main component ───────────────────────────────────────────────────────────

export default function SchemaOverview({ projectId, source, target }: SchemaOverviewProps) {
  const router = useRouter()
  const [selectedTables, setSelectedTables] = useState<SelectedTables>(new Set())
  const [navigating, startNav] = useTransition()

  function toggleTable(id: string) {
    setSelectedTables((prev) => {
      const next = new Set(prev)
      next.has(id) ? next.delete(id) : next.add(id)
      return next
    })
  }

  function selectAll(ids: string[]) {
    setSelectedTables((prev) => {
      const next = new Set(prev)
      ids.forEach((id) => next.add(id))
      return next
    })
  }

  function deselectAll(ids: string[]) {
    setSelectedTables((prev) => {
      const next = new Set(prev)
      ids.forEach((id) => next.delete(id))
      return next
    })
  }

  const sourceTableIds = source.flatMap((ds) => ds.tables.map((t) => t.id))
  const targetTableIds = target.flatMap((ds) => ds.tables.map((t) => t.id))
  const hasSourceSelected = sourceTableIds.some((id) => selectedTables.has(id))
  const hasTargetSelected = targetTableIds.some((id) => selectedTables.has(id))
  const canGenerate = hasSourceSelected && hasTargetSelected

  function handleGenerateMappings() {
    startNav(() => {
      router.push(`/app/projects/${projectId}/mapping`)
    })
  }

  return (
    <div className="flex flex-col gap-4 flex-1">
      <div className="flex gap-4">
        <SchemaPanel
          title="Source Schema"
          datasets={source}
          selectedTables={selectedTables}
          onToggleTable={toggleTable}
          onSelectAll={selectAll}
          onDeselectAll={deselectAll}
          projectId={projectId}
        />
        <SchemaPanel
          title="Target Schema"
          datasets={target}
          selectedTables={selectedTables}
          onToggleTable={toggleTable}
          onSelectAll={selectAll}
          onDeselectAll={deselectAll}
          projectId={projectId}
        />
      </div>

      <div className="flex justify-end">
        <button
          onClick={handleGenerateMappings}
          disabled={!canGenerate || navigating}
          title={!canGenerate ? 'Select at least one source and one target table' : undefined}
          className="px-5 py-2.5 text-sm font-medium text-white bg-indigo-600 rounded-lg hover:bg-indigo-700 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
        >
          {navigating ? 'Going to Mapping…' : 'Generate Mappings'}
        </button>
      </div>
    </div>
  )
}
