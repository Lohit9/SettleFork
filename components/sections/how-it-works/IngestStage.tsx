'use client'

import { useState } from 'react'

interface IngestStageProps {
  /** Advance the carousel to the Generate stage. */
  onAdvance?: () => void
}

const ICON = {
  viewBox: '0 0 24 24',
  width: 16,
  height: 16,
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 1.75,
  strokeLinecap: 'round' as const,
  strokeLinejoin: 'round' as const,
}

const ROWS = [
  {
    label: 'Source Data',
    detail: 'CSV · 9 tables · 142 fields',
    status: { text: 'Connected', tone: 'green' as const },
    icon: (
      <svg {...ICON}>
        <ellipse cx="12" cy="5" rx="8" ry="3" />
        <path d="M4 5v14c0 1.66 3.58 3 8 3s8-1.34 8-3V5" />
        <path d="M4 12c0 1.66 3.58 3 8 3s8-1.34 8-3" />
      </svg>
    ),
  },
  {
    label: 'Target System',
    detail: 'DDL · 8 tables · 118 fields',
    status: { text: 'Defined', tone: 'green' as const },
    icon: (
      <svg {...ICON}>
        <rect x="3" y="4" width="18" height="7" rx="1.5" />
        <rect x="3" y="13" width="18" height="7" rx="1.5" />
        <path d="M7 7.5h.01M7 16.5h.01" />
      </svg>
    ),
  },
  {
    label: 'Business context & rules',
    detail: '4 of 5 answered',
    status: null,
    icon: (
      <svg {...ICON}>
        <rect x="5" y="3" width="14" height="18" rx="2" />
        <path d="M9 7h6M9 11h6M9 15h4" />
      </svg>
    ),
  },
  {
    label: 'Schema',
    detail: '9 source tables · 8 target tables',
    status: { text: 'Reviewed', tone: 'neutral' as const },
    icon: (
      <svg {...ICON}>
        <rect x="3" y="3" width="18" height="18" rx="2" />
        <path d="M3 9h18M9 3v18" />
      </svg>
    ),
  },
]

export default function IngestStage({ onAdvance }: IngestStageProps) {
  const [reviewed, setReviewed] = useState(true)

  return (
    <div>
      <h4 className="text-base font-semibold tracking-tight text-[color:var(--ink)] mb-3">
        Set up your migration
      </h4>

      <div className="mb-4">
        {ROWS.map((row) => (
          <div
            key={row.label}
            className="flex items-center gap-3 py-3 border-b border-[color:var(--line)] last:border-b-0"
          >
            <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-[color:var(--surface-2)] text-[color:var(--ink-2)]">
              {row.icon}
            </span>
            <div className="min-w-0 flex-1">
              <p className="text-sm font-medium text-[color:var(--ink)]">{row.label}</p>
              <p className="mono text-xs text-[color:var(--ink-3)] truncate">{row.detail}</p>
            </div>
            {row.status && (
              <span
                className={`shrink-0 text-xs sm:text-[13px] font-medium ${
                  row.status.tone === 'green'
                    ? 'text-[color:var(--green)]'
                    : 'text-[color:var(--ink-3)]'
                }`}
              >
                {row.status.tone === 'green' ? `✓ ${row.status.text}` : row.status.text}
              </span>
            )}
          </div>
        ))}
      </div>

      <label className="flex items-center gap-2.5 cursor-pointer select-none mb-4">
        <input
          type="checkbox"
          checked={reviewed}
          onChange={(e) => setReviewed(e.target.checked)}
          className="h-4 w-4 cursor-pointer"
          style={{ accentColor: 'var(--blue)' }}
        />
        <span className="text-sm text-[color:var(--ink-2)]">
          I&apos;ve reviewed — tables and fields look correct
        </span>
      </label>

      <button type="button" onClick={onAdvance} className="btn btn-primary w-full">
        <span aria-hidden="true">✦</span>
        Generate ready-to-load data
        <span aria-hidden="true">→</span>
      </button>
    </div>
  )
}
