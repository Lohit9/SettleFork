'use client'

import { useState, useEffect, useTransition } from 'react'
import { Copy, ChevronDown, ChevronRight } from '@/components/icons'
import {
  executeNLQuery,
  executeSQLQuery,
  backfillFriendlyNames,
  getQueryHistory,
  clearQueryHistory,
  generateSuggestedQueries,
} from '@/lib/actions/query'
import type { QueryEngineResult, QueryHistoryEntry } from '@/lib/actions/query'
import type { TableOption } from '@/lib/actions/data-overview'

interface QueryDataProps {
  projectId: string
  tables: TableOption[]
  isArchived?: boolean
  initialQuery?: string
  initialMode?: 'nl' | 'sql'
}

type QueryMode = 'nl' | 'sql'

function timeAgo(dateStr: string): string {
  const seconds = Math.floor((Date.now() - new Date(dateStr).getTime()) / 1000)
  if (seconds < 60) return 'just now'
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.floor(hours / 24)
  if (days < 7) return `${days}d ago`
  return new Date(dateStr).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
}

export default function QueryData({ projectId, tables, isArchived = false, initialQuery, initialMode }: QueryDataProps) {
  const [mode, setMode] = useState<QueryMode>(initialMode ?? 'nl')
  const [input, setInput] = useState(initialQuery ?? '')
  const [loading, setLoading] = useState(false)
  const [result, setResult] = useState<QueryEngineResult | null>(null)
  const [resultsPage, setResultsPage] = useState(1)
  const [executedSQLExpanded, setExecutedSQLExpanded] = useState(false)
  const [showRetryDetails, setShowRetryDetails] = useState(false)
  const RESULTS_PAGE_SIZE = 10
  const [tablesExpanded, setTablesExpanded] = useState(true)
  const [copied, setCopied] = useState<'friendly' | 'executed' | null>(null)

  // Suggested queries state
  const [suggestions, setSuggestions] = useState<string[]>([])
  const [suggestionsLoading, setSuggestionsLoading] = useState(false)

  // History state
  const [history, setHistory] = useState<QueryHistoryEntry[]>([])
  const [historyExpanded, setHistoryExpanded] = useState(false)
  const [historyLoaded, setHistoryLoaded] = useState(false)
  const [clearingHistory, startClearTransition] = useTransition()

  // Load history on mount
  useEffect(() => {
    getQueryHistory(projectId, 20)
      .then((entries) => {
        setHistory(entries)
        setHistoryLoaded(true)
      })
      .catch(() => setHistoryLoaded(true))
  }, [projectId])

  // Generate suggested queries once on mount — cached in state for the session
  useEffect(() => {
    if (tables.length === 0) return
    setSuggestionsLoading(true)
    const summary = tables.map((t) => ({
      name: t.name,
      fieldNames: t.fieldNames,
      rowCount: t.row_count,
      role: t.role,
    }))
    generateSuggestedQueries(projectId, summary)
      .then(setSuggestions)
      .catch(() => {})
      .finally(() => setSuggestionsLoading(false))
  // Run once — tables is stable after server render
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId])

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

    const question = input.trim()
    const queryMode = mode
    const startTime = Date.now()

    try {
      const res =
        queryMode === 'nl'
          ? await executeNLQuery(projectId, question)
          : await executeSQLQuery(projectId, question)
      setResult(res)
      setResultsPage(1)
      setExecutedSQLExpanded(false)
      setShowRetryDetails(false)

      // Optimistically prepend to local history
      const optimisticEntry: QueryHistoryEntry = {
        id: `optimistic-${startTime}`,
        mode: queryMode,
        input: question,
        generated_sql: queryMode === 'nl' ? (res.friendlySQL || null) : null,
        row_count: res.success ? res.rowCount : null,
        error: res.error ?? null,
        created_at: new Date().toISOString(),
      }
      setHistory((prev) => [optimisticEntry, ...prev].slice(0, 20))
    } catch (e) {
      const errorMsg = e instanceof Error ? e.message : 'Unexpected error'
      setResult({
        success: false,
        columns: [],
        rows: [],
        rowCount: 0,
        friendlySQL: input,
        executedSQL: '',
        error: errorMsg,
      })
      const optimisticEntry: QueryHistoryEntry = {
        id: `optimistic-${startTime}`,
        mode: queryMode,
        input: question,
        generated_sql: null,
        row_count: null,
        error: errorMsg,
        created_at: new Date().toISOString(),
      }
      setHistory((prev) => [optimisticEntry, ...prev].slice(0, 20))
    } finally {
      setLoading(false)
    }
  }

  function handleHistoryClick(entry: QueryHistoryEntry) {
    // Re-populate input — does NOT auto-execute
    setMode(entry.mode)
    setInput(entry.input)
    // Scroll to top of editor by clearing result
    setResult(null)
  }

  function handleClearHistory() {
    startClearTransition(async () => {
      await clearQueryHistory(projectId)
      setHistory([])
    })
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

  if (isArchived) {
    return (
      <div className="flex flex-col items-center justify-center py-24 text-center">
        <svg className="w-10 h-10 text-gray-300 mb-4" fill="none" stroke="currentColor" strokeWidth="1.5" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" d="M21 21l-5.197-5.197m0 0A7.5 7.5 0 105.196 5.196a7.5 7.5 0 0010.607 10.607z" />
        </svg>
        <h3 className="text-base font-medium text-gray-700 mb-1.5">Query functionality is not available</h3>
        <p className="text-sm text-gray-500 max-w-sm">
          Query Data is not available for archived projects. Source data was purged during archival.
        </p>
      </div>
    )
  }

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
                      ? 'bg-[#2358D4] text-white'
                      : 'bg-white text-gray-600 hover:bg-gray-50'
                  }`}
                >
                  Natural Language
                </button>
                <button
                  onClick={() => handleModeChange('sql')}
                  className={`px-3 py-1.5 text-xs font-medium transition-colors border-l border-gray-200 ${
                    mode === 'sql'
                      ? 'bg-[#2358D4] text-white'
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

              {/* Suggestion chips — shown when NL input is empty */}
              {mode === 'nl' && input.trim() === '' && (
                <div className="flex flex-wrap gap-2 mt-3">
                  {suggestionsLoading
                    ? Array.from({ length: 4 }).map((_, i) => (
                        <div
                          key={i}
                          className="h-8 w-48 bg-slate-100 rounded-full animate-pulse"
                        />
                      ))
                    : suggestions.map((s, i) => (
                        <button
                          key={i}
                          onClick={() => setInput(s)}
                          className="text-sm px-3 py-1.5 rounded-full border border-slate-200 text-slate-600 hover:bg-slate-50 hover:border-blue-300 transition-colors"
                        >
                          {s}
                        </button>
                      ))}
                </div>
              )}

              <button
                onClick={handleExecute}
                disabled={loading || !input.trim() || tables.length === 0}
                className="mt-3 px-4 py-2 text-sm font-medium text-white bg-[#2358D4] rounded-lg hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-2"
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

          {/* ── Query History ──────────────────────────────────────────────── */}
          {historyLoaded && history.length > 0 && (
            <div className="bg-white border border-gray-200 rounded-xl overflow-hidden">
              {/* History header — toggle */}
              <button
                onClick={() => setHistoryExpanded((v) => !v)}
                className="w-full px-5 py-3 flex items-center justify-between hover:bg-gray-50 transition-colors"
              >
                <div className="flex items-center gap-2">
                  <span className="text-sm font-semibold text-gray-900">Recent Queries</span>
                  <span className="text-xs bg-gray-100 text-gray-500 px-2 py-0.5 rounded-full font-medium">
                    {history.length}
                  </span>
                </div>
                {historyExpanded ? (
                  <ChevronDown className="w-4 h-4 text-gray-400" />
                ) : (
                  <ChevronRight className="w-4 h-4 text-gray-400" />
                )}
              </button>

              {historyExpanded && (
                <>
                  <div className="border-t border-gray-100 divide-y divide-gray-50">
                    {history.map((entry) => (
                      <button
                        key={entry.id}
                        onClick={() => handleHistoryClick(entry)}
                        className="w-full text-left px-5 py-2.5 hover:bg-gray-50 transition-colors group flex items-start gap-3"
                        title="Click to load this query"
                      >
                        {/* Status dot */}
                        <span
                          className={`mt-1.5 w-1.5 h-1.5 rounded-full flex-shrink-0 ${
                            entry.error ? 'bg-red-400' : 'bg-green-400'
                          }`}
                        />

                        {/* Query text */}
                        <span className="flex-1 min-w-0">
                          <span className="text-xs text-gray-800 font-mono leading-relaxed line-clamp-1 group-hover:text-blue-700 transition-colors">
                            {entry.input.length > 100
                              ? entry.input.slice(0, 100) + '…'
                              : entry.input}
                          </span>
                          {entry.error && (
                            <span className="text-[10px] text-red-500 mt-0.5 block truncate">
                              {entry.error.length > 80 ? entry.error.slice(0, 80) + '…' : entry.error}
                            </span>
                          )}
                        </span>

                        {/* Right side: badges + time */}
                        <span className="flex items-center gap-1.5 flex-shrink-0 mt-0.5">
                          {/* Mode badge */}
                          <span
                            className={`text-[10px] px-1.5 py-0.5 rounded font-medium ${
                              entry.mode === 'nl'
                                ? 'bg-purple-100 text-purple-600'
                                : 'bg-gray-100 text-gray-500'
                            }`}
                          >
                            {entry.mode === 'nl' ? 'NL' : 'SQL'}
                          </span>

                          {/* Row count */}
                          {entry.row_count !== null && !entry.error && (
                            <span className="text-[10px] text-gray-400">
                              {entry.row_count.toLocaleString()} row{entry.row_count !== 1 ? 's' : ''}
                            </span>
                          )}

                          {/* Timestamp */}
                          <span className="text-[10px] text-gray-400 tabular-nums">
                            {timeAgo(entry.created_at)}
                          </span>
                        </span>
                      </button>
                    ))}
                  </div>

                  {/* Clear history */}
                  <div className="border-t border-gray-100 px-5 py-2.5 flex justify-end">
                    <button
                      onClick={handleClearHistory}
                      disabled={clearingHistory}
                      className="text-xs text-gray-400 hover:text-red-500 transition-colors disabled:opacity-50"
                    >
                      {clearingHistory ? 'Clearing…' : 'Clear history'}
                    </button>
                  </div>
                </>
              )}
            </div>
          )}

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

          {/* Auto-retry notice */}
          {result?.retried && (
            <div className="flex items-center gap-2 text-sm text-amber-700 bg-amber-50 border border-amber-200 rounded-xl px-4 py-2.5">
              <svg className="w-4 h-4 flex-shrink-0" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
              </svg>
              <span>Query was automatically corrected after an initial error.</span>
              <button
                onClick={() => setShowRetryDetails((v) => !v)}
                className="ml-auto text-amber-800 underline text-xs flex-shrink-0"
              >
                {showRetryDetails ? 'Hide details' : 'View details'}
              </button>
            </div>
          )}

          {showRetryDetails && result?.retried && (
            <div className="text-xs bg-slate-50 border border-slate-200 rounded-xl px-4 py-3 space-y-3">
              <div>
                <span className="font-semibold text-slate-600 uppercase tracking-wide text-[10px]">Original SQL (failed)</span>
                <pre className="mt-1 text-red-600 font-mono whitespace-pre-wrap break-all bg-red-50 rounded-lg px-3 py-2">
                  {result.originalSQL}
                </pre>
              </div>
              <div>
                <span className="font-semibold text-slate-600 uppercase tracking-wide text-[10px]">Error</span>
                <p className="mt-1 text-red-600 font-mono bg-red-50 rounded-lg px-3 py-2">{result.originalError}</p>
              </div>
              <div>
                <span className="font-semibold text-slate-600 uppercase tracking-wide text-[10px]">Corrected SQL</span>
                <pre className="mt-1 text-green-700 font-mono whitespace-pre-wrap break-all bg-green-50 rounded-lg px-3 py-2">
                  {result.friendlySQL}
                </pre>
              </div>
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
                                ? 'bg-[#2358D4] text-white border-blue-600'
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
        {copied === table.id ? (
          <span className="text-xs text-green-500 flex-shrink-0">copied</span>
        ) : (
          <span
            className={`text-xs flex-shrink-0 px-1 rounded ${
              table.role === 'target'
                ? 'text-violet-400 bg-violet-50'
                : 'text-slate-400 bg-slate-50'
            }`}
          >
            {table.role === 'target' ? 'staged' : 'source'}
          </span>
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
