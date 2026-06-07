'use client'

import { useState } from 'react'

interface IngestStageProps {
  /** Advance the carousel to the Generate stage. */
  onAdvance?: () => void
}

const DB_ICON = (
  <svg width="15" height="15" viewBox="0 0 16 16" fill="none">
    <ellipse cx="8" cy="3.6" rx="5" ry="2.1" stroke="currentColor" strokeWidth="1.2" />
    <path d="M3 3.6v8.8c0 1.16 2.24 2.1 5 2.1s5-.94 5-2.1V3.6" stroke="currentColor" strokeWidth="1.2" />
    <path d="M3 8c0 1.16 2.24 2.1 5 2.1s5-.94 5-2.1" stroke="currentColor" strokeWidth="1.2" />
  </svg>
)

const ROWS = [
  { label: 'Source Data', detail: 'CSV · 9 tables · 142 fields', status: { text: 'Connected', ok: true }, icon: DB_ICON },
  { label: 'Target System', detail: 'DDL · 8 tables · 118 fields', status: { text: 'Defined', ok: true }, icon: DB_ICON },
  {
    label: 'Business context & rules',
    detail: '4 of 5 answered',
    status: null,
    icon: (
      <svg width="15" height="15" viewBox="0 0 16 16" fill="none">
        <path
          d="M8 1.6l1.7 3.9 4.2.4-3.2 2.8 1 4.1L8 10.9 4.3 12.8l1-4.1L2.1 5.9l4.2-.4z"
          stroke="currentColor"
          strokeWidth="1.1"
          strokeLinejoin="round"
        />
      </svg>
    ),
  },
  {
    label: 'Schema',
    detail: '9 source tables · 8 target tables',
    status: { text: 'Reviewed', ok: false },
    icon: (
      <svg width="15" height="15" viewBox="0 0 16 16" fill="none">
        <rect x="2.2" y="2.6" width="11.6" height="10.8" rx="1.4" stroke="currentColor" strokeWidth="1.2" />
        <path d="M2.2 6.2h11.6M6.4 6.2v7.2" stroke="currentColor" strokeWidth="1.2" />
      </svg>
    ),
  },
]

export default function IngestStage({ onAdvance }: IngestStageProps) {
  const [reviewed, setReviewed] = useState(true)

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center justify-between gap-3 px-5 pt-4 pb-3">
        <div className="text-[15px] font-[650] tracking-[-0.015em] text-[color:var(--ink)]">
          Set up your migration
        </div>
      </div>

      <div className="flex min-h-0 flex-1 flex-col justify-center overflow-hidden px-5">
        <div className="flex flex-col rounded-[12px] border border-[color:var(--line)]">
          {ROWS.map((row) => (
            <div
              key={row.label}
              className="flex items-center gap-[13px] px-[18px] py-[13px] border-t border-[color:var(--line-2)] first:border-t-0"
            >
              <span className="flex h-[30px] w-[30px] shrink-0 items-center justify-center rounded-[8px] border border-[color:var(--line)] bg-[color:var(--surface-2)] text-[color:var(--ink-2)]">
                {row.icon}
              </span>
              <span className="flex min-w-0 flex-col gap-[2px]">
                <b className="text-[13.5px] font-semibold tracking-[-0.01em] text-[color:var(--ink)]">{row.label}</b>
                <span className="mono text-[11px] text-[color:var(--ink-3)]">{row.detail}</span>
              </span>
              {row.status &&
                (row.status.ok ? (
                  <span className="ml-auto inline-flex shrink-0 items-center gap-[6px] text-[12.5px] font-semibold text-[color:var(--green-deep)]">
                    <svg width="12" height="12" viewBox="0 0 14 14" fill="none">
                      <path d="M2.6 7.3l2.8 2.8 6-6.4" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" />
                    </svg>
                    {row.status.text}
                  </span>
                ) : (
                  <span className="ml-auto shrink-0 text-[12.5px] font-medium text-[color:var(--ink-3)]">
                    {row.status.text}
                  </span>
                ))}
            </div>
          ))}
        </div>
      </div>

      <div className="flex items-center justify-between gap-[14px] border-t border-[color:var(--line)] bg-[color:var(--surface-2)] px-5 py-[13px]">
        <button
          type="button"
          onClick={() => setReviewed((v) => !v)}
          className="flex items-center gap-[11px] text-[13px] font-medium text-[color:var(--ink)]"
        >
          <span
            className={`flex h-[19px] w-[19px] shrink-0 items-center justify-center rounded-[5px] transition-all ${
              reviewed
                ? 'border border-[color:var(--blue)] bg-[color:var(--blue)]'
                : 'border-[1.5px] border-[color:var(--line-3)] bg-[color:var(--surface)]'
            }`}
          >
            {reviewed && (
              <svg width="11" height="11" viewBox="0 0 14 14" fill="none">
                <path d="M2.6 7.3l2.8 2.8 6-6.4" stroke="#fff" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            )}
          </span>
          I&apos;ve reviewed — tables and fields look correct
        </button>
        <button
          type="button"
          onClick={onAdvance}
          className="btn btn-primary shrink-0"
          style={{ height: 38, padding: '0 17px', fontSize: 13.5, gap: 8 }}
        >
          <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
            <path d="M8 1.6l1.4 3.2 3.2 1.4-3.2 1.4L8 10.8 6.6 7.6 3.4 6.2l3.2-1.4z" fill="currentColor" />
          </svg>
          Generate ready-to-load data
          <svg width="15" height="15" viewBox="0 0 16 16" fill="none" aria-hidden="true">
            <path d="M3 8h9M8.5 4l4 4-4 4" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </button>
      </div>
    </div>
  )
}
