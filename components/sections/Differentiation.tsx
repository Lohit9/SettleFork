import { Fragment } from 'react'

const COLS = ['Manual & ETL tools', 'Newer AI tools', 'Settle']

type Mk = 'yes' | 'no' | 'na'
const ROWS: { label: string; cells: [Mk, string][] }[] = [
  { label: 'Speed', cells: [['no', 'Months'], ['yes', 'Days'], ['yes', 'Days']] },
  {
    label: 'Every row validated against your rules',
    cells: [['no', 'Manual at best'], ['no', 'Model decides'], ['yes', 'Deterministic engine']],
  },
  {
    label: 'AI proposes, never decides',
    cells: [['na', 'No AI'], ['no', 'Proposes and decides'], ['yes', 'Separated from production']],
  },
  {
    label: 'Reusable, re-runnable package',
    cells: [['no', 'One-off scripts'], ['no', 'Not packaged'], ['yes', 'Versioned & re-runnable']],
  },
  {
    label: 'Auditable trail you own',
    cells: [['no', 'Vendor-locked'], ['no', 'Opaque'], ['yes', 'Every step logged']],
  },
]

// Mobile stacked cards render the three columns in winner-first order; ci maps
// back into each row's cells array (0 = Manual, 1 = Newer-AI, 2 = Settle), so the
// md+ grid and the cards share one source of truth.
const CARD_COLS = [{ ci: 2, win: true }, { ci: 0, win: false }, { ci: 1, win: false }]

function Mark({ type }: { type: Mk }) {
  if (type === 'na') {
    return (
      <span className="inline-flex h-[17px] w-[17px] shrink-0 items-center justify-center text-[15px] font-semibold text-[color:var(--ink-3)]">
        —
      </span>
    )
  }
  const yes = type === 'yes'
  return (
    <span
      className="inline-flex h-[17px] w-[17px] shrink-0 items-center justify-center"
      style={{ color: yes ? 'var(--green)' : 'var(--ink-3)' }}
    >
      <svg viewBox="0 0 14 14" fill="none" className="h-full w-full">
        {yes ? (
          <path d="M2.6 7.3l2.8 2.8 6-6.4" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
        ) : (
          <path d="M3.5 3.5l7 7M10.5 3.5l-7 7" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
        )}
      </svg>
    </span>
  )
}

const LINE = '1px solid var(--line)'
const WIN_LINE = '1px solid rgba(29,158,117,.16)'

// md+ grid column order: criterion (col 1) | Settle (col 2) | Manual (col 3) |
// Newer-AI (col 4). ci indexes row.cells (0 = Manual, 1 = Newer-AI, 2 = Settle);
// DOM order is unchanged — explicit grid-column/row placement does the reorder.
const COL_START = (ci: number) => (ci === 2 ? 'col-start-2' : ci === 0 ? 'col-start-3' : 'col-start-4')
const ROW_START = ['row-start-2', 'row-start-3', 'row-start-4', 'row-start-5', 'row-start-6']

