'use client'

interface ValidateStageProps {
  /** Advance the carousel to the Export stage. */
  onAdvance?: () => void
}

const ARROW = (
  <svg width="15" height="15" viewBox="0 0 16 16" fill="none" aria-hidden="true">
    <path d="M3 8h9M8.5 4l4 4-4 4" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
)

export default function ValidateStage({ onAdvance }: ValidateStageProps) {
  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center justify-between gap-3 px-5 pt-4 pb-3 max-md:flex-col max-md:items-start max-md:gap-1">
        <div className="text-[15px] font-[650] tracking-[-0.015em] text-[color:var(--ink)]">Validate results</div>
        <span className="text-[12.5px] text-[color:var(--ink-2)]">
          <b className="tabular-nums font-semibold text-[color:var(--ink)]">188,000</b> / 200,000 rows load clean ·{' '}
          <span className="font-semibold text-[color:var(--amber)]">38 blocked</span>
        </span>
      </div>

      <div className="flex min-h-0 flex-1 flex-col justify-center overflow-hidden px-5">
        <div className="flex w-full flex-col gap-[7px] rounded-[12px] border border-[color:var(--line)] bg-[color:var(--surface-2)] px-[14px] py-[11px]">
          <div className="flex items-center justify-between gap-3 max-md:flex-col max-md:items-start max-md:gap-1">
            <div className="flex items-center gap-[11px] text-[color:var(--ink-3)]">
              <span className="mono text-[13px] font-semibold text-[color:var(--ink)]">CLASS_CD</span>
              {ARROW}
              <span className="mono text-[13px] font-semibold text-[color:var(--blue-press)]">commodity_class</span>
            </div>
            <div className="flex shrink-0 items-baseline gap-[7px]">
              <span className="mono inline-flex items-center gap-[7px] text-[15px] font-bold tabular-nums text-[color:var(--ink)]">
                <span className="h-[9px] w-[9px] rounded-full bg-[color:var(--amber)]" />
                86%
              </span>
              <span className="mono text-[11.5px] font-semibold text-[color:var(--amber)]">· Needs review</span>
            </div>
          </div>

          <div className="flex items-start gap-2 text-[12.5px] leading-[1.5] text-[color:var(--ink-2)]">
            <span className="mt-[2px] flex shrink-0 text-[color:var(--blue)]" aria-hidden="true">
              <svg width="12" height="12" viewBox="0 0 16 16" fill="none">
                <path d="M8 1.6l1.4 3.2 3.2 1.4-3.2 1.4L8 10.8 6.6 7.6 3.4 6.2l3.2-1.4z" fill="currentColor" />
              </svg>
            </span>
            Short class codes resolve to full class names via class_map; a few legacy codes are unmapped,
            holding confidence below 90%.
          </div>

          <div className="mono text-[11.5px] text-[color:var(--ink)]">
            <span className="text-[color:var(--ink-3)]">Transform ·</span> Lookup via class_map
          </div>

          <div
            className="flex items-center gap-[10px] rounded-[9px] border bg-[color:var(--amber-tint)] px-[11px] py-[9px] text-[12px] leading-[1.45]"
            style={{ borderColor: '#F0D9A8', color: 'var(--amber)' }}
          >
            <span className="mt-[1px] shrink-0" aria-hidden="true">
              <svg width="12" height="12" viewBox="0 0 14 14" fill="none">
                <path d="M7 1.8l5.5 9.5h-11z" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round" />
                <path d="M7 5.4v2.4M7 9.4v.05" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
              </svg>
            </span>
            <div className="min-w-0 flex-1">
              <div className="text-[12px] font-semibold">4 rows · deprecated class code → defaulted</div>
            </div>
            <div className="ml-auto flex shrink-0 items-center gap-2 self-center">
              <button type="button" className="btn btn-primary" style={{ height: 28, padding: '0 14px', fontSize: 12 }}>
                Fix
              </button>
              <button type="button" className="btn btn-ghost" style={{ height: 28, padding: '0 14px', fontSize: 12 }}>
                Accept
              </button>
            </div>
          </div>

          <button type="button" className="btn btn-ghost w-full" style={{ height: 32, fontSize: 12.5 }}>
            Mark reviewed
          </button>
        </div>
      </div>

      <div className="flex items-center justify-between gap-[14px] border-t border-[color:var(--line)] bg-[color:var(--surface-2)] px-5 py-[13px]">
        <span className="inline-flex items-center gap-2 text-[12.5px] font-medium text-[color:var(--green-deep)]">
          <svg width="13" height="13" viewBox="0 0 14 14" fill="none" aria-hidden="true">
            <path d="M2.6 7.3l2.8 2.8 6-6.4" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
          Nothing loads until you approve
        </span>
        <button
          type="button"
          onClick={onAdvance}
          className="btn btn-primary shrink-0"
          style={{ height: 38, padding: '0 17px', fontSize: 13.5, gap: 8 }}
        >
          Export
          {ARROW}
        </button>
      </div>
    </div>
  )
}
