'use client'

import type { BlockingIssue } from '@/lib/actions/staging'

interface Props {
  issues: BlockingIssue[]
  /** Label for the secondary "proceed anyway" button. Defaults to "Stage All — Review Flagged Rows". */
  proceedLabel?: string
  onFixIssues: () => void
  onProceed: () => void
  onCancel: () => void
}

const EXCLUSION_THRESHOLD = 0.02 // 2%

export default function StagingWarningPopup({ issues, proceedLabel = 'Stage All — Review Flagged Rows', onFixIssues, onProceed, onCancel }: Props) {
  // Aggregate affected rows and detect threshold breaches per table
  const byTable = new Map<
    string,
    { tableName: string; totalRows: number; affected: number; issues: BlockingIssue[] }
  >()

  for (const issue of issues) {
    const key = issue.table_id ?? '__unknown__'
    if (!byTable.has(key)) {
      byTable.set(key, {
        tableName: issue.table_name ?? 'Unknown table',
        totalRows: issue.table_total_rows,
        affected: 0,
        issues: [],
      })
    }
    const entry = byTable.get(key)!
    entry.affected = Math.max(entry.affected, issue.affected_records)
    entry.issues.push(issue)
  }

  const tableEntries = [...byTable.values()]

  const hasThresholdBreach = tableEntries.some(
    (e) => e.totalRows > 0 && e.affected / e.totalRows > EXCLUSION_THRESHOLD
  )

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <div
        className="bg-white rounded-2xl shadow-2xl w-full max-w-xl overflow-hidden"
        role="dialog"
        aria-modal="true"
        aria-labelledby="staging-warning-title"
      >
        {/* Header */}
        <div className="px-6 pt-6 pb-4 border-b border-gray-100">
          <div className="flex items-start gap-3">
            <div className="w-9 h-9 rounded-full bg-amber-100 flex items-center justify-center flex-shrink-0 mt-0.5">
              <span className="text-amber-600 text-lg leading-none">⚠</span>
            </div>
            <div>
              <h2
                id="staging-warning-title"
                className="text-base font-semibold text-gray-900"
              >
                Source Data Issues Detected
              </h2>
              <p className="text-sm text-gray-500 mt-0.5">
                Blocking quality issues exist on the source data.
              </p>
            </div>
          </div>
        </div>

        {/* Body */}
        <div className="px-6 py-4 space-y-4 max-h-72 overflow-y-auto">
          {tableEntries.map((entry) => {
            const pct =
              entry.totalRows > 0
                ? ((entry.affected / entry.totalRows) * 100).toFixed(1)
                : null
            const breachesThreshold =
              entry.totalRows > 0 &&
              entry.affected / entry.totalRows > EXCLUSION_THRESHOLD

            return (
              <div key={entry.tableName} className="space-y-2">
                <p className="text-sm text-gray-700">
                  <strong>{entry.affected.toLocaleString()}</strong> row
                  {entry.affected !== 1 ? 's' : ''} in{' '}
                  <span className="font-medium text-gray-900">{entry.tableName}</span> have
                  blocking quality issues that will produce incomplete or invalid data in
                  the target:
                </p>

                <ul className="space-y-1 pl-4">
                  {entry.issues.map((issue) => (
                    <li key={issue.id} className="flex items-start gap-2 text-sm text-gray-600">
                      <span className="text-red-500 mt-0.5 flex-shrink-0">•</span>
                      <span>
                        <span className="font-medium text-gray-800">{issue.title}</span>
                        {issue.affected_records > 0 && (
                          <span className="text-gray-400 ml-1">
                            ({issue.affected_records.toLocaleString()} row
                            {issue.affected_records !== 1 ? 's' : ''})
                          </span>
                        )}
                      </span>
                    </li>
                  ))}
                </ul>

                {breachesThreshold && pct && (
                  <div className="flex items-start gap-2 bg-red-50 border border-red-200 rounded-lg px-3 py-2 text-xs text-red-700">
                    <span className="font-medium">⚠ This affects {pct}% of records</span>
                    <span className="text-red-500">(above the 2% acceptable threshold).</span>
                    <span>Consider fixing before proceeding.</span>
                  </div>
                )}
              </div>
            )
          })}

          <div className="bg-blue-50 border border-blue-100 rounded-lg px-4 py-3 text-sm text-blue-800">
            All rows will be staged — problem rows will be flagged in the Transformed Data
            Preview so you can review them.
          </div>

          <p className="text-xs text-gray-500">
            <strong>Best practice:</strong> Fix these issues in the Validate tab for a clean
            migration.
          </p>
        </div>

        {/* Footer buttons — Fix Issues is the primary recommended action */}
        <div className="px-6 py-4 border-t border-gray-100 flex flex-col sm:flex-row gap-3">
          <button
            onClick={onFixIssues}
            className="flex-1 px-4 py-2.5 rounded-lg bg-primary hover:bg-primary/90 text-sm font-medium text-white transition-colors text-left"
          >
            <div className="font-semibold">Fix Issues →</div>
            <div className="text-xs text-white/70 font-normal mt-0.5">
              Go to Validate tab to resolve these issues
            </div>
          </button>

          <button
            onClick={onProceed}
            className="flex-1 px-4 py-2.5 rounded-lg border border-gray-300 bg-white text-sm font-medium text-gray-700 hover:bg-gray-50 hover:border-gray-400 transition-colors text-left"
          >
            <div className="font-semibold text-gray-800">{proceedLabel}</div>
            <div className="text-xs text-gray-500 font-normal mt-0.5">
              Proceeds and flags problem rows for review
            </div>
          </button>
        </div>

        {/* Dismiss */}
        <button
          onClick={onCancel}
          className="absolute top-4 right-4 text-gray-400 hover:text-gray-600 p-1 rounded"
          aria-label="Cancel"
        >
          <svg className="w-4 h-4" viewBox="0 0 16 16" fill="currentColor">
            <path d="M3.72 3.72a.75.75 0 0 1 1.06 0L8 6.94l3.22-3.22a.75.75 0 1 1 1.06 1.06L9.06 8l3.22 3.22a.75.75 0 1 1-1.06 1.06L8 9.06l-3.22 3.22a.75.75 0 0 1-1.06-1.06L6.94 8 3.72 4.78a.75.75 0 0 1 0-1.06z" />
          </svg>
        </button>
      </div>
    </div>
  )
}