export default function Differentiation() {
  return (
    <section id="why" className="section">
      <div className="wrap">
        <div className="sec-head mx-auto max-w-[720px] text-center">
          <div className="kicker">Why teams choose Settle</div>
          <h2 className="h2 mt-[14px]">Purpose-built for migrations where one bad row is unacceptable.</h2>
          <p className="mt-4 text-[18px] leading-[1.55] text-[color:var(--ink-2)]">
            Settle isn&apos;t a general-purpose data tool pointed at a migration. It&apos;s built for the
            complex, high-stakes moves — millions of rows, tangled legacy schemas, production systems people
            rely on — where &quot;mostly correct&quot; isn&apos;t an option.
          </p>
        </div>

        {/* md+ : the comparison grid (hidden below md, replaced by stacked cards) */}
        <div className="mx-auto mt-12 max-w-[1000px] overflow-x-auto max-md:hidden" style={{ padding: '14px 2px 4px' }}>
          <div
            className="relative grid"
            style={{
              gridTemplateColumns: 'minmax(228px, 1.4fr) repeat(3, minmax(140px, 1fr))',
              gridTemplateRows: 'repeat(6, auto)',
              minWidth: 720,
            }}
          >
            {/* raised green-tinted card over the Settle column — an absolute
                overlay (mirrors the reference's .cmp-winhl) so it does not
                displace the placed cells; its grid area is its containing block,
                and inset:0 makes it fill the Settle column across every row. */}
            <div
              aria-hidden="true"
              className="col-start-2 col-end-3"
              style={{
                position: 'absolute',
                gridRow: '1 / -1',
                inset: 0,
                zIndex: 0,
                background: 'rgba(29,158,117,.06)',
                border: '1px solid rgba(29,158,117,.30)',
                borderRadius: 14,
                boxShadow: '0 18px 44px -22px rgba(29,158,117,.5)',
              }}
            />

            {/* header row */}
            <div className="relative z-[1] col-start-1 row-start-1" style={{ borderBottom: LINE }} />
            {COLS.map((col, ci) => {
              const win = ci === 2
              return (
                <div
                  key={col}
                  className={`relative z-[1] flex row-start-1 ${COL_START(ci)} ${ci === 0 ? 'pl-9 pr-5' : 'px-5'} ${
                    win
                      ? 'min-h-0 items-center pt-[18px] text-[16px] font-bold text-[color:var(--ink)]'
                      : 'min-h-[58px] items-end pb-[14px] text-[14px] font-semibold tracking-[-0.01em] text-[color:var(--ink-2)]'
                  }`}
                  style={{ borderBottom: win ? 'none' : LINE }}
                >
                  {col}
                </div>
              )
            })}

            {/* data rows */}
            {ROWS.map((row, ri) => {
              const last = ri === ROWS.length - 1
              return (
                <Fragment key={row.label}>
                  <div
                    className={`relative z-[1] flex min-h-[64px] items-center px-5 py-3 text-[14px] font-medium leading-[1.35] text-[color:var(--ink-2)] col-start-1 ${ROW_START[ri]}`}
                    style={{ borderBottom: last ? 'none' : LINE }}
                  >
                    {row.label}
                  </div>
                  {row.cells.map(([mark, text], ci) => {
                    const win = ci === 2
                    return (
                      <div
                        key={ci}
                        className={`relative z-[1] flex min-h-[64px] items-center gap-[10px] py-3 text-[14px] ${ROW_START[ri]} ${COL_START(ci)} ${
                          win
                            ? 'pl-[22px] pr-5 font-[550] text-[color:var(--ink)]'
                            : ci === 0
                              ? 'pl-9 pr-5 text-[color:var(--ink-3)]'
                              : 'px-5 text-[color:var(--ink-3)]'
                        }`}
                        style={{
                          borderBottom: last ? 'none' : win ? WIN_LINE : LINE,
                          ...(win && last ? { paddingBottom: 18 } : {}),
                        }}
                      >
                        <Mark type={mark} />
                        {text}
                      </div>
                    )
                  })}
                </Fragment>
              )
            })}
          </div>
        </div>

        {/* below md : the same comparison as stacked cards — winner first, no horizontal scroll */}
        <div className="mt-10 hidden flex-col gap-3 max-md:flex">
          {ROWS.map((row) => (
            <div
              key={row.label}
              className="rounded-[14px] border border-[color:var(--line)] bg-[color:var(--surface)]"
              style={{ padding: '12px 14px' }}
            >
              <div className="text-[15px] font-semibold tracking-[-0.01em] text-[color:var(--ink)]">{row.label}</div>
              <div className="mt-[6px] flex flex-col">
                {CARD_COLS.map(({ ci, win }) => {
                  const [mark, value] = row.cells[ci]
                  return (
                    <div
                      key={ci}
                      className="flex items-start gap-[10px] border-t border-[color:var(--line-2)] py-[6px] first:border-t-0"
                      style={win ? { background: 'rgba(29,158,117,.06)' } : undefined}
                    >
                      <Mark type={mark} />
                      <span className="mono mt-[1px] shrink-0 whitespace-nowrap text-[11px] font-semibold uppercase tracking-[0.05em] text-[color:var(--ink-3)]">
                        {COLS[ci]}
                      </span>
                      <span
                        className={`min-w-0 flex-1 text-[13px] leading-[1.4] ${
                          win ? 'font-[550] text-[color:var(--ink)]' : 'text-[color:var(--ink-2)]'
                        }`}
                      >
                        {value}
                      </span>
                    </div>
                  )
                })}
              </div>
            </div>
          ))}
        </div>
      </div>
    </section>
  )
}
