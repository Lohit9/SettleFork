'use client'

interface GenerateStageProps {
  /** Advance the carousel to the Validate stage. */
  onAdvance?: () => void
}

const COLUMNS = [
  { source: 'COMM_CD', transform: null, target: 'commodity_code', conf: 99 },
  { source: 'COMM_DESC', transform: 'trim', target: 'description', conf: 100 },
  { source: 'CLASS_CD', transform: 'lookup', target: 'commodity_class', conf: 86 },
  { source: 'GL_ACCT', transform: 'lookup', target: 'default_gl_account', conf: 88 },
  { source: 'ACTIVE_FLG', transform: 'bool', target: 'is_active', conf: 98 },
]

// Per column: data cell rendered in mono (codes) vs regular weight (descriptions).
const MONO_COL = [true, false, false, true, true]

const ROWS = [
  ['SKU-PRINT-SLEEVE', 'Printed Sleeves', 'Finished Goods', '4000-COGS', 'true'],
  ['SKU-PRINT-CUP', 'Printed Cups', 'Finished Goods', '4000-COGS', 'true'],
  ['SKU-CONS-INK', 'Inks & Consumables', 'Raw Materials', '5100-MAT', 'true'],
  ['SKU-PRINT-MAT', 'Print Substrates', 'Raw Materials', '5100-MAT', 'true'],
  ['SKU-BLANK-CUP', 'Blank Cups', 'Finished Goods', '4000-COGS', 'true'],
]

const GRID = 'grid-cols-[1.2fr_1.15fr_1.1fr_1fr_0.7fr]'

export default function GenerateStage({ onAdvance }: GenerateStageProps) {
  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center justify-between gap-3 px-5 pt-4 pb-3">
        <div className="text-[15px] font-[650] tracking-[-0.015em] text-[color:var(--ink)]">Ready-to-load</div>
      </div>

      <div className="flex min-h-0 flex-1 flex-col overflow-hidden px-5">
        <div className="flex h-full flex-col justify-center max-md:overflow-x-auto">
          {/* column headers */}
          <div className={`grid ${GRID} max-md:min-w-[560px] items-end gap-x-[14px] border-b border-[color:var(--line)] px-[6px] pb-[9px]`}>
            {COLUMNS.map((col) => (
              <div key={col.source} className="flex min-w-0 flex-col gap-[2px]">
                <span className="mono truncate text-[11px] font-[650] text-[color:var(--ink)]">
                  {col.source}
                  {col.transform && <em className="not-italic font-medium text-[color:var(--blue-press)]"> → {col.transform}</em>}
                </span>
                <span className="mono truncate text-[10.5px] font-medium text-[color:var(--ink-3)]">{col.target}</span>
                <span className="mono mt-[2px] inline-flex items-center gap-[5px] text-[11px] font-bold tabular-nums text-[color:var(--ink)]">
                  <span
                    className="h-[9px] w-[9px] shrink-0 rounded-full"
                    style={{ background: col.conf >= 90 ? 'var(--green)' : 'var(--amber)' }}
                  />
                  {col.conf}%
                </span>
              </div>
            ))}
          </div>

          {/* data rows */}
          <div className="flex flex-col max-md:min-w-[560px]">
            {ROWS.map((row) => (
              <div
                key={row[0]}
                className={`grid ${GRID} items-center gap-x-[14px] border-b border-[color:var(--line-2)] px-[6px] py-[7px] max-md:py-[5px] last:border-b-0`}
              >
                {row.map((cell, ci) => (
                  <span
                    key={ci}
                    className={`truncate text-[color:var(--ink)] ${
                      MONO_COL[ci] ? 'mono text-[11.5px]' : 'text-[12px]'
                    }`}
                  >
                    {cell}
                  </span>
                ))}
              </div>
            ))}
          </div>
        </div>
      </div>

      <div className="flex items-center justify-end gap-[14px] border-t border-[color:var(--line)] bg-[color:var(--surface-2)] px-5 py-[13px]">
        <button
          type="button"
          onClick={onAdvance}
          className="btn btn-primary"
          style={{ height: 38, padding: '0 17px', fontSize: 13.5, gap: 8 }}
        >
          Review
          <svg width="15" height="15" viewBox="0 0 16 16" fill="none" aria-hidden="true">
            <path d="M3 8h9M8.5 4l4 4-4 4" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </button>
      </div>
    </div>
  )
}
