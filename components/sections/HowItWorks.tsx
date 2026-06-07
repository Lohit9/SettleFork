'use client'

import { useState } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
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
  transition: { duration: 0.3 },
}

export default function HowItWorks() {
  const [active, setActive] = useState(0)
  const stage = STAGES[active]

  const bodies = [
    <IngestStage key="ingest" onAdvance={() => setActive(1)} />,
    <GenerateStage key="generate" onAdvance={() => setActive(2)} />,
    <ValidateStage key="validate" onAdvance={() => setActive(3)} />,
    <ExportStage key="export" />,
  ]

  return (
    <section id="how" className="relative bg-[color:var(--bg)] py-24 px-6">
      <div className="mx-auto max-w-3xl">

        <ScrollReveal>
          <h2 className="h2 text-center mb-10">Watch a migration run, end to end.</h2>
        </ScrollReveal>

        <ScrollReveal delay={0.1}>
          {/* Per-stage eyebrow + heading + sub */}
          <div className="text-center min-h-[150px]">
            <AnimatePresence mode="wait">
              <motion.div key={`head-${active}`} {...STAGE_TRANSITION}>
                <p className="mono text-xs font-semibold tracking-[0.15em] text-[color:var(--blue)] mb-3">
                  STEP {String(active + 1).padStart(2, '0')} / 04
                </p>
                <h3 className="text-2xl sm:text-[28px] font-semibold tracking-tight text-[color:var(--ink)] mb-2.5">
                  {stage.heading}
                </h3>
                <p className="lede mx-auto max-w-xl">{stage.sub}</p>
              </motion.div>
            </AnimatePresence>
          </div>

          {/* Browser-chrome mockup */}
          <div className="card overflow-hidden mt-2">
            {/* Window chrome + URL bar */}
            <div className="flex items-center gap-3 border-b border-[color:var(--line)] px-4 py-3">
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
            <div className="flex items-center gap-2 sm:gap-3 overflow-x-auto border-b border-[color:var(--line)] px-4 py-3">
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
                      onClick={() => setActive(i)}
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

            {/* Active stage body */}
            <div className="p-5 sm:p-6 min-h-[360px]">
              <AnimatePresence mode="wait">
                <motion.div key={`body-${active}`} {...STAGE_TRANSITION}>
                  {bodies[active]}
                </motion.div>
              </AnimatePresence>
            </div>
          </div>
        </ScrollReveal>

        {/* Pagination dots */}
        <ScrollReveal delay={0.15}>
          <div className="mt-8 flex items-center justify-center gap-2.5">
            {STAGES.map((s, i) => (
              <button
                key={s.label}
                type="button"
                onClick={() => setActive(i)}
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

          <p className="mt-5 text-center text-sm text-[color:var(--ink-3)]">
            From profiling to a production-ready package in days, not months.
          </p>
        </ScrollReveal>

      </div>
    </section>
  )
}
