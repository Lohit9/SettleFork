import Link from 'next/link'

const CALENDLY = 'https://calendly.com/settle-ai/demo'

export default function FinalCTA() {
  return (
    <section className="relative overflow-hidden text-center" style={{ padding: '120px 0' }}>
      {/* faint grid texture mirroring the hero, fading from the center */}
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-0"
        style={{
          backgroundImage:
            'linear-gradient(var(--line) 1px, transparent 1px), linear-gradient(90deg, var(--line) 1px, transparent 1px)',
          backgroundSize: '64px 64px',
          opacity: 0.5,
          maskImage: 'radial-gradient(80% 90% at 50% 50%, #000, transparent 72%)',
          WebkitMaskImage: 'radial-gradient(80% 90% at 50% 50%, #000, transparent 72%)',
        }}
      />

      <div className="wrap relative z-[1]">
        <h2
          className="mx-auto max-w-[760px] font-semibold leading-[1.05] tracking-[-0.03em] text-[color:var(--ink)]"
          style={{ fontSize: 'clamp(32px, 4.6vw, 52px)' }}
        >
          De-risk your next migration.
        </h2>
        <p className="mx-auto mt-[18px] max-w-[540px] text-[18px] text-[color:var(--ink-2)]">
          See Settle run on your own schema — or send us the shape of your migration and we&apos;ll come back
          with an estimate.
        </p>
        <div className="mt-8 flex flex-wrap items-center justify-center gap-3">
          <a href={CALENDLY} target="_blank" rel="noopener noreferrer" className="btn btn-primary">
            Book a demo
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
              <path d="M3 8h9M8.5 4l4 4-4 4" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </a>
          <Link href="/pricing" className="btn btn-ghost">
            Get an estimate
          </Link>
        </div>
      </div>
    </section>
  )
}
