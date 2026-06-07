'use client'

interface ValidateStageProps {
  /** Advance the carousel to the Export stage. */
  onAdvance?: () => void
}

export default function ValidateStage({ onAdvance }: ValidateStageProps) {
  return (
    <div>
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1 mb-3">
        <h4 className="text-base font-semibold tracking-tight text-[color:var(--ink)]">
          Validate results
        </h4>
        <p className="text-xs text-[color:var(--ink-3)]">
          <span className="mono font-semibold text-[color:var(--ink)]">188,000</span>
          <span className="mono"> / 200,000</span> rows load clean ·{' '}
          <span className="font-medium text-[color:var(--amber)]">
            <span className="mono">38</span> blocked
          </span>
        </p>
      </div>

      {/* Mapping review card */}
      <div className="rounded-xl border border-[color:var(--line)]">
        <div className="flex items-center justify-between gap-3 border-b border-[color:var(--line)] px-4 py-3">
          <span className="mono text-sm font-medium text-[color:var(--ink)]">
            CLASS_CD <span className="text-[color:var(--ink-3)]">→</span>{' '}
            <span className="text-[color:var(--blue)]">commodity_class</span>
          </span>
          <span className="flex items-center gap-1.5 whitespace-nowrap text-xs font-medium text-[color:var(--amber)]">
            <span className="inline-block h-1.5 w-1.5 rounded-full bg-[color:var(--amber)]" />
            86% · Needs review
          </span>
        </div>

        <div className="flex flex-col gap-3 px-4 py-3">
          <p className="flex gap-2 text-sm text-[color:var(--ink-2)]">
            <span className="text-[color:var(--blue)]" aria-hidden="true">✦</span>
            <span>
              Short class codes resolve to full class names via{' '}
              <span className="mono">class_map</span>; a few legacy codes are unmapped,
              holding confidence below 90%.
            </span>
          </p>

          <p className="mono text-xs text-[color:var(--ink-3)]">
            Transform · Lookup via class_map
          </p>

          <div className="flex items-center justify-between gap-3 rounded-md bg-[color:var(--amber-tint)] px-3 py-2">
            <span className="text-xs font-medium text-[color:var(--amber)]">
              ⚠ 4 rows · deprecated class code → defaulted
            </span>
            <span className="flex shrink-0 items-center gap-2">
              <button
                type="button"
                className="inline-flex h-7 items-center rounded-md bg-[color:var(--blue)] px-2.5 text-xs font-medium text-white"
              >
                Fix
              </button>
              <button
                type="button"
                className="inline-flex h-7 items-center rounded-md border border-[color:var(--line)] bg-[color:var(--surface)] px-2.5 text-xs font-medium text-[color:var(--ink)]"
              >
                Accept
              </button>
            </span>
          </div>

          <button type="button" className="btn btn-ghost w-full">
            Mark reviewed
          </button>
        </div>
      </div>

      <div className="flex items-center justify-between gap-3 mt-4">
        <span className="flex items-center gap-1.5 text-xs sm:text-sm text-[color:var(--ink-2)]">
          <span className="text-[color:var(--green)]">✓</span> Nothing loads until you approve
        </span>
        <button type="button" onClick={onAdvance} className="btn btn-primary">
          Export
          <span aria-hidden="true">→</span>
        </button>
      </div>
    </div>
  )
}
