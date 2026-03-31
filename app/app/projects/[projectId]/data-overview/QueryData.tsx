'use client'

import { useState, useEffect } from 'react'
import { Copy, ChevronDown, ChevronRight } from '@/components/icons'
import { executeNLQuery, executeSQLQuery, backfillFriendlyNames } from '@/lib/actions/query'
import type { QueryEngineResult } from '@/lib/actions/query'
import type { TableOption } from '@/lib/actions/data-overview'

interface QueryDataProps {
  projectId: string
  tables: TableOption[]
}

type QueryMode = 'nl' | 'sql'

export default function QueryData({ projectId, tables }: QueryDataProps) {
  const [mode, setMode] = useState<QueryMode>('nl')
  const [input, setInput] = useState('')
  const [loading, setLoading] = useState(false)
  const [result, setResult] = useState<QueryEngineResult | null>(null)
  const [resultsPage, setResultsPage] = useState(1)
  const [executedSQLExpanded, setExecutedSQLExpanded] = useState(false)
  const RESULTS_PAGE_SIZE = 10
  const [tablesExpanded, setTablesExpanded] = useState(true)
  const [copied, setCopied] = useState<'friendly' | 'executed' | null>(null)

  // Trigger backfill on mount for tables that predate this feature
  useEffect(() => {
    backfillFriendlyNames(projectId).catch(() => {})
  }, [projectId])

  function resetResult() {
    setResult(null)
  }

  function handleModeChange(m: QueryMode) {
    setMode(m)
    setInput('')
    resetResult()
  }

  async function handleExecute() {
    if (!input.trim()) return
    setLoading(true)
    setResult(null)

    try {
      const res =
        mode === 'nl'
          ? await executeNLQuery(projectId, input.trim())
          : await executeSQLQuery(projectId, input.trim())
      setResult(res)
      setResultsPage(1)
      setExecutedSQLExpanded(false)
    } catch (e) {
      setResult({
        success: false,
        columns: [],
        rows: [],
        rowCount: 0,
        friendlySQL: input,
        executedSQL: '',
        error: e instanceof Error ? e.message : 'Unexpected error',
      })
    } finally {
      setLoading(false)
    }
  }

  function copyText(text: string, key: 'friendly' | 'executed') {
    navigator.clipboard.writeText(text).then(() => {
      setCopied(key)
      setTimeout(() => setCopied(null), 2000)
    })
  }

  const hasResults = result?.success && result.rows.length > 0
  const hasFriendlySQL = result?.friendlySQL && result.friendlySQL !== input
  const hasExecutedSQL = !!result?.executedSQL

  // Group tables by dataset for the reference panel
  const datasetOrder: string[] = []
  const tablesByDataset = new Map<string, TableOption[]>()
  for (const t of tables) {
    if (!tablesByDataset.has(t.datasetName)) {
      tablesByDataset.set(t.datasetName, [])
      datasetOrder.push(t.datasetName)
    }
    tablesByDataset.get(t.datasetName)!.push(t)
  }

  const nlPlaceholder =
    tables.length > 0
      ? `e.g., Show me all rows where "Price" is above 500`
      : 'Upload CSV files first to enable querying'

  const sqlPlaceholder =
    tables.length > 0
      ? `SELECT * FROM ${tables[0].friendlyName} LIMIT 10`
      : 'Upload CSV files first to enable querying'

  return (
    <div className="flex flex-col gap-4">
      {/* Info banner */}
      <div className="bg-blue-50 border border-blue-100 rounded-xl px-5 py-3">
        <p className="text-sm text-blue-700">
          Use this to explore and understand data. This does not modify data.
        </p>
      </div>

      <div className="flex gap-4 items-start">
        {/* Main editor column */}
        <div className="flex-1 min-w-0 flex flex-col gap-4">
          {/* Query editor card */}
          <div className="bg-white border border-gray-200 rounded-xl overflow-hidden">
            {/* Header */}
            <div className="px-5 py-4 border-b border-gray-100 flex items-center justify-between">
              <span className="text-sm font-semibold text-gray-900">Query Editor</span>
              {/* Mode toggle */}
              <div className="flex rounded-lg border border-gray-200 overflow-hidden">
                <button
                  onClick={() => handleModeChange('nl')}
                  className={`px-3 py-1.5 text-xs font-medium transition-colors ${
                    mode === 'nl'
                      ? 'bg-blue-600 text-white'
                      : 'bg-white text-gray-600 hover:bg-gray-50'
                  }`}
                >
                  Natural Language
                </button>
                <button
                  onClick={() => handleModeChange('sql')}
                  className={`px-3 py-1.5 text-xs font-medium transition-colors border-l border-gray-200 ${
                    mode === 'sql'
                      ? 'bg-blue-600 text-white'
                      : 'bg-white text-gray-600 hover:bg-gray-50'
                  }`}
                >
                  SQL
                </button>
              </div>
            </div>

            {/* Input area */}
            <div className="px-5 py-4">
              {mode === 'nl' ? (
                <input
                  type="text"
                  value={input}
                  onChange={(e) => setInput(e.target.value)}
                  onKeyDown={(e) => e.key === 'Enter' && handleExecute()}
                  placeholder={nlPlaceholder}
                  disabled={tables.length === 0}
                  className="w-full border border-gray-300 rounded-lg px-4 py-3 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 placeholder-gray-400 disabled:bg-gray-50"
                />
              ) : (
                <textarea
                  value={input}
                  onChange={(e) => setInput(e.target.value)}
                  placeholder={sqlPlaceholder}
                  rows={6}
                  disabled={tables.length === 0}
                  className="w-full border border-gray-300 rounded-lg px-4 py-3 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-blue-500 placeholder-gray-400 resize-none disabled:bg-gray-50"
                />
              )}

              <button
                onClick={handleExecute}
                disabled={loading || !input.trim() || tables.length === 0}
                className="mt-3 px-4 py-2 text-sm font-medium text-white bg-blue-600 rounded-lg hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-2"
              >
                {loading ? (
                  <>
                    <span className="inline-block w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin" />
                    {mode === 'nl' ? 'Generating & Executing…' : 'Executing…'}
                  </>
                ) : mode === 'nl' ? (
                  'Generate & Execute Query'
                ) : (
                  'Execute Query'
                )}
              </button>
            </div>
          </div>

          {/* Error banners */}
          {result && !result.success && (
            <div className="bg-red-50 border border-red-200 rounded-xl px-5 py-4">
              <p className="text-sm font-medium text-red-700">{result.error}</p>
              {result.hint && result.hint !== result.error && result.hint !== result.rawError && (
                <p className="text-sm text-red-600 mt-1.5">{result.hint}</p>
              )}
              {result.friendlySQL && mode === 'nl' && (
                <p className="text-xs text-red-500 mt-2">
                  Generated SQL:{' '}
                  <code className="font-mono bg-red-100 px-1 py-0.5 rounded">{result.friendlySQL}</code>
                </p>
              )}
              {result.rawError && result.rawError !== result.error && (
                <details className="mt-3">
                  <summary className="text-xs text-red-400 cursor-pointer select-none hover:text-red-500 transition-colors">
                    Technical details
                  </summary>
                  <p className="text-xs text-red-400 mt-1.5 font-mono bg-red-100/60 px-3 py-2 rounded-lg break-all">
                    {result.rawError}
                  </p>
                </details>
              )}
            </div>
          )}

          {/* NL mode: show the generated SQL (friendly names — what Claude wrote) */}
          {result?.success && hasFriendlySQL && mode === 'nl' && (
            <div className="bg-white border border-gray-200 rounded-xl overflow-hidden">
              <div className="px-5 py-3 border-b border-gray-100 flex items-center justify-between">
                <span className="text-sm font-semibold text-gray-900">Your Query</span>
                <button
                  onClick={() => copyText(result.friendlySQL, 'friendly')}
                  className="flex items-center gap-1 text-xs text-gray-500 hover:text-gray-700 px-2 py-1 rounded border border-gray-200 hover:bg-gray-100"
                >
                  <Copy className="w-3.5 h-3.5" />
                  {copied === 'friendly' ? 'Copied!' : 'Copy'}
                </button>
              </div>
              <pre className="px-5 py-4 text-xs font-mono text-gray-800 bg-gray-50 overflow-x-auto whitespace-pre-wrap">
                {result.friendlySQL}
              </pre>
            </div>
          )}

          {/* Executed As (rewritten JSONB SQL) — collapsible */}
          {result?.success && hasExecutedSQL && (
            <div className="bg-white border border-gray-200 rounded-xl overflow-hidden">
              <button
                onClick={() => setExecutedSQLExpanded((v) => !v)}
                className="w-full px-5 py-3 border-b border-gray-100 flex items-center justify-between hover:bg-gray-50"
              >
                <span className="text-sm font-semibold text-gray-900">Executed As</span>
                <div className="flex items-center gap-2">
                  <button
                    onClick={(e) => {
                      e.stopPropagation()
                      copyText(result.executedSQL, 'executed')
                    }}
                    className="flex items-center gap-1 text-xs text-gray-500 hover:text-gray-700 px-2 py-1 rounded border border-gray-200 hover:bg-gray-100"
                  >
                    <Copy className="w-3.5 h-3.5" />
                    {copied === 'executed' ? 'Copied!' : 'Copy'}
                  </button>
                  {executedSQLExpanded ? (
                    <ChevronDown className="w-4 h-4 text-gray-400" />
                  ) : (
                    <ChevronRight className="w-4 h-4 text-gray-400" />
                  )}
                </div>
              </button>
              {executedSQLExpanded && (
                <pre className="px-5 py-4 text-xs font-mono text-gray-600 bg-gray-50 overflow-x-auto whitespace-pre-wrap">
                  {result.executedSQL}
                </pre>
              )}
            </div>
          )}

          {/* Results */}
          {hasResults && (() => {
            const totalRows = result!.rowCount
            const totalPages = Math.ceil(totalRows / RESULTS_PAGE_SIZE)
            const pageStart = (resultsPage - 1) * RESULTS_PAGE_SIZE
            const pageRows = result!.rows.slice(pageStart, pageStart + RESULTS_PAGE_SIZE)

            return (
              <div className="bg-white border border-gray-200 rounded-xl overflow-hidden">
                <div className="px-5 py-3 border-b border-gray-100 flex items-center justify-between">
                  <span className="text-sm font-semibold text-gray-900">Results</span>
                  <span className="text-xs text-gray-500">
                    {totalRows.toLocaleString()} result{totalRows !== 1 ? 's' : ''}
                    {totalRows === 1000 ? ' (limit 1,000)' : ''}
                  </span>
                </div>
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead className="bg-gray-50 border-b border-gray-100">
                      <tr>
                        {result!.columns.map((col) => (
                          <th
                            key={col}
                            className="text-left px-4 py-3 text-xs font-semibold text-gray-700 whitespace-nowrap"
                          >
                            {col}
                          </th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {pageRows.map((row, i) => (
                        <tr
                          key={pageStart + i}
                          className="border-b border-gray-100 last:border-b-0 hover:bg-gray-50 even:bg-gray-50/50"
                        >
                          {result!.columns.map((col) => (
                            <td
                              key={col}
                              className="px-4 py-2.5 text-xs text-gray-700 whitespace-nowrap max-w-[200px] truncate"
                            >
                              {row[col] == null ? (
                                <span className="text-gray-300 italic">null</span>
                              ) : (
                                String(row[col])
                              )}
                            </td>
                          ))}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>

                {totalPages > 1 && (
                  <div className="px-5 py-3 border-t border-gray-100 flex items-center justify-between text-xs text-gray-600">
                    <span>
                      Showing {pageStart + 1}–{Math.min(pageStart + RESULTS_PAGE_SIZE, totalRows)} of{' '}
                      {totalRows.toLocaleString()} rows
                    </span>
                    <div className="flex items-center gap-1">
                      <button
                        onClick={() => setResultsPage((p) => p - 1)}
                        disabled={resultsPage === 1}
                        className="px-2 py-1 rounded border border-gray-200 disabled:opacity-40 hover:bg-gray-50"
                      >
                        ‹ Prev
                      </button>
                      {Array.from({ length: Math.min(totalPages, 5) }, (_, i) => {
                        const p = i + 1
                        return (
                          <button
                            key={p}
                            onClick={() => setResultsPage(p)}
                            className={`px-2 py-1 rounded border ${
                              p === resultsPage
                                ? 'bg-blue-600 text-white border-blue-600'
                                : 'border-gray-200 hover:bg-gray-50'
                            }`}
                          >
                            {p}
                          </button>
                        )
                      })}
                      {totalPages > 5 && resultsPage < totalPages && <span>…</span>}
                      <button
                        onClick={() => setResultsPage((p) => p + 1)}
                        disabled={resultsPage === totalPages}
                        className="px-2 py-1 rounded border border-gray-200 disabled:opacity-40 hover:bg-gray-50"
                      >
                        Next ›
                      </button>
                    </div>
                  </div>
                )}
              </div>
            )
          })()}

          {result?.success && result.rows.length === 0 && (
            <div className="bg-white border border-gray-200 rounded-xl px-5 py-8 text-center text-sm text-gray-500">
              Query executed successfully but returned no rows.
            </div>
          )}
        </div>

        {/* Available Tables sidebar */}
        <div className="w-72 flex-shrink-0">
          <div className="bg-white border border-gray-200 rounded-xl overflow-hidden">
            <button
              onClick={() => setTablesExpanded((v) => !v)}
              className="w-full px-4 py-3 border-b border-gray-100 flex items-center justify-between hover:bg-gray-50"
            >
              <span className="text-xs font-semibold text-gray-700 uppercase tracking-wider">
                Available Tables
              </span>
              {tablesExpanded ? (
                <ChevronDown className="w-3.5 h-3.5 text-gray-400" />
              ) : (
                <ChevronRight className="w-3.5 h-3.5 text-gray-400" />
              )}
            </button>

            {tablesExpanded && (
              <div className="overflow-y-auto max-h-[60vh]">
                {tables.length === 0 ? (
                  <p className="px-4 py-4 text-xs text-gray-400">No tables uploaded yet.</p>
                ) : (
                  datasetOrder.map((dsName) => (
                    <div key={dsName}>
                      <div className="px-4 py-1.5 bg-gray-50 border-b border-gray-100">
                        <span className="text-xs font-semibold text-gray-400 uppercase tracking-wider">
                          {dsName}
                        </span>
                      </div>
                      {tablesByDataset.get(dsName)!.map((t) => (
                        <TableReferenceItem key={t.id} table={t} />
                      ))}
                    </div>
                  ))
                )}
              </div>
            )}
          </div>

          {tables.length > 0 && (
            <p className="mt-2 text-xs text-gray-400 px-1">
              Click a table or field name to copy it.
            </p>
          )}
        </div>
      </div>
    </div>
  )
}

// ─── Table reference item in sidebar ─────────────────────────────────────────

function TableReferenceItem({ table }: { table: TableOption }) {
  const [expanded, setExpanded] = useState(false)
  const [copied, setCopied] = useState<string | null>(null)

  function copy(text: string, key: string) {
    navigator.clipboard.writeText(text).then(() => {
      setCopied(key)
      setTimeout(() => setCopied(null), 1500)
    })
  }

  return (
    <div className="border-b border-gray-100 last:border-b-0">
      <div className="flex items-center gap-1 px-3 py-2 hover:bg-gray-50">
        <button
          onClick={() => setExpanded((v) => !v)}
          className="p-0.5 text-gray-300 hover:text-gray-500"
        >
          {expanded ? (
            <ChevronDown className="w-3 h-3" />
          ) : (
            <ChevronRight className="w-3 h-3" />
          )}
        </button>
        <button
          onClick={() => copy(table.friendlyName, table.id)}
          className="text-xs font-mono text-blue-600 hover:text-blue-800 text-left flex-1 truncate"
          title={`Click to copy: ${table.friendlyName}`}
        >
          {table.friendlyName}
        </button>
        {copied === table.id && (
          <span className="text-xs text-green-500 flex-shrink-0">copied</span>
        )}
      </div>

      {expanded && (
        <div className="pl-8 pr-3 pb-2 space-y-0.5">
          {table.fieldNames.length === 0 ? (
            <p className="text-xs text-gray-400 italic">No fields found</p>
          ) : (
            table.fieldNames.map((fieldName) => (
              <div key={fieldName} className="flex items-center justify-between gap-1">
                <button
                  onClick={() => copy(`"${fieldName}"`, `field-${table.id}-${fieldName}`)}
                  className="text-xs font-mono text-gray-600 hover:text-blue-600 text-left truncate"
                  title={`Click to copy: "${fieldName}"`}
                >
                  &quot;{fieldName}&quot;
                </button>
                {copied === `field-${table.id}-${fieldName}` && (
                  <span className="text-xs text-green-500 flex-shrink-0">copied</span>
                )}
              </div>
            ))
          )}
        </div>
      )}
    </div>
  )
}
