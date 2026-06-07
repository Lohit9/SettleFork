'use client'

import { useState } from 'react'
import { AnimatePresence, motion } from 'framer-motion'

const FAQS: { q: string; a: React.ReactNode }[] = [
  {
    q: 'Does the AI write directly to my production database?',
    a: (
      <>
        No. The model only <b>proposes</b> mappings and transforms. Deterministic engines validate every
        row, and <b>nothing loads until your team approves</b> the export. Settle holds no standing write
        access to your target.
      </>
    ),
  },
  {
    q: 'How does Settle handle data security?',
    a: 'Data is encrypted in transit and at rest. AI processing runs on Anthropic Enterprise LLMs, and your data is never used to train any model. Every profile, mapping, validation, and approval is versioned and logged. SOC 2 is kicking off soon and a pen test is in progress; full security documentation is available under NDA.',
  },
  {
    q: 'What sources and targets does Settle support?',
    a: "Settle works across common enterprise systems — ERPs, CRMs, HRIS, Legal-tech, and databases — plus flat-file exports like CSV and DDL when a direct connection isn't possible. The migrations catalog lists 100+ supported paths, and because mappings are packaged and re-runnable, new paths are added quickly. If your pair isn't listed, ask — many engagements start from exactly that conversation.",
  },
  {
    q: 'What happens to rows that fail validation?',
    a: "They're blocked, not silently loaded. Every failed row is flagged with the rule it broke and the AI's proposed fix, and your team resolves or accepts each flag in review. Nothing reaches the target until flags are cleared and the load is approved — which is why errors at cutover are zero by design.",
  },
  {
    q: 'Can we run Settle in our own environment?',
    a: "Settle runs as a managed deployment hosted on AWS today, with data encrypted in transit and at rest and not retained beyond the migration. Settle can be deployed in your own private cloud on demand; VPC deployment is on our enterprise roadmap — talk to us if it's a requirement.",
  },
  {
    q: 'How is this different from a custom ETL script or a systems integrator?',
    a: "Three differences: speed, accuracy, and reuse. Scripts and integrator engagements are one-off work — weeks of mapping locked in code you can't easily audit or re-run, verified by spot checks. Settle is faster because the AI proposes the mappings up front, more accurate because deterministic engines validate every row against your rules, and reusable because the whole migration ships as a versioned, explainable, re-runnable package. The rigor of an SI engagement at software speed — and the audit trail stays yours.",
  },
  {
    q: 'How long does a migration actually take?',
    a: "It depends on volume, sources, and schema complexity, which is why every migration is scoped individually. The pattern is consistent though: profiling to a production-ready package in days to weeks rather than months, because the AI proposes the mappings up front and your team's time goes to review and approval instead of authoring. Ask for an estimate and we'll scope yours.",
  },
]

export default function FAQ() {
  const [open, setOpen] = useState(0)

  return (
    <section id="faq" className="faq-section section">
      <div className="wrap">
        <div className="sec-head mx-auto max-w-[720px] text-center">
          <div className="kicker">Questions</div>
          <h2 className="h2 mt-[14px]">Straight answers to the hard questions.</h2>
        </div>

        <div className="mx-auto mt-12 max-w-[820px] border-t border-[color:var(--line)]">
          {FAQS.map((faq, i) => {
            const isOpen = open === i
            return (
              <div key={faq.q} className="border-b border-[color:var(--line)]">
                <button
                  type="button"
                  onClick={() => setOpen(isOpen ? -1 : i)}
                  aria-expanded={isOpen}
                  className="flex w-full items-center gap-[18px] px-1 py-[22px] text-left text-[16.5px] font-[550] tracking-[-0.01em] text-[color:var(--ink)]"
                >
                  <span>{faq.q}</span>
                  <span
                    aria-hidden="true"
                    className={`ml-auto flex h-[22px] w-[22px] shrink-0 items-center justify-center transition-transform duration-300 ${
                      isOpen ? 'rotate-45 text-[color:var(--blue)]' : 'text-[color:var(--ink-3)]'
                    }`}
                  >
                    <svg viewBox="0 0 22 22" fill="none" className="h-full w-full">
                      <path d="M11 5v12M5 11h12" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
                    </svg>
                  </span>
                </button>
                <AnimatePresence initial={false}>
                  {isOpen && (
                    <motion.div
                      initial={{ height: 0, opacity: 0 }}
                      animate={{ height: 'auto', opacity: 1 }}
                      exit={{ height: 0, opacity: 0 }}
                      transition={{ duration: 0.3, ease: [0.3, 0.8, 0.4, 1] }}
                      style={{ overflow: 'hidden' }}
                    >
                      <div className="pb-6 pl-[42px] pr-1 text-[14.5px] leading-[1.65] text-[color:var(--ink-2)] [&_b]:font-semibold [&_b]:text-[color:var(--ink)]">
                        {faq.a}
                      </div>
                    </motion.div>
                  )}
                </AnimatePresence>
              </div>
            )
          })}
        </div>
      </div>
    </section>
  )
}
