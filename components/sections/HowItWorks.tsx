'use client'

import { useState } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import ScrollReveal from '@/components/ui/ScrollReveal'
import SchemaTable from './how-it-works/SchemaTable'
import MappingTable from './how-it-works/MappingTable'
import ValidationDashboard from './how-it-works/ValidationDashboard'

const TABS = [
  { fullLabel: '1. Schema understanding', shortLabel: '1. Schema'    },
  { fullLabel: '2. Auto-mapping',         shortLabel: '2. Mapping'   },
  { fullLabel: '3. Validation & readiness', shortLabel: '3. Validation' },
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
          <h2 className="text-4xl font-bold text-[#0F172A] tracking-tight text-center mb-3">
            See Settle work end-to-end
          </h2>
          <p className="text-[#64748B] text-[17px] text-center max-w-xl mx-auto mb-12">
            One Casella migration. 240 tables. 3,412 fields. Watch the autonomous workflow from profiling to production-ready load files.
          </p>
        </ScrollReveal>

        {/* Tab bar */}
        <ScrollReveal delay={0.1}>
          <div className="flex justify-center border-b border-[#E2E8F0] gap-0 mb-0">
            {TABS.map((tab, i) => (
              <button
                key={tab.fullLabel}
                onClick={() => setActiveTab(i)}
                className={`px-4 py-3 text-sm font-medium border-b-2 transition-all whitespace-nowrap cursor-pointer bg-transparent ${
                  activeTab === i
                    ? 'text-[#2358D4] border-[#2358D4]'
                    : 'text-[#64748B] border-transparent hover:text-[#334155]'
                }`}
              >
                <span className="hidden md:inline">{tab.fullLabel}</span>
                <span className="md:hidden">{tab.shortLabel}</span>
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
          <div className="mt-8 max-w-4xl mx-auto px-6 py-4 bg-[#ECFDF5] rounded-xl border border-teal-200 flex items-center justify-center gap-3">
            <span className="text-xs font-semibold uppercase tracking-wider text-[#0D9488] shrink-0 whitespace-nowrap">
              Result
            </span>
            <span className="text-[#115E59] text-[15px] font-medium">
              Migrations in weeks, not months — 40–50% lower cost, dramatically reduced risk.
            </span>
          </div>
        </ScrollReveal>

      </div>
    </section>
  )
}
