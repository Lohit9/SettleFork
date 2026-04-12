'use client'

import { useState, useTransition } from 'react'
import { ChevronDown, ChevronRight, Upload, Check, Pencil } from '@/components/icons'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { updateField } from '@/lib/actions/fields'
import { useProjectRole } from '@/lib/hooks/useProjectRole'
import { enrichSchemaFromDocs } from '@/lib/actions/schema-enrichment'
import type { DatasetSchemaData, FieldData, CheckConstraint } from '@/lib/actions/data-overview'

interface SchemaOverviewProps {
  projectId: string
  source: DatasetSchemaData[]
  target: DatasetSchemaData[]
}

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
        const result = await updateField(field.id, {
          name,
          data_type: dataType,
          is_nullable: isNullable,
          is_primary_key: isPK,
          is_foreign_key: isFK,
        })
        if (!result.success) {
          setError(result.error || 'Save failed')
          return
        }
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
              className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
          </div>

          <div>
            <label className="block text-xs font-medium text-gray-700 mb-1">Data Type</label>
            <div className="flex gap-2">
              <Select
                value={COMMON_TYPES.includes(dataType) ? dataType : '__custom'}
                onValueChange={(val) => {
                  if (val !== '__custom') setDataType(val)
                }}
              >
                <SelectTrigger className="flex-1 h-9 text-sm">
                  <SelectValue placeholder="Select type…" />
                </SelectTrigger>
                <SelectContent>
                  {COMMON_TYPES.map((t) => (
                    <SelectItem key={t} value={t}>{t}</SelectItem>
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
                className="flex-1 border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
              />
            </div>
          </div>

          <div className="flex gap-6">
            <label className="flex items-center gap-2 text-sm text-gray-700 cursor-pointer">
              <input
                type="checkbox"
                checked={isNullable}
                onChange={(e) => setIsNullable(e.target.checked)}
                className="w-4 h-4 rounded border-gray-300 text-blue-600 focus:ring-blue-500"
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
                className="w-4 h-4 rounded border-gray-300 text-blue-600 focus:ring-blue-500"
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
                className="w-4 h-4 rounded border-gray-300 text-blue-600 focus:ring-blue-500"
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
            className="px-4 py-2 text-sm text-white bg-primary rounded-lg hover:bg-primary/90 disabled:opacity-50"
          >
            {saving ? 'Saving…' : 'Save'}
          </button>
        </div>
      </div>
    </div>
  )
}

// ─── Constraint Badge ─────────────────────────────────────────────────────────

function ConstraintBadge({ constraint }: { constraint: CheckConstraint | null }) {
  const [expanded, setExpanded] = useState(false)

  if (!constraint) return <span className="text-gray-300">—</span>

  switch (constraint.type) {
    case 'in_list': {
      const values = constraint.allowedValues ?? []
      const PREVIEW = 6
      const hidden = values.length - PREVIEW
      const visible = expanded ? values : values.slice(0, PREVIEW)
      return (
        <div className="flex flex-wrap gap-1 items-center">
          {visible.map((val: string) => (
            <span
              key={val}
              className="inline-block px-1.5 py-0.5 bg-blue-50 text-blue-700 rounded text-[10px] font-mono"
            >
              {val}
            </span>
          ))}
          {!expanded && hidden > 0 && (
            <button
              onClick={() => setExpanded(true)}
              className="text-[10px] text-blue-500 hover:text-blue-700 hover:underline"
            >
              +{hidden} more
            </button>
          )}
          {expanded && hidden > 0 && (
            <button
              onClick={() => setExpanded(false)}
              className="text-[10px] text-gray-400 hover:text-gray-600 hover:underline"
            >
              show less
            </button>
          )}
        </div>
      )
    }

    case 'regex':
      return (
        <span
          className="inline-block px-1.5 py-0.5 bg-purple-50 text-purple-700 rounded text-[10px] font-mono"
          title={`Regex: ${constraint.pattern}`}
        >
          /{constraint.pattern}/
        </span>
      )

    case 'range': {
      const parts: string[] = []
      if (constraint.min !== undefined) parts.push(`≥ ${constraint.min}`)
      if (constraint.max !== undefined) parts.push(`≤ ${constraint.max}`)
      return (
        <span className="inline-block px-1.5 py-0.5 bg-amber-50 text-amber-700 rounded text-[10px]">
          {parts.join(', ')}
        </span>
      )
    }

    case 'custom':
      return (
        <span
          className="inline-block px-1.5 py-0.5 bg-gray-100 text-gray-600 rounded text-[10px]"
          title={constraint.raw}
        >
          CHECK
        </span>
      )

    default:
      return <span className="text-gray-300">—</span>
  }
}

// ─── Schema Panel ─────────────────────────────────────────────────────────────

// ── Schema source badge ───────────────────────────────────────────────────────

function SchemaSourceBadge({ source }: { source: FieldData['schema_source'] }) {
  if (source === 'doc_enriched') {
    return (
      <span
        title="Schema verified against uploaded documentation"
        className="inline-flex items-center gap-0.5 px-1 py-0.5 rounded text-[10px] font-medium bg-emerald-50 text-emerald-700 border border-emerald-200"
      >
        <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" className="inline">
          <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
          <polyline points="14 2 14 8 20 8" />
          <line x1="16" y1="13" x2="8" y2="13" />
          <line x1="16" y1="17" x2="8" y2="17" />
          <polyline points="10 9 9 9 8 9" />
        </svg>
        Verified
      </span>
    )
  }
  if (source === 'manual') {
    return (
      <span
        title="Manually edited"
        className="inline-flex items-center gap-0.5 px-1 py-0.5 rounded text-[10px] font-medium bg-violet-50 text-violet-700 border border-violet-200"
      >
        <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" className="inline">
          <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" />
          <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z" />
        </svg>
        Manual
      </span>
    )
  }
  return null
}

// ── Schema Panel ──────────────────────────────────────────────────────────────

function SchemaPanel({
  title,
  datasets,
  projectId,
}: {
  title: string
  datasets: DatasetSchemaData[]
  projectId: string
}) {
  const { can } = useProjectRole(projectId)
  const canEdit = can('edit')

  const totalTables = datasets.reduce((sum, ds) => sum + ds.tables.length, 0)

  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const [fieldOverrides, setFieldOverrides] = useState<Map<string, FieldData>>(new Map())
  const [editingField, setEditingField] = useState<FieldData | null>(null)

  // Per-table enrichment state
  const [enrichingTableId, setEnrichingTableId] = useState<string | null>(null)
  const [enrichToast, setEnrichToast] = useState<{ tableId: string; msg: string } | null>(null)

  function toggle(tableId: string) {
    setExpanded((prev) => {
      const next = new Set(prev)
      next.has(tableId) ? next.delete(tableId) : next.add(tableId)
      return next
    })
  }

  function handleFieldSaved(updated: FieldData) {
    setFieldOverrides((prev) => new Map(prev).set(updated.id, { ...updated, schema_source: 'manual' }))
  }

  async function handleReanalyze(datasetId: string, tableId: string) {
    setEnrichingTableId(tableId)
    setEnrichToast(null)
    try {
      const result = await enrichSchemaFromDocs(datasetId, tableId)
      if (!result.success) {
        setEnrichToast({ tableId, msg: result.error ?? 'Enrichment failed' })
      } else if (result.correctedFields === 0) {
        setEnrichToast({ tableId, msg: 'No corrections found — schema matches documentation.' })
      } else {
        setEnrichToast({ tableId, msg: `✓ ${result.correctedFields} field${result.correctedFields !== 1 ? 's' : ''} corrected from documentation. Refresh to see updates.` })
      }
    } catch {
      setEnrichToast({ tableId, msg: 'Re-analysis failed. Please try again.' })
    }
    setEnrichingTableId(null)
    setTimeout(() => setEnrichToast(null), 5000)
  }

  return (
    <div className="flex-1 min-w-0 border border-gray-200 rounded-xl bg-white overflow-hidden">
      {/* Panel header */}
      <div className="px-5 py-4 border-b border-gray-100 flex items-center justify-between bg-gray-50/50">
        <h2 className="text-sm font-semibold text-gray-900">{title}</h2>
        <a
          href={`/app/projects/${projectId}`}
          className="flex items-center gap-1.5 text-xs text-gray-600 border border-gray-300 rounded-lg px-2.5 py-1.5 hover:bg-gray-50"
        >
          <Upload className="w-3.5 h-3.5" />
          Upload
        </a>
      </div>

      {/* Tables grouped by dataset */}
      <div className="overflow-y-auto max-h-[60vh]">
        {totalTables === 0 ? (
          <div className="px-5 py-10 text-center">
            <p className="text-sm text-gray-500">No schemas uploaded yet.</p>
            <a href={`/app/projects/${projectId}`} className="text-xs text-blue-600 hover:underline mt-1 inline-block">
              Go to Project Setup to upload CSV files
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
                const isEnriching = enrichingTableId === table.id
                const toast = enrichToast?.tableId === table.id ? enrichToast.msg : null

                // Count enrichment coverage for this table
                const enrichedCount = table.fields.filter(
                  (f) => (fieldOverrides.get(f.id) ?? f).schema_source !== 'inferred'
                ).length

                return (
                  <div key={table.id} className="border-b border-gray-100 last:border-b-0">
                    {/* Table row */}
                    <div className="flex items-center gap-3 px-5 py-3 hover:bg-gray-50 transition-colors">
                      <button
                        onClick={() => toggle(table.id)}
                        className="flex items-center gap-2 flex-1 text-left min-w-0"
                      >
                        {isExpanded ? (
                          <ChevronDown className="w-4 h-4 text-gray-400 flex-shrink-0" />
                        ) : (
                          <ChevronRight className="w-4 h-4 text-gray-400 flex-shrink-0" />
                        )}
                        <span className="text-sm font-medium text-gray-900">{table.name}</span>
                        <span className="ml-auto text-xs text-gray-500 shrink-0">{table.fields.length} fields</span>
                      </button>
                    </div>

                    {/* Toast for this table */}
                    {toast && (
                      <div className={`mx-5 mb-2 px-3 py-2 rounded-lg text-xs border ${toast.startsWith('✓') ? 'bg-emerald-50 border-emerald-200 text-emerald-700' : 'bg-amber-50 border-amber-200 text-amber-700'}`}>
                        {toast}
                      </div>
                    )}

                    {/* Expanded fields */}
                    {isExpanded && (
                      <div className="border-t border-gray-100 bg-gray-50/50">
                        <table className="w-full text-xs">
                          <thead>
                            <tr className="border-b border-gray-100">
                              <th className="text-left px-8 py-2 text-gray-500 font-medium w-1/4">Field</th>
                              <th className="text-left px-3 py-2 text-gray-500 font-medium">Type</th>
                              <th className="text-center px-3 py-2 text-gray-500 font-medium">Nullable</th>
                              <th className="text-center px-3 py-2 text-gray-500 font-medium">Key</th>
                              <th className="text-left px-3 py-2 text-gray-500 font-medium">Constraints</th>
                              <th className="w-6" />
                            </tr>
                          </thead>
                          <tbody>
                            {table.fields.map((rawField) => {
                              const f = fieldOverrides.get(rawField.id) ?? rawField
                              return (
                                <tr key={f.id} className="border-b border-gray-100 last:border-b-0 hover:bg-white transition-colors group">
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
                                      <span className="text-xs font-semibold text-blue-600">PK</span>
                                    ) : f.is_foreign_key ? (
                                      <span className="text-xs font-semibold text-amber-600">FK</span>
                                    ) : (
                                      <span className="text-gray-300">—</span>
                                    )}
                                  </td>
                                  <td className="px-3 py-2">
                                    <ConstraintBadge constraint={f.check_constraint ?? null} />
                                  </td>
                                  <td className="pr-3">
                                    {canEdit && (
                                      <button
                                        onClick={() => setEditingField(f)}
                                        className="opacity-0 group-hover:opacity-100 transition-opacity p-1 rounded hover:bg-gray-200"
                                        title="Edit field"
                                      >
                                        <Pencil className="w-3 h-3 text-gray-400" />
                                      </button>
                                    )}
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
  return (
    <div className="flex gap-4 flex-1">
      <SchemaPanel
        title="Source Schema"
        datasets={source}
        projectId={projectId}
      />
      <SchemaPanel
        title="Target Schema"
        datasets={target}
        projectId={projectId}
      />
    </div>
  )
}
