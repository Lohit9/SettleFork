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
    <section
      id="how"
      className="relative"
      style={{
        background:
          'linear-gradient(180deg, var(--bg) 0%, var(--surface-2) 16%, var(--surface-2) 84%, var(--bg) 100%)',
      }}
    >
      {/* Intro heading — normal flow, seen before the pinned track */}
      <div className="mx-auto max-w-[660px] px-5 pt-[90px] pb-2 text-center">
        <ScrollReveal>
          <h2
            className="font-semibold tracking-[-0.025em] leading-[1.05] text-[color:var(--ink)]"
            style={{ fontSize: 'clamp(30px, 3.6vw, 44px)' }}
          >
            Watch a migration run, end to end.
          </h2>
        </ScrollReveal>
      </div>

      {/* Scroll track — ~one viewport per stage */}
      <div ref={trackRef} className="relative h-[400vh]">
        {/* Pinned unit — below the 64px sticky header, flex column, centered */}
        <div
          className="sticky top-16 flex flex-col items-center justify-center overflow-hidden gap-[clamp(12px,1.9vh,20px)] px-5"
          style={{ height: 'calc(100vh - 4rem)', paddingTop: 14, paddingBottom: 18 }}
        >
          {/* walk-head: fixed 128px box, content bottom-aligned */}
          <div className="flex h-[128px] max-md:h-[96px] max-w-[660px] shrink-0 flex-col items-center justify-end text-center">
            <AnimatePresence mode="wait">
              <motion.div
                key={`head-${active}`}
                {...STAGE_TRANSITION}
                className="flex flex-col items-center gap-2 max-md:gap-1"
              >
                <p className="mono uppercase font-semibold tracking-[0.15em] text-[11px] text-[color:var(--blue)]">
                  STEP {String(active + 1).padStart(2, '0')} / 04
                </p>
                <h3
                  className="font-semibold tracking-[-0.018em] leading-[1.1] text-[color:var(--ink)]"
                  style={{ fontSize: 'clamp(19px, 2.1vw, 24px)' }}
                >
                  {stage.heading}
                </h3>
                <p className="mx-auto max-w-[640px] text-[13.5px] leading-[1.45] text-[color:var(--ink-2)]">
                  {stage.sub}
                </p>
              </motion.div>
            </AnimatePresence>
          </div>

          {/* console */}
          <div
            className="shrink-0 overflow-hidden border border-[color:var(--line)] bg-[color:var(--surface)]"
            style={{ width: 'min(1060px, 95vw)', borderRadius: 16, boxShadow: 'var(--sh-lg)' }}
          >
            {/* chrome bar: neutral dots at left, centered URL pill */}
            <div className="flex h-[44px] items-center gap-2 border-b border-[color:var(--line)] bg-[color:var(--surface-2)] px-4">
              <span className="h-[11px] w-[11px] rounded-full bg-[color:var(--line-3)]" />
              <span className="h-[11px] w-[11px] rounded-full bg-[color:var(--line-3)]" />
              <span className="h-[11px] w-[11px] rounded-full bg-[color:var(--line-3)]" />
              <span className="mono mx-auto flex items-center gap-2 rounded-[7px] border border-[color:var(--line)] bg-[color:var(--bg)] px-4 py-[5px] text-[12px] text-[color:var(--ink-2)]">
                <svg
                  width="11"
                  height="11"
                  viewBox="0 0 12 12"
                  fill="none"
                  className="opacity-[0.65]"
                  aria-hidden="true"
                >
                  <rect x="2.5" y="5" width="7" height="5" rx="1" stroke="currentColor" strokeWidth="1.1" />
                  <path d="M4 5V3.6a2 2 0 0 1 4 0V5" stroke="currentColor" strokeWidth="1.1" />
                </svg>
                <span className="truncate">settledata.ai/app/migrations/erp-to-erp</span>
              </span>
            </div>

            {/* tab bar / stepper */}
            <div className="flex border-b border-[color:var(--line)] bg-[color:var(--surface)]">
              {STAGES.map((s, i) => {
                const done = i < active
                const isActive = i === active
                return (
                  <button
                    key={s.label}
                    type="button"
                    onClick={() => goToStage(i)}
                    aria-current={isActive ? 'step' : undefined}
                    className={`relative flex min-w-0 flex-1 items-center gap-2.5 px-[15px] py-[13px] text-left transition-colors hover:bg-[color:var(--surface-2)] ${
                      i > 0 ? 'border-l border-[color:var(--line-2)]' : ''
                    }`}
                  >
                    <span
                      className={`mono flex h-[25px] w-[25px] shrink-0 items-center justify-center rounded-full text-[11px] font-semibold transition-all ${
                        isActive
                          ? 'border border-[color:var(--blue)] bg-[color:var(--blue)] text-white'
                          : done
                            ? 'border border-[color:var(--green)] bg-[color:var(--green)] text-white'
                            : 'border border-[color:var(--line)] bg-[color:var(--surface-2)] text-[color:var(--ink-3)]'
                      }`}
                      style={isActive ? { boxShadow: '0 0 0 4px var(--blue-tint)' } : undefined}
                    >
                      {String(i + 1).padStart(2, '0')}
                    </span>
                    <span
                      className={`truncate text-[13px] leading-[1.2] tracking-[-0.012em] font-[550] ${
                        isActive
                          ? 'text-[color:var(--ink)]'
                          : done
                            ? 'text-[color:var(--ink-2)]'
                            : 'text-[color:var(--ink-3)]'
                      }`}
                    >
                      {s.label}
                    </span>
                    {isActive && (
                      <span className="absolute inset-x-0 bottom-[-1px] h-[2px] bg-[color:var(--blue)]" />
                    )}
                  </button>
                )
              })}
            </div>

            {/* con-body — capped height; the active view fills it, overflow clips */}
            <div
              className="relative overflow-hidden max-md:overflow-y-auto"
              style={{ height: 'clamp(334px, calc(100vh - 4rem - 320px), 460px)' }}
            >
              <AnimatePresence mode="wait">
                <motion.div key={`body-${active}`} {...STAGE_TRANSITION} className="absolute inset-0">
                  {bodies[active]}
                </motion.div>
              </AnimatePresence>
            </div>
          </div>

          {/* rail — progress bar segments (completed + active filled) */}
          <div className="flex shrink-0 items-center gap-2">
            {STAGES.map((s, i) => (
              <button
                key={s.label}
                type="button"
                onClick={() => goToStage(i)}
                aria-label={`Go to ${s.label} step`}
                aria-current={i === active ? 'step' : undefined}
                className={`h-[4px] w-[42px] rounded-[2px] transition-colors ${
                  i <= active
                    ? 'bg-[color:var(--blue)]'
                    : 'bg-[color:var(--line-3)] hover:bg-[color:var(--ink-3)]'
                }`}
              />
            ))}
          </div>

          {/* note */}
          <div className="shrink-0 text-center text-[13.5px] font-medium tracking-[-0.01em] text-[color:var(--ink-2)]">
            From profiling to a production-ready package in days, not months.
          </div>
        </div>
      </div>
    </section>
  )
}
