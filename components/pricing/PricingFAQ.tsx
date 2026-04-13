'use client'

import { useState } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import ScrollReveal from '@/components/ui/ScrollReveal'

const FAQS = [
  {
    question: 'How is pricing determined?',
    answer:
      'Pricing is based on migration complexity: the number of data tables, source systems, and transformation depth. Every engagement starts with a free 30-minute scoping call to confirm scope and pricing.',
  },
  {
    question: "What's included?",
    answer:
      'Every migration includes full platform access, a guided setup session for your first migration, and complete delivery — mapping files, transformation SQL, validation reports, and production-ready load packages.',
  },
  {
    question: 'What happens after my first migration?',
    answer:
      'Customers with recurring migration needs can discuss platform licensing for ongoing access. Repeat migrations are priced using the same complexity model.',
  },
  {
    question: 'Do you offer a free trial?',
    answer:
      'We offer a free 30-minute scoping call where we assess your migration and walk through the platform. Your first migration includes guided setup so your team is self-sufficient going forward.',
  },
  {
    question: 'What if my migration is larger than 500 tables?',
    answer:
      "Enterprise migrations require a custom assessment. Book a scoping call and we'll provide a detailed proposal within 48 hours.",
  },
]

export default function PricingFAQ() {
  const [openIndex, setOpenIndex] = useState<number>(-1)

  const toggle = (i: number) => setOpenIndex(openIndex === i ? -1 : i)

  return (
    <div>
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
                  <p className="text-[15px] text-[#64748B] leading-relaxed pb-5">{faq.answer}</p>
                </motion.div>
              )}
            </AnimatePresence>
          </div>
        </ScrollReveal>
      ))}
    </div>
  )
}
