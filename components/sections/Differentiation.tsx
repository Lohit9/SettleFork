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

        {/* horizontally scrollable on narrow screens (reference: overflow-x auto + 720px min-width) */}
        <div className="mx-auto mt-12 max-w-[1000px] overflow-x-auto" style={{ padding: '14px 2px 4px' }}>
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
                displace the auto-placed cells; its grid area is its containing
                block, and inset:0 makes it fill column 4 across every row. */}
            <div
              aria-hidden="true"
              style={{
                position: 'absolute',
                gridColumn: 4,
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
            <div className="relative z-[1]" style={{ borderBottom: LINE }} />
            {COLS.map((col, ci) => {
              const win = ci === 2
              return (
                <div
                  key={col}
                  className={`relative z-[1] flex px-5 ${
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
                    className="relative z-[1] flex min-h-[64px] items-center px-5 py-3 text-[14px] font-medium leading-[1.35] text-[color:var(--ink-2)]"
                    style={{ borderBottom: last ? 'none' : LINE }}
                  >
                    {row.label}
                  </div>
                  {row.cells.map(([mark, text], ci) => {
                    const win = ci === 2
                    return (
                      <div
                        key={ci}
                        className={`relative z-[1] flex min-h-[64px] items-center gap-[10px] py-3 text-[14px] ${
                          win
                            ? 'pl-[22px] pr-5 font-[550] text-[color:var(--ink)]'
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
      </div>
    </section>
  )
}
