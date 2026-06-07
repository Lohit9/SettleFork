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

// Per column: render the data cell in mono (codes) vs regular weight (descriptions).
const MONO_COL = [true, false, false, true, true]

const ROWS = [
  ['SKU-PRINT-SLEEVE', 'Printed Sleeves', 'Finished Goods', '4000-COGS', 'true'],
  ['SKU-PRINT-CUP', 'Printed Cups', 'Finished Goods', '4000-COGS', 'true'],
  ['SKU-CONS-INK', 'Inks & Consumables', 'Raw Materials', '5100-MAT', 'true'],
  ['SKU-PRINT-MAT', 'Print Substrates', 'Raw Materials', '5100-MAT', 'true'],
  ['SKU-BLANK-CUP', 'Blank Cups', 'Finished Goods', '4000-COGS', 'true'],
]

const confColor = (conf: number) => (conf >= 90 ? 'var(--green)' : 'var(--amber)')

export default function GenerateStage({ onAdvance }: GenerateStageProps) {
  return (
    <div>
      <h4 className="text-base font-semibold tracking-tight text-[color:var(--ink)] mb-3">
        Ready-to-load
      </h4>

      <div className="overflow-x-auto">
        <table className="w-full min-w-[620px] text-left">
          <thead>
            <tr>
              {COLUMNS.map((col) => (
                <th
                  key={col.source}
                  className="align-bottom border-b border-[color:var(--line)] px-2.5 py-2"
                >
                  <div className="mono text-[11px] font-semibold text-[color:var(--ink)] whitespace-nowrap">
                    {col.source}
                    {col.transform && (
                      <span className="text-[color:var(--blue)]"> → {col.transform}</span>
                    )}
                  </div>
                  <div className="mono text-[11px] text-[color:var(--ink-3)] whitespace-nowrap">
                    {col.target}
                  </div>
                  <div
                    className="mono text-[11px] flex items-center gap-1 mt-1 whitespace-nowrap"
                    style={{ color: confColor(col.conf) }}
                  >
                    <span
                      className="inline-block h-1.5 w-1.5 rounded-full"
                      style={{ background: confColor(col.conf) }}
                    />
                    {col.conf}%
                  </div>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {ROWS.map((row) => (
              <tr key={row[0]}>
                {row.map((cell, ci) => (
                  <td
                    key={ci}
                    className={`border-b border-[color:var(--line)] px-2.5 py-2 whitespace-nowrap ${
                      MONO_COL[ci]
                        ? 'mono text-xs text-[color:var(--ink-2)]'
                        : 'text-sm text-[color:var(--ink)]'
                    }`}
                  >
                    {cell}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="flex justify-end mt-4">
        <button type="button" onClick={onAdvance} className="btn btn-primary">
          Review
          <span aria-hidden="true">→</span>
        </button>
      </div>
    </div>
  )
}
