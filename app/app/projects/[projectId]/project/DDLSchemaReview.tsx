'use client'

import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import type { ParsedTable, ParsedField } from '@/lib/parsers/ddl-parser'

interface DDLSchemaReviewProps {
  tables: ParsedTable[]
  usedAI: boolean
  onConfirm: (tables: ParsedTable[]) => void
  onCancel: () => void
  saving: boolean
}

export function DDLSchemaReview({
  tables: initialTables,
  usedAI,
  onConfirm,
  onCancel,
  saving,
}: DDLSchemaReviewProps) {
  const [tables, setTables] = useState<ParsedTable[]>(
    initialTables.map((t) => ({ ...t, fields: t.fields.map((f) => ({ ...f })) }))
  )

  // ── Table-level mutations ──────────────────────────────────────────────────

  const updateTableName = (tIdx: number, name: string) =>
    setTables((prev) =>
      prev.map((t, i) => (i === tIdx ? { ...t, name } : t))
    )

  const removeTable = (tIdx: number) =>
    setTables((prev) => prev.filter((_, i) => i !== tIdx))

  const addField = (tIdx: number) =>
    setTables((prev) =>
      prev.map((t, i) =>
        i === tIdx
          ? {
              ...t,
              fields: [
                ...t.fields,
                {
                  name: '',
                  dataType: 'VARCHAR(255)',
                  isNullable: true,
                  isPrimaryKey: false,
                  isForeignKey: false,
                  fkReference: null,
                  defaultValue: null,
                  checkConstraint: null,
                },
              ],
            }
          : t
      )
    )

  // ── Field-level mutations ──────────────────────────────────────────────────

  const updateField = (
    tIdx: number,
    fIdx: number,
    patch: Partial<ParsedField>
  ) =>
    setTables((prev) =>
      prev.map((t, i) =>
        i === tIdx
          ? {
              ...t,
              fields: t.fields.map((f, j) =>
                j === fIdx ? { ...f, ...patch } : f
              ),
            }
          : t
      )
    )

  const removeField = (tIdx: number, fIdx: number) =>
    setTables((prev) =>
      prev.map((t, i) =>
        i === tIdx ? { ...t, fields: t.fields.filter((_, j) => j !== fIdx) } : t
      )
    )

  const totalFields = tables.reduce((s, t) => s + t.fields.length, 0)

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="text-sm font-semibold text-gray-800">
            Schema Preview — {tables.length} table{tables.length !== 1 ? 's' : ''},{' '}
            {totalFields} field{totalFields !== 1 ? 's' : ''}
          </p>
          {usedAI && (
            <p className="text-xs text-violet-700 bg-violet-50 border border-violet-200 rounded px-2 py-1 mt-1 inline-block">
              Parsed with AI assist — verify the field types before confirming
            </p>
          )}
        </div>
        <Button
          variant="outline"
          size="sm"
          onClick={onCancel}
          disabled={saving}
          className="shrink-0"
        >
          Cancel
        </Button>
      </div>

      {/* Table cards */}
      <div className="space-y-4 max-h-[480px] overflow-y-auto pr-1">
        {tables.map((table, tIdx) => (
          <div
            key={tIdx}
            className="border border-gray-200 rounded-xl overflow-hidden"
          >
            {/* Table header */}
            <div className="flex items-center gap-2 px-3 py-2 bg-gray-50 border-b border-gray-200">
              <span className="text-xs text-gray-500 font-medium uppercase tracking-wide">
                Table
              </span>
              <Input
                value={table.name}
                onChange={(e) => updateTableName(tIdx, e.target.value)}
                className="h-7 text-sm font-mono font-semibold max-w-[220px]"
              />
              <button
                onClick={() => removeTable(tIdx)}
                className="ml-auto text-xs text-red-500 hover:text-red-700 hover:underline"
              >
                Remove table
              </button>
            </div>

            {/* Field list */}
            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead>
                  <tr className="bg-gray-50 border-b border-gray-100">
                    <th className="text-left px-3 py-1.5 text-gray-500 font-medium w-[30%]">
                      Name
                    </th>
                    <th className="text-left px-3 py-1.5 text-gray-500 font-medium w-[28%]">
                      Type
                    </th>
                    <th className="text-center px-2 py-1.5 text-gray-500 font-medium w-[12%]">
                      Null?
                    </th>
                    <th className="text-center px-2 py-1.5 text-gray-500 font-medium w-[12%]">
                      PK
                    </th>
                    <th className="text-center px-2 py-1.5 text-gray-500 font-medium w-[12%]">
                      FK
                    </th>
                    <th className="px-2 py-1.5 w-[6%]" />
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100">
                  {table.fields.map((field, fIdx) => (
                    <tr key={fIdx} className="hover:bg-gray-50/50">
                      <td className="px-3 py-1">
                        <Input
                          value={field.name}
                          onChange={(e) =>
                            updateField(tIdx, fIdx, { name: e.target.value })
                          }
                          className="h-6 text-xs font-mono"
                        />
                      </td>
                      <td className="px-3 py-1">
                        <Input
                          value={field.dataType}
                          onChange={(e) =>
                            updateField(tIdx, fIdx, {
                              dataType: e.target.value.toUpperCase(),
                            })
                          }
                          className="h-6 text-xs font-mono"
                        />
                      </td>
                      <td className="px-2 py-1 text-center">
                        <input
                          type="checkbox"
                          checked={field.isNullable}
                          onChange={(e) =>
                            updateField(tIdx, fIdx, {
                              isNullable: e.target.checked,
                            })
                          }
                          className="accent-blue-600"
                        />
                      </td>
                      <td className="px-2 py-1 text-center">
                        <input
                          type="checkbox"
                          checked={field.isPrimaryKey}
                          onChange={(e) =>
                            updateField(tIdx, fIdx, {
                              isPrimaryKey: e.target.checked,
                              isNullable: e.target.checked
                                ? false
                                : field.isNullable,
                            })
                          }
                          className="accent-blue-600"
                        />
                      </td>
                      <td className="px-2 py-1 text-center">
                        <input
                          type="checkbox"
                          checked={field.isForeignKey}
                          onChange={(e) =>
                            updateField(tIdx, fIdx, {
                              isForeignKey: e.target.checked,
                            })
                          }
                          className="accent-blue-600"
                        />
                      </td>
                      <td className="px-2 py-1 text-center">
                        <button
                          onClick={() => removeField(tIdx, fIdx)}
                          className="text-gray-400 hover:text-red-500 text-base leading-none"
                          title="Remove field"
                        >
                          ×
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            {/* Add field */}
            <div className="px-3 py-2 border-t border-gray-100">
              <button
                onClick={() => addField(tIdx)}
                className="text-xs text-blue-600 hover:text-blue-800 hover:underline"
              >
                + Add field
              </button>
            </div>
          </div>
        ))}
      </div>

      {/* Confirm / Cancel */}
      <div className="flex items-center gap-3 pt-1">
        <Button
          onClick={() => onConfirm(tables)}
          disabled={saving || tables.length === 0}
          className="bg-blue-600 hover:bg-blue-700 text-white"
        >
          {saving ? (
            <span className="flex items-center gap-2">
              <span className="w-3.5 h-3.5 border-2 border-white/30 border-t-white rounded-full animate-spin" />
              Saving schema…
            </span>
          ) : (
            `Confirm Schema (${tables.length} table${tables.length !== 1 ? 's' : ''})`
          )}
        </Button>
        <Button variant="outline" onClick={onCancel} disabled={saving}>
          Cancel
        </Button>
      </div>
    </div>
  )
}
