'use client'

import { useState } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import ScrollReveal from '@/components/ui/ScrollReveal'

const FAQS = [
  {
    question: 'How does Mine handle data security?',
    answer: 'Mine runs in your environment or a dedicated cloud instance. Data never leaves your VPC. We support SOC 2 compliance requirements and provide full audit trails for every AI-generated mapping and transformation.',
  },
  {
    question: 'What systems does Mine connect to?',
    answer: 'Mine is built for enterprise migrations from Salesforce, SAP, Oracle, NetSuite, and custom databases. We support SQL Server, PostgreSQL, and API-based source extraction.',
  },
  {
    question: 'What if the AI gets a mapping wrong?',
    answer: 'Every AI-proposed mapping includes a confidence score and explanation. Your team reviews and approves before anything executes. Ambiguous mappings are flagged for human review — the AI never acts without visibility.',
  },
  {
    question: 'Is Mine a consulting service?',
    answer: 'No. Mine is a software platform. We replace the manual spreadsheet-and-SQL work that consultants do today with an autonomous, reusable engine. Consultants can use Mine to accelerate their own delivery.',
  },
  {
    question: 'How quickly can we get started?',
    answer: 'Connect your source schema and target model, and Mine profiles your data in minutes. First mapping proposals are generated within an hour. Full migration readiness typically takes days, not months.',
  },
]

export default function FAQ() {
  const [openIndex, setOpenIndex] = useState<number>(0)

  const toggle = (i: number) => setOpenIndex(openIndex === i ? -1 : i)

  return (
    <section id="faq" className="py-24 px-6 lg:px-12">
      <div className="max-w-2xl mx-auto">

        <ScrollReveal>
          <h2 className="text-4xl font-bold text-slate-900 tracking-tight text-center mb-10">
            FAQ
          </h2>
        </ScrollReveal>

        {FAQS.map((faq, i) => (
          <ScrollReveal key={faq.question} delay={i * 0.05}>
            <div className="border-b border-slate-200">
              <button
                onClick={() => toggle(i)}
                className="w-full flex items-center justify-between py-5 text-left group"
              >
                <span className="text-base font-medium text-slate-800 group-hover:text-blue-600 transition-colors pr-4">
                  {faq.question}
                </span>
                <span
                  className="text-slate-400 text-xl shrink-0 transition-transform duration-300"
                  style={{ transform: openIndex === i ? 'rotate(45deg)' : 'rotate(0deg)' }}
                >
                  +
                </span>
              </button>

              <AnimatePresence initial={false}>
                {openIndex === i && (
                  <motion.div
                    initial={{ height: 0, opacity: 0 }}
                    animate={{ height: 'auto', opacity: 1 }}
                    exit={{ height: 0, opacity: 0 }}
                    transition={{ duration: 0.3, ease: [0.22, 1, 0.36, 1] }}
                    style={{ overflow: 'hidden' }}
                  >
                    <p className="text-sm text-slate-500 leading-relaxed pb-5">
                      {faq.answer}
                    </p>
                  </motion.div>
                )}
              </AnimatePresence>
            </div>
          </ScrollReveal>
        ))}

      </div>
    </section>
  )
}
