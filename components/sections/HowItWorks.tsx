'use client'

import { useRef, useState } from 'react'
import {
  AnimatePresence,
  motion,
  useScroll,
  useMotionValueEvent,
  useReducedMotion,
} from 'framer-motion'
import ScrollReveal from '@/components/ui/ScrollReveal'
import IngestStage from './how-it-works/IngestStage'
import GenerateStage from './how-it-works/GenerateStage'
import ValidateStage from './how-it-works/ValidateStage'
import ExportStage from './how-it-works/ExportStage'

const STAGES = [
  {
    label: 'Ingest',
    heading: 'Connect & understand your data',
    sub: 'Settle profiles both sides and flags anomalies before any mapping begins.',
  },
  {
    label: 'Generate',
    heading: 'Review your ready-to-load data',
    sub: 'Every field mapping and transform, proposed with a confidence score.',
  },
  {
    label: 'Validate',
    heading: 'Validate results',
    sub: "Every row is checked against your target — see what loads clean and what's blocked.",
  },
  {
    label: 'Export',
    heading: 'Export deliverables & migration',
    sub: 'A complete, reusable execution package your team reviews and runs.',
  },
]

const STAGE_TRANSITION = {
  initial: { opacity: 0, y: 8 },
  animate: { opacity: 1, y: 0 },
  exit: { opacity: 0, y: -8 },
  transition: { duration: 0.25 },
}

