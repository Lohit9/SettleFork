'use client'

import { useState } from 'react'
import { Copy } from '@/components/icons'
import { executeNLQuery, executeSQLQuery } from '@/lib/actions/query'
import type { TableOption } from '@/lib/actions/data-overview'

interface QueryDataProps {
  projectId: string
  tables: TableOption[]
}

type QueryMode = 'nl' | 'sql'

export default function QueryData({ projectId, tables }: QueryDataProps) {
  const [mode, setMode] = useState<QueryMode>('nl')
  const [selectedTableId, setSelectedTableId] = useState<string>(tables[0]?.id ?? '')
  const [input, setInput] = useState('')
  const [loading, setLoading] = useState(false)
  const [generatedSQL, setGeneratedSQL] = useState<string | null>(null)
  const [results, setResults] = useState<Record<string, unknown>[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [sqlExpanded, setSqlExpanded] = useState(true)
  const [copied, setCopied] = useState(false)

  // Group tables for dropdown
  const datasetOrder: string[] = []
  const tablesByDataset = new Map<string, TableOption[]>()
  for (const t of tables) {
    if (!tablesByDataset.has(t.datasetName)) {
      tablesByDataset.set(t.datasetName, [])
      datasetOrder.push(t.datasetName)
    }
    tablesByDataset.get(t.datasetName)!.push(t)
  }

  function resetResults() {
    setGeneratedSQL(null)
    setResults(null)
    setError(null)
  }

  function handleModeChange(newMode: QueryMode) {
    setMode(newMode)
    setInput('')
    resetResults()
  }

  async function handleExecute() {
    if (!input.trim() || !selectedTableId) return
    setLoading(true)
    resetResults()

    try {
      const result =
        mode === 'nl'
          ? await executeNLQuery(projectId, selectedTableId, input.trim())
          : await executeSQLQuery(projectId, selectedTableId, input.trim())

      if (!result.success) {
        setError(result.error ?? 'Query failed')
        if (result.sql) setGeneratedSQL(result.sql)
      } else {
        setGeneratedSQL(result.sql ?? null)
        setResults(result.results ?? [])
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Unexpected error')
    } finally {
      setLoading(false)
    }
  }

  function copySQL() {
    if (!generatedSQL) return
    navigator.clipboard.writeText(generatedSQL).then(() => {
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    })
  }

  const resultColumns = results && results.length > 0 ? Object.keys(results[0]) : []

  return (
    <div className="flex flex-col gap-4">
      {/* Info banner */}
      <div className="bg-indigo-50 border border-indigo-100 rounded-xl px-5 py-3">
        <p className="text-sm text-indigo-700">
          Use this to explore and understand data. This does not modify data.
        </p>
      </div>

      {/* Query editor card */}
      <div className="bg-white border border-gray-200 rounded-xl overflow-hidden">
        {/* Card header */}
        <div className="px-5 py-4 border-b border-gray-100 flex items-center justify-between">
          <span className="text-sm font-semibold text-gray-900">Query Editor</span>
          <div className="flex items-center gap-2">
            {/* Table selector */}
            <select
              value={selectedTableId}
              onChange={(e) => {
                setSelectedTableId(e.target.value)
                resetResults()
              }}
              className="border border-gray-300 rounded-lg px-3 py-1.5 text-xs focus:outline-none focus:ring-2 focus:ring-indigo-500 mr-2"
            >
              {datasetOrder.map((dsName) => (
                <optgroup key={dsName} label={dsName}>
                  {tablesByDataset.get(dsName)!.map((t) => (
                    <option key={t.id} value={t.id}>{t.name}</option>
                  ))}
                </optgroup>
              ))}
            </select>

            {/* Mode toggle */}
            <div className="flex rounded-lg border border-gray-200 overflow-hidden">
              <button
                onClick={() => handleModeChange('nl')}
                className={`px-3 py-1.5 text-xs font-medium transition-colors ${
                  mode === 'nl'
                    ? 'bg-indigo-600 text-white'
                    : 'bg-white text-gray-600 hover:bg-gray-50'
                }`}
              >
                Natural Language
              </button>
              <button
                onClick={() => handleModeChange('sql')}
                className={`px-3 py-1.5 text-xs font-medium transition-colors border-l border-gray-200 ${
                  mode === 'sql'
                    ? 'bg-indigo-600 text-white'
                    : 'bg-white text-gray-600 hover:bg-gray-50'
                }`}
              >
                SQL
              </button>
            </div>
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
              placeholder="e.g., Show me all accounts with more than 10 contacts"
              className="w-full border border-gray-300 rounded-lg px-4 py-3 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500 placeholder-gray-400"
            />
          ) : (
            <textarea
              value={input}
              onChange={(e) => setInput(e.target.value)}
              placeholder={`SELECT row_data->>'Name' as name FROM data_rows WHERE table_id = '${selectedTableId}' LIMIT 10`}
              rows={5}
              className="w-full border border-gray-300 rounded-lg px-4 py-3 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-indigo-500 placeholder-gray-400 resize-none"
            />
          )}

          <button
            onClick={handleExecute}
            disabled={loading || !input.trim() || !selectedTableId}
            className="mt-3 px-4 py-2 text-sm font-medium text-white bg-indigo-600 rounded-lg hover:bg-indigo-700 disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-2"
          >
            {loading ? (
              <>
                <span className="inline-block w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin" />
                {mode === 'nl' ? 'Generating & Executing…' : 'Executing…'}
              </>
            ) : (
              mode === 'nl' ? 'Generate & Execute Query' : 'Execute Query'
            )}
          </button>
        </div>
      </div>

      {/* Error */}
      {error && (
        <div className="bg-red-50 border border-red-200 rounded-xl px-5 py-3">
          <p className="text-sm text-red-700">{error}</p>
        </div>
      )}

      {/* Generated SQL (NL mode only, also shown on error if SQL was generated) */}
      {generatedSQL && (
        <div className="bg-white border border-gray-200 rounded-xl overflow-hidden">
          <button
            onClick={() => setSqlExpanded((v) => !v)}
            className="w-full px-5 py-3 border-b border-gray-100 flex items-center justify-between hover:bg-gray-50"
          >
            <span className="text-sm font-semibold text-gray-900">Generated SQL</span>
            <div className="flex items-center gap-2">
              <button
                onClick={(e) => { e.stopPropagation(); copySQL() }}
                className="flex items-center gap-1 text-xs text-gray-500 hover:text-gray-700 px-2 py-1 rounded border border-gray-200 hover:bg-gray-100"
              >
                <Copy className="w-3.5 h-3.5" />
                {copied ? 'Copied!' : 'Copy SQL'}
              </button>
              <span className="text-gray-400 text-xs">{sqlExpanded ? '▲' : '▼'}</span>
            </div>
          </button>
          {sqlExpanded && (
            <pre className="px-5 py-4 text-xs font-mono text-gray-800 bg-gray-50 overflow-x-auto whitespace-pre-wrap break-words">
              {generatedSQL}
            </pre>
          )}
        </div>
      )}

      {/* Results */}
      {results && (
        <div className="bg-white border border-gray-200 rounded-xl overflow-hidden">
          <div className="px-5 py-3 border-b border-gray-100 flex items-center justify-between">
            <span className="text-sm font-semibold text-gray-900">Results</span>
            <span className="text-xs text-gray-500">
              Showing {results.length.toLocaleString()} result{results.length !== 1 ? 's' : ''}
              {results.length === 1000 ? ' (limit 1,000)' : ''}
            </span>
          </div>

          {results.length === 0 ? (
            <div className="px-5 py-8 text-center text-sm text-gray-500">No results returned.</div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="bg-gray-50 border-b border-gray-100">
                  <tr>
                    {resultColumns.map((col) => (
                      <th key={col} className="text-left px-4 py-3 text-xs font-semibold text-gray-700 whitespace-nowrap">
                        {col}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {results.map((row, i) => (
                    <tr key={i} className="border-b border-gray-100 last:border-b-0 hover:bg-gray-50">
                      {resultColumns.map((col) => (
                        <td key={col} className="px-4 py-2.5 text-xs text-gray-700 whitespace-nowrap max-w-[240px] truncate">
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
          )}
        </div>
      )}
    </div>
  )
}
