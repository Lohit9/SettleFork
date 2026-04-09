'use client'

import { useState } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import ScrollReveal from '@/components/ui/ScrollReveal'

const FAQS = [
  {
    question: 'How does Settle handle data security?',
    answer: 'Settle is hosted on AWS with AES-256-GCM encryption at rest and in transit. All AI processing uses Anthropic Enterprise LLMs — your data is never used for model training. Every field mapping and transformation carries a full audit trail. SOC 2 Type 2 certification is in progress.',
  },
  {
    question: 'What systems does Settle connect to?',
    answer: 'Settle is built for enterprise migrations from Salesforce, SAP, Oracle, NetSuite, and custom databases. We support SQL Server, PostgreSQL, and API-based source extraction.',
  },
  {
    question: 'What if the AI gets a mapping wrong?',
    answer: 'Every AI-proposed mapping includes a confidence score and explanation. Your team reviews and approves before anything executes. Ambiguous mappings are flagged for human review — the AI never acts without visibility.',
  },
  {
    question: 'Is Settle a consulting service?',
    answer: 'No. Settle is a software platform. We replace the manual spreadsheet-and-SQL work that consultants do today with an autonomous, reusable engine. Consultants can use Settle to accelerate their own delivery.',
  },
  {
    question: 'How quickly can we get started?',
    answer: 'First mapping proposals are generated within one hour of connecting your schema. Settle profiles your source data in minutes, and full migration readiness packages are typically delivered in days, not months.',
  },
]

export default function FAQ() {
  const [openIndex, setOpenIndex] = useState<number>(0)

  const toggle = (i: number) => setOpenIndex(openIndex === i ? -1 : i)

  return (
    <section id="faq" className="faq-section py-16 px-6 lg:px-12">
      <div className="max-w-2xl mx-auto">

        <ScrollReveal>
          <h2 className="text-4xl font-bold text-[#0F172A] tracking-tight text-center mb-6">
            FAQ
          </h2>
        </ScrollReveal>

        {FAQS.map((faq, i) => (
          <ScrollReveal key={faq.question} delay={i * 0.05}>
            <div className="border-b border-[#E2E8F0]">
              <button
                onClick={() => toggle(i)}
                className="w-full flex items-center justify-between py-5 text-left group"
              >
                <span className="text-base font-medium text-[#1E3A5F] group-hover:text-[#2358D4] transition-colors pr-4">
                  {faq.question}
                </span>
                <span
                  className="text-[#94A3B8] text-xl shrink-0 transition-transform duration-300"
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
                    <p className="text-[15px] text-[#64748B] leading-relaxed pb-5">
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