export default function HowItWorks() {
  const [active, setActive] = useState(0)
  const trackRef = useRef<HTMLDivElement>(null)
  const reduceMotion = useReducedMotion()
  const stage = STAGES[active]

  // Native scroll drives the active stage: the track pins its inner panel,
  // and scrollYProgress (0→1 across the track) maps to the four stages.
  const { scrollYProgress } = useScroll({
    target: trackRef,
    offset: ['start start', 'end end'],
  })

  useMotionValueEvent(scrollYProgress, 'change', (p) => {
    const next = Math.min(STAGES.length - 1, Math.max(0, Math.floor(p * STAGES.length)))
    setActive((prev) => (prev === next ? prev : next))
  })

  // Clicks scroll the page to a stage's center instead of setting state, so the
  // scroll position stays the single source of truth (the listener then updates
  // state). Reduced motion → instant jump.
  const goToStage = (i: number) => {
    const el = trackRef.current
    if (!el) return
    const trackTop = window.scrollY + el.getBoundingClientRect().top
    const scrollable = el.offsetHeight - window.innerHeight
    const frac = (i + 0.5) / STAGES.length
    window.scrollTo({
      top: trackTop + scrollable * frac,
      behavior: reduceMotion ? 'auto' : 'smooth',
    })
  }

  const bodies = [
    <IngestStage key="ingest" onAdvance={() => goToStage(1)} />,
    <GenerateStage key="generate" onAdvance={() => goToStage(2)} />,
    <ValidateStage key="validate" onAdvance={() => goToStage(3)} />,
    <ExportStage key="export" />,
  ]

  return (
    <section id="how" className="relative bg-[color:var(--bg)]">

      {/* Intro heading — normal flow, seen before the pinned track */}
      <div className="px-6 pt-24 pb-12">
        <ScrollReveal>
          <h2 className="h2 mx-auto max-w-3xl text-center">Watch a migration run, end to end.</h2>
        </ScrollReveal>
      </div>

      {/* Scroll track — ~one viewport per stage */}
      <div ref={trackRef} className="relative h-[400vh]">
        {/* Pinned panel, vertically centered in the viewport */}
        <div className="sticky top-0 flex h-screen items-center overflow-hidden px-6">
          <div className="mx-auto w-full max-w-3xl">

            {/* Per-stage eyebrow + heading + sub */}
            <div className="text-center min-h-[120px]">
              <AnimatePresence mode="wait">
                <motion.div key={`head-${active}`} {...STAGE_TRANSITION}>
                  <p className="mono text-xs font-semibold tracking-[0.15em] text-[color:var(--blue)] mb-2">
                    STEP {String(active + 1).padStart(2, '0')} / 04
                  </p>
                  <h3 className="text-2xl sm:text-[28px] font-semibold tracking-tight text-[color:var(--ink)] mb-2">
                    {stage.heading}
                  </h3>
                  <p className="lede mx-auto max-w-xl">{stage.sub}</p>
                </motion.div>
              </AnimatePresence>
            </div>

            {/* Browser-chrome mockup */}
            <div className="card overflow-hidden mt-3">
              {/* Window chrome + URL bar */}
              <div className="flex items-center gap-3 border-b border-[color:var(--line)] px-4 py-2.5">
                <div className="flex gap-1.5 shrink-0">
                  <span className="h-2.5 w-2.5 rounded-full bg-[color:var(--line-3)]" />
                  <span className="h-2.5 w-2.5 rounded-full bg-[color:var(--line-3)]" />
                  <span className="h-2.5 w-2.5 rounded-full bg-[color:var(--line-3)]" />
                </div>
                <div className="flex-1 rounded-md bg-[color:var(--surface-2)] px-3 py-1.5">
                  <span className="mono text-[11px] text-[color:var(--ink-3)]">
                    settledata.ai/app/migrations/erp-to-erp
                  </span>
                </div>
              </div>

              {/* Stepper */}
              <div className="flex items-center gap-2 sm:gap-3 overflow-x-auto border-b border-[color:var(--line)] px-4 py-2.5">
                {STAGES.map((s, i) => {
                  const done = i < active
                  const isActive = i === active
                  return (
                    <div key={s.label} className="flex items-center gap-2 sm:gap-3 shrink-0">
                      {i > 0 && (
                        <span className="text-[color:var(--line-3)]" aria-hidden="true">·</span>
                      )}
                      <button
                        type="button"
                        onClick={() => goToStage(i)}
                        aria-current={isActive ? 'step' : undefined}
                        className={`flex items-center gap-1.5 whitespace-nowrap text-xs sm:text-[13px] font-medium transition-colors ${
                          done
                            ? 'text-[color:var(--green)]'
                            : isActive
                              ? 'text-[color:var(--blue)]'
                              : 'text-[color:var(--ink-3)] hover:text-[color:var(--ink-2)]'
                        }`}
                      >
                        <span className="mono">{done ? '✓' : String(i + 1).padStart(2, '0')}</span>
                        <span>{s.label}</span>
                      </button>
                    </div>
                  )
                })}
              </div>

              {/* Active stage body — capped height; internal overflow clips */}
              <div
                className="overflow-hidden p-4 sm:p-5"
                style={{ height: 'clamp(340px, calc(100vh - 340px), 460px)' }}
              >
                <AnimatePresence mode="wait">
                  <motion.div key={`body-${active}`} {...STAGE_TRANSITION}>
                    {bodies[active]}
                  </motion.div>
                </AnimatePresence>
              </div>
            </div>

            {/* Pagination dots */}
            <div className="mt-5 flex items-center justify-center gap-2.5">
              {STAGES.map((s, i) => (
                <button
                  key={s.label}
                  type="button"
                  onClick={() => goToStage(i)}
                  aria-label={`Go to ${s.label} step`}
                  aria-current={i === active ? 'step' : undefined}
                  className={`h-2 rounded-full transition-all ${
                    i === active
                      ? 'w-6 bg-[color:var(--blue)]'
                      : 'w-2 bg-[color:var(--line-3)] hover:bg-[color:var(--ink-3)]'
                  }`}
                />
              ))}
            </div>

            <p className="mt-3 text-center text-sm text-[color:var(--ink-3)]">
              From profiling to a production-ready package in days, not months.
            </p>
          </div>
        </div>
      </div>
    </section>
  )
}
