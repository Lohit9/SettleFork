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
        {/* Pinned panel — offset below the 64px sticky site header, content centered */}
        <div
          className="sticky top-16 flex items-center overflow-hidden"
          style={{ height: 'calc(100vh - 4rem)' }}
        >
          <div className="wrap w-full">

            {/* Per-stage eyebrow + heading + sub */}
            <div className="text-center min-h-[104px]">
              <AnimatePresence mode="wait">
                <motion.div key={`head-${active}`} {...STAGE_TRANSITION}>
                  <p className="mono uppercase text-[0.8125rem] font-semibold tracking-[0.18em] text-[color:var(--ink-3)] mb-2">
                    STEP {String(active + 1).padStart(2, '0')} / 04
                  </p>
                  <h3
                    className="font-bold leading-[1.1] tracking-tight [text-wrap:balance] text-[color:var(--ink)] mb-3"
                    style={{ fontSize: 'clamp(2rem, 1.4rem + 1.6vw, 2.625rem)' }}
                  >
                    {stage.heading}
                  </h3>
                  <p className="mx-auto max-w-[52rem] text-[1.125rem] leading-snug [text-wrap:pretty] text-[color:var(--ink-2)]">
                    {stage.sub}
                  </p>
                </motion.div>
              </AnimatePresence>
            </div>

            {/* Browser-chrome mockup — full wrap width */}
            <div className="card overflow-hidden mt-7">
              {/* Window chrome: neutral dots at left, centered URL pill */}
              <div className="relative flex items-center border-b border-[color:var(--line)] px-4 py-2.5">
                <div className="flex gap-1.5 shrink-0">
                  <span className="h-2.5 w-2.5 rounded-full bg-[color:var(--line-3)]" />
                  <span className="h-2.5 w-2.5 rounded-full bg-[color:var(--line-3)]" />
                  <span className="h-2.5 w-2.5 rounded-full bg-[color:var(--line-3)]" />
                </div>
                <div className="absolute left-1/2 flex max-w-[60%] -translate-x-1/2 items-center gap-1.5 rounded-full border border-[color:var(--line)] bg-[color:var(--surface-2)] px-3 py-1">
                  <svg
                    viewBox="0 0 24 24"
                    width="11"
                    height="11"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth={2}
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    className="shrink-0 text-[color:var(--ink-3)]"
                    aria-hidden="true"
                  >
                    <rect x="5" y="11" width="14" height="10" rx="2" />
                    <path d="M8 11V7a4 4 0 0 1 8 0v4" />
                  </svg>
                  <span className="mono truncate text-[11px] text-[color:var(--ink-2)]">
                    settledata.ai/app/migrations/erp-to-erp
                  </span>
                </div>
              </div>

              {/* Stepper → full-width four-column tab bar */}
              <div className="grid grid-cols-4 border-b border-[color:var(--line)]">
                {STAGES.map((s, i) => {
                  const done = i < active
                  const isActive = i === active
                  return (
                    <button
                      key={s.label}
                      type="button"
                      onClick={() => goToStage(i)}
                      aria-current={isActive ? 'step' : undefined}
                      className={`relative flex flex-col items-center gap-1.5 px-1.5 py-2.5 text-center transition-colors sm:flex-row sm:items-center sm:gap-2.5 sm:px-4 sm:py-3 sm:text-left ${
                        i > 0 ? 'border-l border-[color:var(--line)]' : ''
                      }`}
                    >
                      <span
                        className={`mono flex h-[26px] w-[26px] shrink-0 items-center justify-center rounded-full text-[11px] ${
                          isActive
                            ? 'bg-[color:var(--blue)] text-white'
                            : done
                              ? 'bg-[color:var(--green)] text-white'
                              : 'border border-[color:var(--line-2)] bg-[color:var(--surface-2)] text-[color:var(--ink-3)]'
                        }`}
                      >
                        {String(i + 1).padStart(2, '0')}
                      </span>
                      <span
                        className={`text-xs leading-tight sm:text-sm ${
                          isActive
                            ? 'font-medium text-[color:var(--ink)]'
                            : done
                              ? 'text-[color:var(--ink-2)]'
                              : 'text-[color:var(--ink-3)]'
                        }`}
                      >
                        {s.label}
                      </span>
                      {isActive && (
                        <span className="absolute inset-x-0 bottom-0 h-[2px] bg-[color:var(--blue)]" />
                      )}
                    </button>
                  )
                })}
              </div>

              {/* Active stage body — capped height; internal overflow clips */}
              <div
                className="overflow-hidden p-4"
                style={{ height: 'clamp(330px, calc(100vh - 376px), 450px)' }}
              >
                <AnimatePresence mode="wait">
                  <motion.div key={`body-${active}`} {...STAGE_TRANSITION}>
                    {bodies[active]}
                  </motion.div>
                </AnimatePresence>
              </div>
            </div>

            {/* Pagination — progress bar segments (completed + active filled) */}
            <div className="mt-5 flex items-center justify-center gap-2">
              {STAGES.map((s, i) => (
                <button
                  key={s.label}
                  type="button"
                  onClick={() => goToStage(i)}
                  aria-label={`Go to ${s.label} step`}
                  aria-current={i === active ? 'step' : undefined}
                  className={`h-[3px] w-8 rounded-full transition-colors ${
                    i <= active
                      ? 'bg-[color:var(--blue)]'
                      : 'bg-[color:var(--line-3)] hover:bg-[color:var(--ink-3)]'
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
