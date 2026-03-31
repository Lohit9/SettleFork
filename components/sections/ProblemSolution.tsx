'use client'

import ScrollReveal from '@/components/ui/ScrollReveal'

interface ProblemSolutionProps {
  onHowItWorksClick: () => void
}

const PROBLEMS = [
  'Teams spend 40% of migration budgets on manual field mapping alone.',
  'Brittle SQL and ETL jobs break on every schema change.',
  'Late data quality issues push back go-live dates by months.',
]

const SOLUTIONS = [
  'AI agents profile your source schema and infer business context in minutes.',
  'Mine writes mappings, cleansing rules, and ETL — with full explainability.',
  'Validation engine catches target-incompatible data before it hits production.',
]

export default function ProblemSolution({ onHowItWorksClick }: ProblemSolutionProps) {
  return (
    <section className="bg-slate-50 py-20 lg:py-24 px-6 lg:px-12">
      <div className="max-w-7xl mx-auto grid grid-cols-1 lg:grid-cols-2 gap-6">

        {/* Problem card */}
        <ScrollReveal>
          <div className="bg-white rounded-2xl p-10 border border-slate-200 h-full hover:-translate-y-1 hover:shadow-xl transition-all duration-300">
            <p className="text-red-600 text-xs font-semibold uppercase tracking-widest mb-3">
              The Problem
            </p>
            <h2 className="text-2xl font-bold text-slate-900 leading-snug tracking-tight mb-5">
              Data migration slows down every transformation.
            </h2>
            <ul className="space-y-4">
              {PROBLEMS.map((text) => (
                <li key={text} className="flex gap-3">
                  <span className="text-red-500 mt-0.5 shrink-0">•</span>
                  <span className="text-sm text-slate-600 leading-relaxed">{text}</span>
                </li>
              ))}
            </ul>
          </div>
        </ScrollReveal>

        {/* Solution card */}
        <ScrollReveal delay={0.12}>
          <div className="bg-white rounded-2xl p-10 border border-slate-200 border-l-[3px] border-l-teal-600 h-full hover:-translate-y-1 hover:shadow-xl transition-all duration-300">
            <p className="text-teal-600 text-xs font-semibold uppercase tracking-widest mb-3">
              The Solution
            </p>
            <h2 className="text-2xl font-bold text-slate-900 leading-snug tracking-tight mb-5">
              Turn migration into an autonomous workflow.
            </h2>
            <ul className="space-y-4 mb-6">
              {SOLUTIONS.map((text) => (
                <li key={text} className="flex gap-3">
                  <span className="text-teal-600 mt-0.5 shrink-0 font-bold">✓</span>
                  <span className="text-sm text-slate-600 leading-relaxed">{text}</span>
                </li>
              ))}
            </ul>
            <button
              onClick={onHowItWorksClick}
              className="text-teal-600 hover:text-slate-900 font-medium text-sm transition-colors"
            >
              See how it works →
            </button>
          </div>
        </ScrollReveal>

      </div>
    </section>
  )
}
