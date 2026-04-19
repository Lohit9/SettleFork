'use client'

import { useState, useTransition } from 'react'
import { ChevronRight, Check, Pencil, Search } from '@/components/icons'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { updateField } from '@/lib/actions/fields'
import { useProjectRole } from '@/lib/hooks/useProjectRole'
import { enrichSchemaFromDocs } from '@/lib/actions/schema-enrichment'
import type { DatasetSchemaData, TableData, FieldData, CheckConstraint } from '@/lib/actions/data-overview'

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
  fkOptions,
  onClose,
  onSave,
}: {
  field: FieldData
  /** PK options for the dropdown, in canonical "TABLE.FIELD" form.
   *  Scoped to the editing field's own dataset, with its own table excluded. */
  fkOptions: string[]
  onClose: () => void
  onSave: (updated: FieldData) => void
}) {
  const [name, setName] = useState(field.name)
  const [dataType, setDataType] = useState(field.data_type)
  const [isNullable, setIsNullable] = useState(field.is_nullable)
  const [isPK, setIsPK] = useState(field.is_primary_key)
  const [isFK, setIsFK] = useState(field.is_foreign_key)
  const [fkRef, setFkRef] = useState(field.fk_reference ?? '')
  const [saving, startSaving] = useTransition()
  const [error, setError] = useState<string | null>(null)

  // Canonical server-side FK reference: empty string becomes null, trimmed
  // string otherwise, and always null when the FK flag is off. Mirrors the
  // PK↔FK mutual-exclusion enforced by the checkbox handlers below so that
  // "unchecking FK" and "checking PK" both clear the reference.
  const fkReferenceToPersist = isFK ? (fkRef.trim() || null) : null

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
          fk_reference: fkReferenceToPersist,
        })
        if (!result.success) {
          setError(result.error || 'Save failed')
          return
        }
        onSave({
          ...field,
          name,
          data_type: dataType,
          is_nullable: isNullable,
          is_primary_key: isPK,
          is_foreign_key: isFK,
          fk_reference: fkReferenceToPersist,
        })
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
                  const next = e.target.checked
                  setIsPK(next)
                  if (next) {
                    // PK ⇒ not FK. Clear the reference input too so a later
                    // save doesn't persist a stale FK target from before.
                    setIsFK(false)
                    setFkRef('')
                  }
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
                  const next = e.target.checked
                  setIsFK(next)
                  if (next) {
                    setIsPK(false)
                  } else {
                    // Per spec: unchecking FK clears the reference input.
                    setFkRef('')
                  }
                }}
                className="w-4 h-4 rounded border-gray-300 text-blue-600 focus:ring-blue-500"
              />
              Foreign Key
            </label>
          </div>

          {isFK && (
            <div>
              <label className="block text-xs font-medium text-gray-700 mb-1">
                References
              </label>
              <div className="flex gap-2">
                <Select
                  value={fkOptions.includes(fkRef) ? fkRef : '__custom'}
                  onValueChange={(val) => {
                    if (val !== '__custom') setFkRef(val)
                  }}
                >
                  <SelectTrigger className="flex-1 h-9 text-sm">
                    <SelectValue placeholder={fkOptions.length > 0 ? 'Select target…' : 'No PKs in this dataset'} />
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
                  className="flex-1 border border-gray-300 rounded-lg px-3 py-2 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-blue-500"
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

  const [search, setSearch] = useState('')

  // Search filter: drill dataset → table → field. A table-name match shows
  // the whole table; otherwise only fields whose names match are kept. Empty
  // tables and datasets are pruned so the UI doesn't render hollow sections.
  const searchLower = search.trim().toLowerCase()
  const isSearching = searchLower.length > 0

  const filteredDatasets: DatasetSchemaData[] = !isSearching
    ? datasets
    : datasets
        .map((ds) => {
          const filteredTables = ds.tables
            .map((table): TableData | null => {
              const tableNameMatch = table.name.toLowerCase().includes(searchLower)
              if (tableNameMatch) return table
              const matchingFields = table.fields.filter((f) =>
                f.name.toLowerCase().includes(searchLower)
              )
              if (matchingFields.length > 0) return { ...table, fields: matchingFields }
              return null
            })
            .filter((t): t is TableData => t !== null)
          return filteredTables.length > 0 ? { ...ds, tables: filteredTables } : null
        })
        .filter((ds): ds is DatasetSchemaData => ds !== null)

  const totalFilteredTables = filteredDatasets.reduce((sum, ds) => sum + ds.tables.length, 0)

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

  /**
   * Compute FK reference options for the field being edited. Scope matches
   * the cross-table inference engine (lib/quality/fk-inference.ts):
   *   - Same dataset as the editing field (panel holds either source or
   *     target datasets, never both, so we're already naturally scoped by
   *     role — we further narrow to the specific dataset the field lives in).
   *   - Excludes PKs in the field's OWN table (a column doesn't reference
   *     its own row).
   *   - Reflects the panel's unsaved overrides so a user who just flipped a
   *     field to PK in this session sees it as an option immediately.
   */
  function buildFkOptions(target: FieldData): string[] {
    const ownerDataset = datasets.find((ds) =>
      ds.tables.some((t) => t.fields.some((f) => f.id === target.id))
    )
    if (!ownerDataset) return []
    const ownerTable = ownerDataset.tables.find((t) =>
      t.fields.some((f) => f.id === target.id)
    )
    const options: string[] = []
    for (const t of ownerDataset.tables) {
      if (ownerTable && t.id === ownerTable.id) continue
      for (const rawField of t.fields) {
        const f = fieldOverrides.get(rawField.id) ?? rawField
        if (!f.is_primary_key) continue
        options.push(`${t.name}.${f.name}`)
      }
    }
    return options.sort((a, b) => a.localeCompare(b))
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
    <div className="flex-1 min-w-0 border border-gray-100 rounded-lg bg-white overflow-hidden">
      {/* Panel header — title + per-panel search */}
      <div className="px-4 py-2.5 border-b border-gray-100 flex items-center gap-3 bg-gray-50/50">
        <h2 className="text-sm font-semibold text-gray-900 flex-shrink-0">{title}</h2>
        <div className="relative w-36 flex-shrink-0 ml-auto">
          <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-gray-400 pointer-events-none" />
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search..."
            className="w-full h-7 pl-8 pr-3 text-xs bg-white border border-gray-200 rounded-md placeholder:text-gray-400 focus:outline-none focus:ring-2 focus:ring-primary/20 focus:border-primary/40 transition-colors"
          />
        </div>
      </div>

      {/* Tables grouped by dataset */}
      <div className="overflow-y-auto max-h-[60vh]">
        {totalTables === 0 ? (
          <div className="px-5 py-10 text-center">
            <p className="text-sm text-gray-500">No schemas uploaded yet.</p>
            <a href={`/app/projects/${projectId}`} className="text-xs text-blue-600 hover:underline mt-1 inline-block">
              Go to Project Setup to upload your data
            </a>
          </div>
        ) : totalFilteredTables === 0 ? (
          <div className="px-5 py-8 text-center">
            <p className="text-sm text-gray-500">No tables or fields matching &ldquo;{search}&rdquo;</p>
          </div>
        ) : (
          filteredDatasets.map((ds) => (
            <div key={ds.id}>
              {/* Dataset label */}
              <div className="px-5 py-2 bg-gray-50 border-b border-gray-100">
                <span className="text-xs font-medium text-gray-500">{ds.name}</span>
              </div>

              {ds.tables.map((table) => {
                const isExpanded = expanded.has(table.id) || isSearching
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
                        <ChevronRight
                          className={`w-4 h-4 text-settle-slate-400 flex-shrink-0 transition-transform ${
                            isExpanded ? 'rotate-90' : ''
                          }`}
                        />
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
                              <th className="text-left px-8 py-2 text-xs font-medium text-gray-500 w-1/4">Field</th>
                              <th className="text-left px-3 py-2 text-xs font-medium text-gray-500">Type</th>
                              <th className="text-center px-3 py-2 text-xs font-medium text-gray-500">Nullable</th>
                              <th className="text-center px-3 py-2 text-xs font-medium text-gray-500">Key</th>
                              <th className="text-left px-3 py-2 text-xs font-medium text-gray-500">Constraints</th>
                              <th className="w-6" />
                            </tr>
                          </thead>
                          <tbody>
                            {table.fields.map((rawField) => {
                              const f = fieldOverrides.get(rawField.id) ?? rawField
                              return (
                                <tr key={f.id} className="border-b border-gray-100 last:border-b-0 hover:bg-white transition-colors group">
                                  <td className="px-8 py-2 text-gray-900 font-medium font-mono">{f.name}</td>
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
          fkOptions={buildFkOptions(editingField)}
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
    <div className="flex gap-4 flex-1 min-h-0">
      <SchemaPanel title="Source System" datasets={source} projectId={projectId} />
      <SchemaPanel title="Target System" datasets={target} projectId={projectId} />
    </div>
  )
}
