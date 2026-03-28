'use client'

import { useState } from 'react'
import { motion, AnimatePresence } from 'framer-motion'

export interface FAQ {
  question: string
  answer: string
}

interface FAQSectionProps {
  faqs: FAQ[]
}

export default function FAQSection({ faqs }: FAQSectionProps) {
  const [openIndex, setOpenIndex] = useState<number>(0)

  return (
    <div className="divide-y divide-mine-slate-200">
      {faqs.map((faq, i) => {
        const isOpen = openIndex === i
        return (
          <div key={i}>
            <button
              onClick={() => setOpenIndex(isOpen ? -1 : i)}
              className="w-full flex items-center justify-between py-5 text-left gap-4 group"
            >
              <span className="text-base font-medium text-mine-slate-900 group-hover:text-mine-blue-600 transition-colors">
                {faq.question}
              </span>
              <span
                className={`shrink-0 w-5 h-5 flex items-center justify-center rounded-full border transition-all duration-200 ${
                  isOpen
                    ? 'bg-mine-blue-600 border-mine-blue-600 text-white'
                    : 'border-mine-slate-300 text-mine-slate-400 group-hover:border-mine-blue-400'
                }`}
              >
                <svg
                  className={`w-3 h-3 transition-transform duration-300 ${isOpen ? 'rotate-180' : ''}`}
                  fill="none"
                  viewBox="0 0 24 24"
                  stroke="currentColor"
                  strokeWidth={2.5}
                >
                  <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
                </svg>
              </span>
            </button>

            <AnimatePresence initial={false}>
              {isOpen && (
                <motion.div
                  key="answer"
                  initial={{ height: 0, opacity: 0 }}
                  animate={{ height: 'auto', opacity: 1 }}
                  exit={{ height: 0, opacity: 0 }}
                  transition={{ duration: 0.28, ease: [0.22, 1, 0.36, 1] }}
                  style={{ overflow: 'hidden' }}
                >
                  <p className="pb-5 text-mine-slate-500 leading-relaxed text-sm">
                    {faq.answer}
                  </p>
                </motion.div>
              )}
            </AnimatePresence>
          </div>
        )
      })}
    </div>
  )
}
