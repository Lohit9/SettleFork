import Link from 'next/link'

const CALENDLY = 'https://calendly.com/settle-ai/demo'

const FEATURES = [
  'Fixed, scoped pricing',
  'Unlimited reviewers & approvers',
  'Full dry run before you commit',
  'Hands-on migration support',
]

export default function PricingSection() {
  return (
    <section id="pricing" className="section border-t border-[color:var(--line)] bg-[color:var(--surface)]">
      <div className="wrap">
        <div className="sec-head mx-auto max-w-[720px] text-center">
          <div className="kicker">Pricing</div>
          <h2 className="h2 mt-[14px]">Priced for the migration, not your headcount.</h2>
          <p className="mt-4 text-[18px] leading-[1.55] text-[color:var(--ink-2)]">
            Every migration is different — volume, complexity, the number of sources. We scope a fixed price
            to yours.
          </p>
        </div>

        <div
          className="mx-auto mt-12 grid max-w-[980px] overflow-hidden rounded-[20px] border border-[color:var(--line)] lg:grid-cols-[1.2fr_1fr]"
          style={{ boxShadow: 'var(--sh-md)' }}
        >
          {/* left */}
          <div className="p-10">
            <h3 className="text-[24px] font-semibold tracking-[-0.02em] text-[color:var(--ink)]">
              Scoped per migration
            </h3>
            <p className="mt-3 text-[15px] leading-[1.6] text-[color:var(--ink-2)]">
              No per-seat licensing and no surprises. Bring everyone who needs to review and approve —
              pricing is tied to the work, not the team.
            </p>
            <div className="mt-[22px] flex flex-col gap-[11px]">
              {FEATURES.map((f) => (
                <div key={f} className="flex items-center gap-[11px] text-[14px] text-[color:var(--ink)]">
                  <span className="flex h-[18px] w-[18px] shrink-0 items-center justify-center rounded-full bg-[color:var(--green-tint)]">
                    <svg width="11" height="11" viewBox="0 0 14 14" fill="none">
                      <path d="M2.6 7.3l2.8 2.8 6-6.4" stroke="var(--green-deep)" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" />
                    </svg>
                  </span>
                  {f}
                </div>
              ))}
            </div>
          </div>

          {/* right */}
          <div className="flex flex-col justify-center gap-[18px] border-t border-[color:var(--line)] bg-[color:var(--surface-2)] p-10 lg:border-l lg:border-t-0">
            <div className="mono text-[12px] font-semibold uppercase tracking-[0.1em] text-[color:var(--ink-3)]">
              Get started
            </div>
            <h3 className="text-[27px] font-semibold leading-[1.15] tracking-[-0.02em] text-[color:var(--ink)]">
              Tell us the shape of your migration — we&apos;ll send an estimate.
            </h3>
            <Link href="/pricing" className="btn btn-primary w-full">
              Get an estimate
              <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
                <path d="M3 8h9M8.5 4l4 4-4 4" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </Link>
            <a href={CALENDLY} target="_blank" rel="noopener noreferrer" className="btn btn-ghost w-full">
              Book a demo
            </a>
          </div>
        </div>
      </div>
    </section>
  )
}
