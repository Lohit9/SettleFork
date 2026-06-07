const ICON = {
  width: 18,
  height: 18,
  viewBox: '0 0 20 20',
  fill: 'none',
}

const POINTS = [
  {
    h: 'Deploy in your environment',
    p: "Run Settle in your own private cloud, available on demand. Source data doesn't have to leave your perimeter.",
    icon: <path d="M10 2l6 2.2v4.6c0 3.6-2.5 6.6-6 7.6-3.5-1-6-4-6-7.6V4.2L10 2z" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" />,
  },
  {
    h: 'Encrypted end to end',
    p: 'Data is encrypted in transit and at rest.',
    icon: (
      <>
        <rect x="4" y="9" width="12" height="8" rx="1.5" stroke="currentColor" strokeWidth="1.4" />
        <path d="M7 9V6.5a3 3 0 0 1 6 0V9" stroke="currentColor" strokeWidth="1.4" />
      </>
    ),
  },
  {
    h: 'Your data stays yours',
    p: "Your source data isn't retained beyond the migration, and it's never used to train any model — AI processing runs on Anthropic Enterprise LLMs.",
    icon: (
      <>
        <rect x="3.5" y="8.5" width="13" height="8.5" rx="1.6" stroke="currentColor" strokeWidth="1.4" />
        <path d="M6.5 8.5V6a3.5 3.5 0 0 1 7 0v2.5" stroke="currentColor" strokeWidth="1.4" />
        <circle cx="10" cy="12.6" r="1.15" fill="currentColor" />
      </>
    ),
  },
  {
    h: 'Auditable by design',
    p: 'Every profile, mapping, validation, and approval is versioned and logged for review and compliance.',
    icon: (
      <>
        <path d="M5 3h7l3 3v11a.5.5 0 0 1-.5.5h-9A.5.5 0 0 1 5 17V3z" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" />
        <path d="M7.5 9h5M7.5 12h5" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
      </>
    ),
  },
]

const SPECS: { k: string; v: string; ok?: boolean }[] = [
  { k: 'Deployment', v: 'AWS managed · private cloud on demand' },
  { k: 'Encryption', v: 'In transit + at rest', ok: true },
  { k: 'Source data', v: 'Not retained', ok: true },
  { k: 'Model training', v: 'Excluded', ok: true },
  { k: 'Target writes', v: 'On approval only' },
  { k: 'SSO / SAML', v: 'In progress' },
  { k: 'Audit log', v: 'Every step' },
]

export default function SecurityTrust() {
  return (
    <section id="security" className="section">
      <div className="wrap">
        <div className="max-w-[540px]">
          <div className="kicker">Security &amp; trust</div>
          <h2 className="h2 mt-[14px]">Built for environments that don&apos;t forgive mistakes.</h2>
        </div>

        <div className="mt-[34px] grid gap-x-14 gap-y-10 lg:grid-cols-[1.05fr_1fr] lg:items-stretch lg:gap-y-3">
          {/* left — four points, distributed across the panel height */}
          <div className="flex flex-col justify-between lg:col-start-1 lg:row-start-1">
            {POINTS.map((pt) => (
              <div
                key={pt.h}
                className="grid grid-cols-[auto_1fr] gap-x-[15px] gap-y-[3px] border-t border-[color:var(--line)] py-[10px] first:border-t-0"
              >
                <span className="col-start-1 row-start-1 flex h-[34px] w-[34px] items-center justify-center self-center rounded-[9px] bg-[color:var(--blue-tint)] text-[color:var(--blue-press)]">
                  <svg {...ICON}>{pt.icon}</svg>
                </span>
                <h4 className="col-start-2 row-start-1 self-center text-[15px] font-semibold text-[color:var(--ink)]">
                  {pt.h}
                </h4>
                <p className="col-start-2 row-start-2 text-[13.5px] leading-[1.55] text-[color:var(--ink-2)]">
                  {pt.p}
                </p>
              </div>
            ))}
          </div>

          {/* dark spec panel — fills the panel-height row */}
          <div
            className="relative overflow-hidden rounded-[18px] p-[30px] lg:col-start-2 lg:row-start-1"
            style={{ background: 'var(--ink)', boxShadow: 'var(--sh-lg)' }}
          >
              <div
                aria-hidden="true"
                className="absolute inset-0"
                style={{
                  backgroundImage:
                    'linear-gradient(rgba(255,255,255,.04) 1px, transparent 1px), linear-gradient(90deg, rgba(255,255,255,.04) 1px, transparent 1px)',
                  backgroundSize: '26px 26px',
                }}
              />
              <div className="relative flex h-full flex-col justify-between">
                {SPECS.map((s, i) => (
                  <div
                    key={s.k}
                    className="flex items-center gap-3 py-4"
                    style={{ borderBottom: i < SPECS.length - 1 ? '1px solid rgba(255,255,255,.08)' : 'none' }}
                  >
                    <span className="mono text-[12px]" style={{ color: 'rgba(255,255,255,.55)' }}>
                      {s.k}
                    </span>
                    <span className="mono ml-auto flex items-center gap-[7px] text-[12px] font-semibold text-white">
                      {s.v}
                      {s.ok && (
                        <span
                          className="flex h-4 w-4 items-center justify-center rounded-full"
                          style={{ background: 'var(--green)' }}
                        >
                          <svg width="9" height="9" viewBox="0 0 14 14" fill="none">
                            <path d="M2.6 7.3l2.8 2.8 6-6.4" stroke="#fff" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
                          </svg>
                        </span>
                      )}
                    </span>
                  </div>
                ))}
              </div>
            </div>

            <div className="mono text-[13px] leading-[1.6] text-[color:var(--ink-3)] lg:col-start-2 lg:row-start-2">
              Pen test in progress · SOC 2 kicking off soon. Full security overview &amp; compliance docs
              available under NDA.{' '}
              <a
                href="mailto:security@usesettle.ai"
                className="font-semibold text-[color:var(--blue)] hover:text-[color:var(--blue-press)]"
              >
                Request the security package →
              </a>
            </div>
        </div>
      </div>
    </section>
  )
}
