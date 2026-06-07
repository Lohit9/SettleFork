import Link from 'next/link'

const MIGRATIONS = ['Salesforce', 'SAP S/4HANA', 'NetSuite', 'HubSpot', 'Microsoft Dynamics 365', 'Oracle']

export default function Credibility() {
  return (
    <section
      className="relative border-y border-[color:var(--line)] bg-[color:var(--surface)]"
      style={{ paddingTop: 132, paddingBottom: 132 }}
    >
      <div className="wrap">
        <div className="grid items-stretch gap-16 lg:grid-cols-[1.15fr_1fr]">
          {/* Why this exists */}
          <div>
            <div className="kicker">Why this exists</div>
            <h2 className="h2 mt-[14px]" style={{ fontSize: 'clamp(26px, 3.2vw, 38px)' }}>
              Built by the people who ran the migrations.
            </h2>
            <div className="mt-8 flex max-w-[34rem] flex-col gap-[22px]">
              <p className="text-[20px] leading-[1.6] text-[color:var(--ink-2)]">
                We spent years running enterprise data migrations at{' '}
                <strong className="font-bold text-[color:var(--ink)]">Deloitte</strong>. The fast tools
                shipped data nobody had checked. The careful ones took months. You never got both.
              </p>
              <p className="text-[20px] leading-[1.6] text-[color:var(--ink-2)]">
                So we built Settle to be both. AI does the heavy lifting, deterministic engines check{' '}
                <strong className="font-bold text-[color:var(--ink)]">every</strong> row, and a human signs
                off before anything touches production.
              </p>
            </div>
          </div>

          {/* Testimonial card */}
          <div className="flex">
            <div
              className="relative flex flex-1 flex-col rounded-[18px] border border-[color:var(--line)] bg-[color:var(--surface-2)] px-8 pb-[26px] pt-8"
              style={{ boxShadow: 'var(--sh-sm)' }}
            >
              <div
                className="font-bold leading-[.6] text-[color:var(--blue-line)]"
                style={{ fontSize: 64, height: 30 }}
                aria-hidden="true"
              >
                &ldquo;
              </div>
              <blockquote
                className="mono flex-1 rounded-[10px] border border-dashed border-[color:var(--blue-line)] p-[18px] text-[13px] font-normal leading-[1.7] tracking-[0.01em] text-[color:var(--ink-3)]"
                style={{
                  background:
                    'repeating-linear-gradient(-45deg, rgba(35,88,212,.05) 0 8px, transparent 8px 16px)',
                }}
              >
                [ PLACEHOLDER — customer quote to be supplied. Do not invent. ]
              </blockquote>
              <div className="mt-[26px] flex items-center gap-[13px] border-t border-[color:var(--line)] pt-5">
                <div
                  aria-hidden="true"
                  className="flex h-[42px] w-[42px] shrink-0 items-center justify-center rounded-[11px] bg-[color:var(--ink)] text-[15px] font-bold tracking-[-0.02em] text-white"
                >
                  3L
                </div>
                <div>
                  <div className="mono text-[13px] font-semibold text-[color:var(--ink-3)]">
                    [ Name &amp; title — TBD ]
                  </div>
                  <div className="mt-[3px] text-[15px] font-semibold tracking-[-0.01em] text-[color:var(--ink)]">
                    ThreeLevel Basketball
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>

        {/* Designed for migrations to */}
        <div className="mt-[104px] text-center">
          <div className="kicker">Designed for migrations to</div>
          <div
            className="mt-[26px] flex flex-wrap items-center justify-center gap-y-[18px]"
            style={{ columnGap: 'clamp(30px, 5vw, 64px)' }}
          >
            {MIGRATIONS.map((name) => (
              <span
                key={name}
                className="whitespace-nowrap text-[16px] font-semibold tracking-[-0.01em] text-[color:var(--ink-3)]"
              >
                {name}
              </span>
            ))}
          </div>
          <Link
            href="/migrate"
            className="mt-[30px] inline-block text-[14px] font-semibold tracking-[-0.01em] text-[color:var(--blue)] hover:text-[color:var(--blue-press)]"
          >
            View all 100+ migration paths →
          </Link>
        </div>
      </div>
    </section>
  )
}
