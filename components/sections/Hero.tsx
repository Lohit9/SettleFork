'use client'

import Link from 'next/link'
import ScrollReveal from '@/components/ui/ScrollReveal'

const CALENDLY = 'https://calendly.com/settle-ai/demo'

export default function Hero() {
  const scrollToWalkthrough = () => {
    document.getElementById('how')?.scrollIntoView({ behavior: 'smooth' })
  }

  return (
    <section className="relative overflow-hidden bg-[color:var(--bg)] pt-24 lg:pt-32 pb-16 lg:pb-24">
      {/* Faint grid texture, fading out toward the edges */}
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-0"
        style={{
          backgroundImage:
            'linear-gradient(var(--line) 1px, transparent 1px), linear-gradient(90deg, var(--line) 1px, transparent 1px)',
          backgroundSize: '64px 64px',
          opacity: 0.5,
          maskImage:
            'radial-gradient(ellipse 65% 55% at 50% 28%, #000 25%, transparent 75%)',
          WebkitMaskImage:
            'radial-gradient(ellipse 65% 55% at 50% 28%, #000 25%, transparent 75%)',
        }}
      />

      <div className="relative mx-auto max-w-3xl px-6 text-center">
        <ScrollReveal>
          {/* 1 — Eyebrow chip */}
          <span
            className="mono mb-7 inline-flex items-center gap-[9px] rounded-full border border-[color:var(--blue-line)] bg-[color:var(--blue-tint)] text-[12.5px] font-medium tracking-[0.01em] text-[color:var(--blue-press)]"
            style={{ padding: '7px 15px 7px 13px' }}
          >
            <span className="h-[6px] w-[6px] shrink-0 rounded-full bg-[color:var(--blue)]" aria-hidden="true" />
            AI-native enterprise data migration
          </span>

          {/* 2 — Headline */}
          <h1 className="h1 mb-6">
            Months of migration, done in{' '}
            <span style={{ color: 'var(--blue)' }}>weeks</span>.
          </h1>

          {/* 3 — Sub-headline (.hero-description is an AEO speakable selector — keep it) */}
          <p className="hero-description lede mx-auto max-w-2xl mb-9">
            Settle is the AI-native platform that profiles, maps, validates, and
            packages enterprise data for migration — with every row checked before
            it reaches production.
          </p>

          {/* 4 — CTAs */}
          <div className="flex flex-wrap items-center justify-center gap-3 mb-5">
            <a
              href={CALENDLY}
              target="_blank"
              rel="noopener noreferrer"
              className="btn btn-primary group"
            >
              Book a demo
              <span
                aria-hidden="true"
                className="transition-transform group-hover:translate-x-0.5"
              >
                →
              </span>
            </a>
            <Link href="/pricing" className="btn btn-ghost">
              Get an estimate
            </Link>
          </div>

          {/* 5 — Audience microcopy */}
          <p className="text-[13px] text-[color:var(--ink-3)]">
            Built for VPs of IT, data architects &amp; migration leads
          </p>
        </ScrollReveal>

        {/* 6 — Scroll cue → walkthrough (#how) */}
        <ScrollReveal delay={0.15}>
          <button
            type="button"
            onClick={scrollToWalkthrough}
            aria-label="See it in action"
            className="group mx-auto mt-16 flex flex-col items-center gap-2.5"
          >
            <span className="mono text-[11px] tracking-[0.18em] text-[color:var(--ink-3)]">
              SEE IT IN ACTION
            </span>
            <span
              aria-hidden="true"
              className="flex flex-col items-center text-[color:var(--ink-3)] transition-transform group-hover:translate-y-0.5"
            >
              <span className="block h-7 w-px bg-current opacity-50" />
              <svg
                viewBox="0 0 24 24"
                width="14"
                height="14"
                fill="none"
                stroke="currentColor"
                strokeWidth={2}
                strokeLinecap="round"
                strokeLinejoin="round"
                className="-mt-1.5"
              >
                <polyline points="6 9 12 15 18 9" />
              </svg>
            </span>
          </button>
        </ScrollReveal>
      </div>
    </section>
  )
}
