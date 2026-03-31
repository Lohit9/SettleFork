'use client'

import { useState } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import ScrollReveal from '@/components/ui/ScrollReveal'
import SchemaTable from './how-it-works/SchemaTable'
import MappingTable from './how-it-works/MappingTable'
import ValidationDashboard from './how-it-works/ValidationDashboard'

const TABS = [
  '1. Schema understanding',
  '2. Auto-mapping',
  '3. Validation & readiness',
]

const TAB_CONTENT = [
  <SchemaTable key="schema" />,
  <MappingTable key="mapping" />,
  <ValidationDashboard key="validation" />,
]

export default function HowItWorks() {
  const [activeTab, setActiveTab] = useState(0)

  return (
    <section id="how" className="py-24 px-6 lg:px-12">
      <div className="max-w-7xl mx-auto">

        {/* Header */}
        <ScrollReveal>
          <h2 className="text-4xl font-bold text-slate-900 tracking-tight text-center mb-3">
            See Mine work end-to-end
          </h2>
          <p className="text-slate-500 text-base text-center max-w-xl mx-auto mb-12">
            One Casella migration. 240 tables. 3,412 fields. Watch the autonomous workflow from profiling to production-ready load files.
          </p>
        </ScrollReveal>

        {/* Tab bar */}
        <ScrollReveal delay={0.1}>
          <div className="flex justify-center border-b border-slate-200 overflow-x-auto gap-0 mb-0">
            {TABS.map((tab, i) => (
              <button
                key={tab}
                onClick={() => setActiveTab(i)}
                className={`px-4 py-3 text-sm font-medium border-b-2 transition-all whitespace-nowrap cursor-pointer bg-transparent ${
                  activeTab === i
                    ? 'text-blue-600 border-blue-600'
                    : 'text-slate-500 border-transparent hover:text-slate-700'
                }`}
              >
                {tab}
              </button>
            ))}
          </div>
        </ScrollReveal>

        {/* Tab content */}
        <ScrollReveal delay={0.15}>
          <div className="mt-6">
            <AnimatePresence mode="wait">
              <motion.div
                key={activeTab}
                initial={{ opacity: 0, y: 8 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -8 }}
                transition={{ duration: 0.3 }}
              >
                {TAB_CONTENT[activeTab]}
              </motion.div>
            </AnimatePresence>
          </div>
        </ScrollReveal>

        {/* Result callout */}
        <ScrollReveal delay={0.2}>
          <div className="mt-10 p-5 bg-emerald-50 rounded-xl border border-teal-200 flex items-center gap-3">
            <span className="text-teal-600 font-bold text-sm shrink-0">Result:</span>
            <span className="text-teal-800 text-sm">
              migrations in weeks, not months — with 40–50% lower cost and dramatically reduced risk.
            </span>
          </div>
        </ScrollReveal>

      </div>
    </section>
  )
}
